# APK Make UI — contract inventory and implementation plan

Status: **plan only**. Design gate is GO with conditions S1–S4 (`agent-board-apk-make-sol`). This document is the contract for the next implementation waves. It does not change Compose, settings, or turn behavior.

Baseline: `origin/main` @ `269d0ab` (Read-only archive list, pair-code UX, and Chinese-first phone UI). The Make file (`https://www.figma.com/make/ssfg5nJZrLYcI7ROf58E9C`) and the local prototype are illustrative. Schemas below are taken from the board, the embedded dialer (`src/relay/`), the public relay (`relay/`), and the phone protocol (`android/protocol/`). Do not invent fields from prototype sample data.

Protocol version stays **`v: 1`**. New work is additive commands plus `board.register` capabilities. An old phone keeps working. A new phone that does not see the capability it needs shows the existing unsupported copy and does not toast 已保存.

Production path is the board process on the ThinkBook (embedded dialer in `src/relay/`). The public relay on UCloud 101 is `relay/`. `connector/` is the standalone dialer and must stay in lockstep with `src/relay/` in the same change, even though the ThinkBook does not launch it. Do not restart or sync the ThinkBook while a board task is running. Sync only when the board is idle.

## Decisions locked here

These close the gate conditions. No further product choice is required before implementation.

1. **继续** opens a composer. The phone always sends a non-blank `prompt`. It never omits `prompt`, because an omitted or blank `prompt` makes the board store `请基于当前上下文继续完成任务`.
2. **已完成** is the terminal bucket `succeeded` + `failed` + `stopped`, with badges 成功 / 失败 / 已停止. **归档** is a separate chip. **进行中** is `running` + `paused` (board `blocked`), badge 进行中 or 等待确认. **待办** is relay `queued`, which is board `draft` or `queued`, badge 待办. Workspace selection and the status chip are independent.
3. Archived tasks are readable and not writable from the phone. `continueTask`, `stopTask`, and `startTask` reject `archived` in the board service. The web restore path (`POST /api/tasks/:id/move` with `lane: "done"`) stays web-only and is not sent by the phone.
4. Workspace settings and board settings load and save the real HTTP documents. There is no default-model field and no single global-proxy field in `GET /api/settings`. Those Make rows are omitted, with one line of explanation, not a fake editor.
5. Turns are persisted `prompts[]` + `outputs[]` joined by `iteration`. Tool chips come only from real `sideJobs`. Logs are a separate section. The phone does not add turn pagination in this wave; it labels a partial list honestly.
6. `systemPrompt` is a first-run prompt prefix (`[工作区指令]`), not a system role. `mcp` is explanatory text injected into that prefix, not a live MCP server config.

## 1. Board routes and handlers

HTTP lives in `src/server.ts`. Task mutations live in `src/manager.ts`. Persistence is `tasks`, `task_prompts`, `task_outputs`, `task_side_jobs`, `task_logs`, `workspaces`, and `meta` (`src/store.ts`). List and SSE payloads clip long text at 2,000 characters (`presentBoardTask`). `GET /api/tasks/:id` returns the full task and does not embed the log body.

| Concern | Route | Behavior today | Phone gap |
| --- | --- | --- | --- |
| Workspace list | `GET /api/workspaces` | `{ workspaces, defaultWorkspaceId }`. Each workspace is `id`, `name`, `path`, `createdAt`, `updatedAt`, optional `settings`. | Snapshot workspaces are only `{ id, name, path, isGit }`. Settings are not on the wire. |
| Workspace create | `POST /api/workspaces` | `name` (1–200) and absolute existing `path` under allowed roots. Id is `nanoid(10)`. No settings on create. | `cmd.workspace.create` already matches this. |
| Workspace read | `GET /api/workspaces/:id` | `{ workspace, defaultWorkspaceId }`. 404 if missing. | No relay read. |
| Workspace update | `PATCH /api/workspaces/:id` | Name, path, and **replacement** `settings` when the key is present. Omitted `settings` keeps the stored object. | No relay update. Create explicitly refuses settings (`src/relay/facade.ts`). |
| Workspace delete | `DELETE /api/workspaces/:id` | Rejects the default workspace and any workspace that still has tasks, **including archived tasks**. | `cmd.workspace.delete` already matches this. |
| Git status | `GET /api/workspaces/:id/git-status` | Read-only. Path comes from the stored workspace. Optional `?refresh=1`. Shape is `GitWorkspaceStatus` (`root`, `repos[]`, caps, `truncated`). | Not on the phone. Settings screen needs a summary, not the file list. |
| Worktree eligibility | `GET /api/workspaces/:id/git-worktree-eligibility` | Same bit as snapshot `isGit`. | Already on the thin workspace. Do not treat `isGit` as dirty/clean. |
| Board settings read | `GET /api/settings` | `cliPaths`, `proxyEnv`, `quickPrompts`, `codexSandbox`. | No relay read. The phone Settings screen is the **relay URL**, not this document. |
| Board settings write | `PUT /api/settings` | Partial: any of `cliPaths`, `proxyEnv`, `quickPrompts`, `codexSandbox`. `clear: true` resets CLI paths, proxies, and sandbox to defaults and **keeps** quick prompts. Lock via `withSettingsLock`. | No relay write. Phone must not send `clear: true`. |
| Settings HTML | `GET /settings`, `GET /workspaces/:id/settings` | Pages only. Data is the JSON routes above. | Ignore the HTML. |
| Task list | `GET /api/tasks?workspaceId=` | Full in-memory tasks, optionally filtered. Includes archived. | Hot snapshot **omits** archived. Archive is `cmd.archive.list`. |
| Task detail | `GET /api/tasks/:id` | `{ task, log: [], logLineCount }`. Task includes `prompts`, `outputs`, `sideJobs`, `iteration`, `prompt`, `output`, `error`, `worktree`. May backfill turns from the log tail once, then persist them. | `cmd.detail` already returns a full card, including archived (`mapBoardTask(task, true)`). Turns are clipped (see §3). |
| Log tail | `GET /api/tasks/:id/log?lines=` | 50–2,000 lines. Separate from the reply. | `sub.logs` is the live tail only. Archived tasks have their logs deleted (below). |
| Create | `POST /api/tasks` | `kind`, `prompt` (required, ≤ 100,000), optional `title` / `model` / `attachments` / `workspaceId` / `cwd` / `useGitWorktree` / `start`. | `cmd.create` **requires** `title`, `prompt`, `agent`, and `cwd`. It always `createAndStart` (not a draft). Optional `workspaceId` and strict boolean `useGitWorktree`. |
| Start draft | `POST /api/tasks/:id/start` | Rejects `queued`, `running`, and `blocked`. Resets iteration to 1 and clears outputs. | No phone command. Do not add one in this wave. |
| Move / archive | `POST /api/tasks/:id/move` `{ lane }` | `draft` \| `todo` \| `running` \| `done` \| `archived`. Archive stops an active process, stores `lastEvent: "archive:<prior>"` where prior is `succeeded`, `failed`, or `stopped`, and **deletes `task_logs`**. Prompts and outputs stay. `lane: "done"` from archived restores that prior status. | No phone archive command. Hot list drops the card. `cmd.archive.list` is read-only. |
| Stop | `POST /api/tasks/:id/stop` | Sets `stopped` for **any** current status, including archived. | `cmd.stop` forwards this. Must reject archived before the phone shows 停止. |
| Continue | `POST /api/tasks/:id/continue` | Optional `prompt`. Blank or omitted becomes `请基于当前上下文继续完成任务`. Rejects `draft`, `queued`, and `running`. **Accepts `archived`, `blocked`, and terminal statuses.** Increments `iteration`, appends `prompts[]`, clears the latest `output` until the new run writes one, keeps older `outputs[]`. | `cmd.continue` optional `prompt`, max **20,000** (tighter than HTTP 100,000). Blank is treated as omitted. |
| Batch delete | `POST /api/tasks/batch-delete` | Skips `queued` / `running`. | Stays on the web. |
| SSE | `GET /api/events` | `hello` with tasks and workspaces, then upserts. | Phone uses relay snapshots, not this socket. |

Workspace settings normalization (`normalizeWorkspaceSettings`):

| Field | Type | Empty value | Limit | Meaning |
| --- | --- | --- | --- | --- |
| `systemPrompt` | string | omit key (clears) | 100,000 | Prefixed as `[工作区指令]` on first run and on continue **without** `sessionId`. |
| `skills` | string array, or a newline string on input | omit key | 2,000 per entry | Prefixed as `[工作区 Skills]`. Not a skill installer. |
| `mcp` | string | omit key | 100,000 | Prefixed as `[工作区 MCP]` explanatory text. Not live MCP config. |

`PATCH` with a `settings` object **replaces** the stored object. A body that sends only `systemPrompt` drops `skills` and `mcp`. The phone must submit all three every save. There is no revision token. Last successful write wins. `updatedAt` changes even when the visible text does not.

Path rules (`resolveAllowedDirectory`): absolute, existing directory, symlink-resolved, inside the home directory, the temp directory, or `AGENT_BOARD_ALLOWED_ROOTS`. A path change updates the workspace row only. **Existing tasks keep `task.cwd`.** Later creates in that workspace use the new path. The save UI must say that before enabling 保存.

`isGit` on the phone workspace is worktree eligibility, computed at snapshot time. It is not part of `PATCH`.

Board settings document (`fullSettings()`):

| Group | Keys | Notes |
| --- | --- | --- |
| `cliPaths` | `pi`, `claude`, `agent`, `devin`, `codex` | `agent` is the Cursor CLI binary, not task kind `cursor`. Each value is `{ default, override, effective, resolved, label }`. Empty override clears to PATH. PUT sends override strings, not the resolved object. |
| `proxyEnv` | same kinds × `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` | GET redacts URL userinfo to `***` and sets `hasCredential`. PUT of a `://user:***@host` value **keeps** the stored secret (`isRedactedProxyPlaceholder`). Empty string clears it. Inherited process env is not a stored board field. |
| `quickPrompts` | array, max 50 | `{ id, label, content }`. Label ≤ 40, id ≤ 32, content ≤ 100,000. PUT replaces the whole list. Blank label or content is dropped. This is the shortcut list for create and continue. |
| `codexSandbox` | boolean | Default `true` (`--approve-for-me`). `false` is `-s danger-full-access`. Applies to new runs and to continue without a session. Resume keeps the session policy. |

Not in this document: a board-level default model (`resolveDefaultModel` reads each CLI's home config), a single global proxy, attachments, and uploads. Do not add them to the phone settings form.

Task turn storage:

| Piece | Where | Identity |
| --- | --- | --- |
| Initial prompt | `task.prompt` and `prompts[{ iteration: 1 }]` | Iteration **1** is the create prompt. |
| Continuation prompt | `prompts[]` | Iteration increments by 1 on each successful continue. This is one user submission, not one tool call and not one model step. |
| Reply | `outputs[{ iteration, text, at }]` and `task.output` (latest text) | Joined to the prompt with the same `iteration`. Missing output is "no reply yet", not a log line. |
| Tools | `sideJobs[]` | Task-level `{ id, kind, title, status, summary?, toolName? }`. Not keyed by iteration. |
| Failure | `task.error`, `exitCode` | Not a synthetic reply. |
| Raw log | `task_logs` | Live tail only. **Cleared when the task is archived.** Never copied into `output`. |

`iteration` on the task is the latest user round. Holes are real: a prompt can exist without an output and the reverse. Do not invent the missing numbers.

## 2. Relay dialect and phone gaps

Envelope: `{ v: 1, id, type, ts, payload }`. Commands use `idempotencyKey` (8–80 visible ASCII), scoped to board and command type. Stages: `accepted`, `executed`, `failed`, `timeout`, `unknown`. Pre-store `err` codes (`board_offline`, `forbidden`, `unauthorized`, `bad_request`, `rate_limited`) do not consume the key.

### Commands that already exist

| Command | Who | Result | APK today (`269d0ab`) |
| --- | --- | --- | --- |
| `board.register` | board | `capabilities: ["archive.list"]` | Phone reads capabilities from `board.list`. |
| `client.hello`, `board.list`, `sub.tasks`, `sub.logs`, `cmd.lookup` | phone | session | Pairing and Chinese copy are shipped. |
| `cmd.create` | phone | full task on `executed` | Create screen exists. Title required. Worktree checkbox defaults off. English/Chinese via `values` / `values-zh`. No shortcut chips. |
| `cmd.continue` | phone | full task | Detail has an always-visible field. Placeholder tells the user that blank sends the hardcoded sentence. Archived status disables the button. The board still accepts the command. |
| `cmd.stop` | phone | full task | Shown for `queued` / `running` / `paused`. Board will also stop an archived task if a frame is sent. |
| `cmd.detail` | phone | `detail: "full"` | Opens from the list. Archived detail is allowed. Snapshot rows do not wipe a loaded full card (`mergeRelayTask`). |
| `cmd.archive.list` | phone | `{ tasks, nextCursor?, restarted? }` | Second list chip 归档, paged, not inside the hot snapshot. Requires capability or the phone shows 此看板暂不支持归档浏览. |
| `cmd.workspace.create` / `cmd.workspace.delete` | phone | workspace or `deleted` | Shipped. Switching workspace is local and is not a frame. |
| `evt.snapshot` / `evt.task` / `evt.log` / `evt.task.done` / `evt.gap` | board | hot list | `archived` is illegal on these frames. Archive removal refreshes the snapshot. `evt.task.done` is `succeeded` / `failed` / `stopped` only. |

Relay status enum: `queued` \| `running` \| `paused` \| `succeeded` \| `failed` \| `stopped`, plus `archived` **only** on `cmd.detail` and `cmd.archive.list`. Mapping: board `draft` and `queued` → `queued`; `blocked` → `paused`; terminal statuses pass through; `archived` is dropped unless `allowArchived`.

Full-card turns (`src/relay/map.ts`): last **12** iterations, each prompt/output clipped to **2,000** characters. `sideJobs` capped at 20. `promptTruncated` / `outputTruncated` are set for text clips **and** when more than 12 iterations existed. The public relay re-serializes tasks and drops unknown task fields, so this wave does not add a new turn flag.

### Known archive-cursor bug (fix on the board, no 101 change)

`pageArchivedTasks` emits `nextCursor` as `updatedAt:id:revision` (8 hex chars). `relay/src/protocol.ts` accepts that form. `src/relay/session.ts` `parseArchiveList` accepts only `updatedAt:id` and returns `cursor is invalid` for the revision form. Page 1 works. **加载更多** fails on the embedded dialer. Widen the board regex to the relay's `ARCHIVE_CURSOR`. Do this in the board wave before relying on archive paging. ThinkBook idle sync only. 101 already accepts the cursor.

### Make IA versus the phone

| Make screen | Phone now | Gap |
| --- | --- | --- |
| 任务列表: workspace first, then chips 全部 / 待办 / 进行中 / 已完成 / 归档, cards, FAB, safe top | Workspace chips, then only 进行中 \| 归档. Cards use raw-ish status text. No 已完成 bucket. | Add the four hot chips plus 归档. Keep workspace and status independent. Chinese badges. Insets. |
| 任务详情: rounds, tool chips, copy task id, actions, archive banner, logs | Rounds from `turns` with a one-round fallback. Copies **继续会话**, not the task id. Continue field always visible. Side jobs are a separate block, not chips. No archive action. | Composer (S1), honest turn heading (S3), copy task id, archive action, eligibility from the server status. |
| 工作区设置 | Missing. Create/delete only. | `cmd.workspace.get` / `cmd.workspace.update`. |
| 看板设置 | Missing. Relay-URL screen is a different page and stays. | `cmd.settings.get` / `cmd.settings.put`. |
| 新建任务 sheet | Full screen, not a sheet. No shortcuts. Worktree already defaults off. | Sheet, shortcuts, keep the status chip, open the new task. |

Detail copy that must change:

- Continue hint `留空则「请基于当前上下文继续完成任务」` goes away with the composer.
- Round heading must not say 共 N 轮 when N is only the loaded subset.
- 归档任务只读 stays, and the service must match it.

## 3. Field and command mapping

### Status filter

Hot list (`evt.snapshot` / `evt.task` only; never archived):

| Chip | Relay statuses | Badge |
| --- | --- | --- |
| 全部 | all hot rows in the selected workspace | per row |
| 待办 | `queued` | 待办 |
| 进行中 | `running`, `paused` | 进行中, 等待确认 |
| 已完成 | `succeeded`, `failed`, `stopped` | 成功, 失败, 已停止 |
| 归档 | not the hot list | 已归档. Prior terminal status is not a second badge; `lastEvent` is not on the wire. |

`visibleTasks` already filters by workspace. Status filtering is a second local predicate. `selectWorkspace` must not write the status chip. 「未分配」 stays as a workspace row when the snapshot has tasks with a missing or unknown `workspaceId`. Archive rows are filtered to the selected workspace (see `workspaceId` below). An empty filtered page with a `nextCursor` is not "no archived tasks".

`draft` and in-flight `queued` are indistinguishable on the phone. Both refuse continue. The phone does not gain 启动. `cmd.create` already starts the run.

### Turns

Source of truth is `cmd.detail` / full `evt.task` `turns[]`, built by `buildTurns`:

1. Prompts from `task.prompts`, or a single iteration-1 prompt from `task.prompt` when the array is empty.
2. Outputs from `task.outputs`, or one output at `task.iteration` from `task.output` when the array is empty.
3. Join on `iteration`, sort ascending, keep the last 12.

| UI | Rule |
| --- | --- |
| Stable id | `iteration` (integer ≥ 1). Not a UUID. Order is ascending iteration. |
| Heading when the set is exactly `1..task.iteration` | `共 {iteration} 轮`. |
| Otherwise | `已加载 {n} 条 / 最新第 {iteration} 轮`. Use this for holes (1, 8, 21), for the 12-cap, and when `n` ≠ `iteration`. Never `共 {n} 轮` in that case. |
| Prompt missing | `（无记录）`. Do not substitute `task.prompt` into a later iteration. |
| Output missing, status `queued` \| `running` \| `paused`, iteration equals `task.iteration` | One row: 实时 / 回复生成中…. |
| Output missing, not the live round | 本轮暂无回复. |
| `failed`, or `stopped` with no output text | `error` and non-zero `exitCode` beside the round. Do not put that string in the reply body. |
| `promptTruncated` / `outputTruncated` | Keep 提示词已截断 / 回复已截断. Do not treat the flag as permission to parse logs into a reply. |
| Tools | Chips only for `sideJobs` that exist, using `toolName` or else `title`. One task-level row, because jobs are not per iteration. No chips when `sideJobs` is absent. |
| Logs | Collapsed 原始日志 from `sub.logs`. Empty after archive is honest. |
| Reconnect | A snapshot without `detail: "full"` keeps the previous turns (`mergeRelayTask`). A full frame replaces turns. Dedupe by `iteration`; do not append a local card and a server card for the same iteration. |
| Archived | Same full card. `cmd.detail` already allows it. Actions hidden. |

The initial-prompt block above the rounds on the current phone duplicates round 1. The new detail shows rounds as the conversation. The meta grid keeps 任务 ID, status, iteration, times, agent, model, pid, exit code, session, 继续会话 (shell command, separate copy), workspace, cwd, and worktree branch when present.

### Copy task id

The id is `task.id` from the card the phone already has. No new command. Tap target on the id row. `ClipboardManager.setText` (or the platform clipboard the project already uses). Toast **已复制** only after that call returns. A failure stays silent or shows the error. Do not reuse the 继续会话 button for this.

### Continue composer (S1)

| Step | Contract |
| --- | --- |
| Open | 继续 is visible only when `canContinueStatus`: not `queued`, not `running`, not `archived`. `paused` stays allowed (board `blocked`). |
| Composer | Editable prompt, required non-blank after trim, max 20,000 (relay cap). Show task title, workspace name, and agent before submit. |
| Shortcuts | Chips from the last successful `cmd.settings.get` `quickPrompts`. Tapping inserts `content`. If `board.settings` is missing, the composer still works and the chip row is absent. |
| Submit | `cmd.continue` with `boardId`, `taskId`, `idempotencyKey`, and **`prompt` set**. Never omit it. |
| In flight | Button disabled. Same idempotency rules as today (`accepted` waits, `timeout` / stored `failed` lookup, no automatic second continue). |
| Success | Show the server round once, from the `executed` task or the following full `evt.task`. Clear the composer only then. |
| Failure | Keep the typed prompt. Show `err.message`. Do not invent a pending round. |
| Queued / draft-as-queued | No composer. Copy: 任务尚未结束，不能续跑. |
| Running | No composer. Existing hint: 任务运行中，请先停止再继续. |
| Archived | Banner only. Board returns `archived_readonly` if a frame arrives anyway. |

### Workspace settings (S2)

New capability `workspace.settings`.

`cmd.workspace.get` payload: `boardId`, `idempotencyKey`, `workspaceId`.

Executed `workspace`:

```json
{
  "id": "ws_app",
  "name": "App",
  "path": "/home/me/src/app",
  "isGit": true,
  "settings": { "systemPrompt": "", "skills": [], "mcp": "" },
  "git": {
    "branch": "main",
    "dirty": false,
    "ahead": 0,
    "behind": 0,
    "detached": false,
    "repoCount": 1,
    "error": null
  }
}
```

`settings` always includes the three keys. Empty string and empty array mean unset. `git` is a summary of the root repo from `workspaceGitStatus`, plus `repoCount`. No file list. `git.error` is shown and does not block save. `isGit` remains the worktree bit.

`cmd.workspace.update` payload: `boardId`, `idempotencyKey`, `workspaceId`, `name`, `path`, `settings` (all three keys). Board runs the same checks as `PATCH`. Ack returns the same workspace object as get. Phone replaces the form with that body and only then toasts 已保存.

| Form field | Editable | Save |
| --- | --- | --- |
| 名称 | yes | `name`, 1–200, no control characters |
| 路径 | yes, with a confirm that existing tasks keep their cwd | `path`, `resolveAllowedDirectory` |
| 首次运行提示词 | yes. Label it that way, not 系统角色 | `settings.systemPrompt` |
| Skills | yes, one entry per line | `settings.skills` |
| MCP 说明 | yes. Label it as prompt text, not 已连接的 MCP | `settings.mcp` |
| Git | no | not sent |

Loading / saving / error states are explicit. A failed save keeps the edits. Cancel discards back to the last loaded document. Do not write the form into the snapshot cache as if it were saved.

### Board settings and shortcuts (S2)

New capability `board.settings`.

`cmd.settings.get` payload: `boardId`, `idempotencyKey`. Ack `settings` is the `GET /api/settings` JSON. The phone must not log it.

`cmd.settings.put` payload: the same partial body as `PUT`, except **`clear` is rejected**. Ack returns the full document. Toast 已保存 only from that ack.

| Form | Maps to | Phone rule |
| --- | --- | --- |
| 快捷提示词 add / edit / remove | replace `quickPrompts` | Local list edit, one PUT of the full array. Disable the section when the capability is missing. Do not pretend a chip was stored. |
| Codex CLI 路径 | `cliPaths.codex` override | Empty clears. |
| Codex HTTP/HTTPS 代理 | `proxyEnv.codex.HTTP_PROXY` / `HTTPS_PROXY` | Show redacted value. Resend `***` unchanged to keep the secret. Empty clears. Never log the value. |
| Codex 沙箱 | `codexSandbox` | Default on. Turning **off** requires a confirm that names the extra privileges (`danger-full-access`). |
| Cursor / pi / Claude / Devin CLI | `cliPaths.agent` / `pi` / `claude` / `devin` | Include Devin because the schema has it. Label Cursor as the `agent` binary. |
| Per-agent `NO_PROXY` and `ALL_PROXY` | `proxyEnv.<kind>.*` | This is the only "全局代理". There is no board-wide proxy key. |
| 默认模型 | none | Read-only sentence: 默认模型来自各 CLI 的本机配置，看板不保存。 No text field. |

### Archive write (S4)

New capability `archive.write`. Command `cmd.archive`.

Payload: `boardId`, `idempotencyKey`, `taskId`.

Board allows it only when status is `succeeded`, `failed`, or `stopped`. Otherwise `archived_readonly` or `bad_request` (`task is still running` / `draft cannot be archived`). Implementation calls `moveTask(id, "archived")` after that check. The executed ack has **no** hot-list task (or a task the phone must not insert into the hot list). The next snapshot drops the card. The phone reloads archive page 1.

`cmd.archive.list` gains optional `workspaceId`. Omitted means today's board-wide page, so the current APK stays valid. Present means the page is already limited to that workspace, newest `updatedAt` first, same cursor. 101 must forward the field; today unknown payload fields are not forwarded.

Service rejects, in `src/manager.ts`, independent of the phone:

| Call | Archived task |
| --- | --- |
| `continueTask` | `archived_readonly` |
| `stopTask` | `archived_readonly` (today this would set `stopped`) |
| `startTask` | `archived_readonly` (today this would wipe outputs) |

`cmd.stop` / `cmd.continue` on an archived id surface that error. The phone still hides the buttons.

### Create (S4)

Reuse `cmd.create`. No new envelope.

| Rule | Detail |
| --- | --- |
| Prompt | Required, non-blank, ≤ 20,000 on the phone (relay). |
| Workspace | The selected workspace id and its path. Refuse when none is selected. |
| Title | Still required by `cmd.create` (≤ 200). |
| Agent | `pi` \| `claude` \| `cursor` \| `devin` \| `codex`. |
| Worktree | Control defaults off. Send `useGitWorktree: true` only when the user turns it on and the cwd is a git workspace root in a fresh snapshot. Omit or `false` otherwise. |
| Shortcuts | Same `quickPrompts` as continue. |
| After success | Do not change the status chip. Open the new task. If the chip hides it (已完成 or 归档), also set a banner 已创建，当前筛选里看不到. |
| Double submit | Existing create idempotency. |

## 4. New envelopes

All of these are `v: 1`. `cmd.lookup` must accept the new command names. The relay allowlist (`relay/src/protocol.ts`, `relay/src/hub.ts`) and both dialers must learn them together. A board that registers without the capability gets `err` `unsupported`, and the command is not stored. That is the old-client and mixed-version behavior. Do not answer those with a synthetic `executed`.

Capabilities added on `board.register`:

| Capability | Commands |
| --- | --- |
| `archive.list` | already shipped |
| `archive.write` | `cmd.archive` |
| `workspace.settings` | `cmd.workspace.get`, `cmd.workspace.update` |
| `board.settings` | `cmd.settings.get`, `cmd.settings.put` |

Optional `workspaceId` on `cmd.archive.list` is part of `archive.list`. Older phones omit it.

Error code to add: `archived_readonly`. Message can be Chinese or English; the phone maps the code in `Copy.kt` the same way as `unsupported`.

No change to snapshot task status. Archived cards stay off `evt.task` / `evt.snapshot`.

## 5. S1–S4 acceptance

| Id | Done when | Proof |
| --- | --- | --- |
| S1 | 继续 opens a composer with shortcuts when settings are available. Submit sends the typed prompt. Blank cannot submit. Queued, running, and archived have no composer. One pending round after success, no duplicate. Failure keeps the text. The hardcoded sentence is never sent by the phone and is not stored for that attempt. | Protocol unit test: continue payload includes `prompt`. Board test: omitted prompt still defaults (HTTP/relay compatibility) but archived continue throws. Phone test: button disabled while busy; queued status does not build `cmd.continue`. Manual: type a unique string, see that exact string as the new round's prompt, kill the network and see the error with the text retained. |
| S2 | Workspace form loads `systemPrompt` / `skills` / `mcp` / name / path and git summary. Save writes only those fields to that workspace id. Failed save keeps edits and does not toast. Board form round-trips CLI paths, proxies, sandbox, and shortcut add/edit/remove. Sandbox off asks for confirmation. `***` proxy is not written over the secret and is not logged. Default model and live MCP are not fake fields. | Board tests already cover normalize, quick prompts, sandbox, and proxy redaction; extend them for the relay handlers. Relay test: capability missing → `unsupported` and no meta write. Phone test: toast only on `executed`. Manual: change a skill, reopen, see it; set sandbox off and cancel; confirm a redacted proxy still works for the next run without the phone having the password in logcat. |
| S3 | Detail uses server turns. Holes stay holes. Heading is 已加载 n 条 / 最新第 N 轮 when the set is not `1..N`. Pending, failure, and archived history match the table in §3. Logs are not the reply. Tool chips only from `sideJobs`. Reconnect does not duplicate rounds. | Map test: 21 iterations with 12 kept does not report "3 rounds". Protocol test: merge of a snapshot keeps full turns; a full frame replaces them. Fixture with iterations 1, 8, 21 renders three cards and the loaded/latest heading. Archived fixture still has prompts after `task_logs` are gone. |
| S4 | 已完成 shows 成功 / 失败 / 已停止 and not archived rows. 归档 is the other chip and follows the workspace. Stop only for `queued` / `running` / `paused`. Archive only for terminal hot statuses, rejected otherwise. Create keeps the chip and opens the task. `WindowInsets` on every screen, including IME on the composers. | Protocol test for the bucket function. Board test: `stopTask` / `continueTask` / `startTask` on archived throw; `cmd.archive` rejects `running`. Manual on a gesture-nav device with font scale ≥ 1.3: list top bar, settings form scroll, FAB, and keyboard. Create under 已完成 and confirm the chip stays and the banner appears. |

Manual pass is on a device or emulator with gesture navigation. JVM tests do not prove insets.

## 6. Wave order

Do not start wave 2 until this plan has been reviewed. Each later wave is its own change. This PR is wave 0.

1. **Board, only where the service is wrong or missing.** Reject archived continue/stop/start. Fix the archive cursor regex. Add the get/update/settings/archive functions on the facade, called by the new commands, reusing `PATCH`, `GET/PUT /api/settings`, `moveTask`, and `workspaceGitStatus`. No new HTTP route unless a handler cannot be reached in-process. Tests: multi-round turns, sparse iterations, pending, failed, archived history, invalid workspace, settings validation, path change leaves `task.cwd` alone, proxy placeholder.
2. **Relay versioning.** Allowlist the new commands in `relay/` and both dialers. Advertise the three new capabilities from `src/relay/run.ts` and `connector/`. Extend `cmd.lookup`. Document the envelopes in `PROTOCOL.md` and `relay/PROTOCOL.md` in the same change. Tests: auth, foreign `boardId`, archive read-only, settings write, missing capability, old phone without the new commands, reconnect lookup. Cursor revision does not require a relay parser change.
3. **Compose APK.** Order inside the app: workspace selector and status chips → detail turns, copy id, actions → workspace settings and board settings → create sheet and continue composer. Material 3, Chinese for `zh`, English catalog otherwise. Match the information architecture, not the prototype CSS. States: loading, empty, error, offline, partial turns. Do not cache settings or proxies in logs or in unencrypted diagnostics. Multi-board sessions and workspace search are part of this wave, specified in `docs/apk-multi-board-ws-search-plan.md`. Implement them on the phone before any Compose pass that still assumes one device token, one socket, `ws_$boardId`, or `openBoard` resetting the status chip. Plan-gate S1–S5 in that document are must-fix before code review. They do not change waves 1 or 2, and they do not add a relay command. Phone-only multi-board does not waive wave 2 for settings or archive write, and it does not waive the sol code review after Compose.
4. **Sol code review** of the implementation. Do not merge for release before that review.
5. **Idle ThinkBook sync**, and **101 redeploy if the protocol list below is in the build**. Confirm the board is idle first. A running task must not be restarted to pick up the dialer.
6. **Install the APK only after** the ThinkBook that it talks to advertises the capabilities the build requires. An APK pointed at an old relay must fail the new screens clearly. That is not the release configuration.

## 7. What forces a ThinkBook sync and a 101 redeploy

| Change | ThinkBook (idle) | UCloud 101 |
| --- | --- | --- |
| `cmd.workspace.get`, `cmd.workspace.update`, `cmd.settings.get`, `cmd.settings.put`, `cmd.archive` | yes | yes. 101 drops unknown command types before the board sees them. |
| Capabilities on `board.register` | yes | yes. 101 allowlists capability names (`KNOWN_CAPABILITIES` is only `archive.list` today). |
| `cmd.lookup` of the new names | yes | yes |
| Optional `workspaceId` on `cmd.archive.list` | yes | yes. 101 rebuilds the payload and would strip the field. |
| `archived_readonly` on existing continue/stop, and `startTask` | yes | no. The board emits a normal `err`. The relay already forwards it. |
| Archive cursor regex on the embedded dialer | yes | no. 101 already accepts `updatedAt:id:revision`. |
| Turn heading, copy id, status chips, insets, composer UX | no, APK only | no |
| Honest turn label without a new task field | no | no. A new task field would be stripped by 101's `taskToJson` and is out of this wave. |
| Multi-board sessions, per-board forget, connection pills, workspace search | no, APK only | no. Existing pair, hello, `board.list`, and `sub.tasks`. See `docs/apk-multi-board-ws-search-plan.md`. |

If wave 2 is skipped, the APK must not ship settings, archive write, or workspace-scoped archive paging. Continue composer, copy id, status chips, and turn labels can ship against the current protocol, with shortcut chips hidden until `board.settings` exists.

## 8. Phone file map (later waves, not this PR)

| Area | Files |
| --- | --- |
| Status bucket, archive filter, settings DTOs, continue payload | `android/protocol/.../Tasks.kt`, `Frames.kt`, `Commands.kt`, `ProtocolTest.kt` |
| Screens and composers | `android/app/.../ui/Screens.kt`, `Copy.kt`, `values/strings.xml`, `values-zh/strings.xml` |
| Insets | `RootScreen` scaffold: `WindowInsets.systemBars` and `imePadding` on list, detail, both settings screens, create, continue, pair, and boards. Content must scroll above the IME. FAB clears the gesture inset. |
| Load/save | `BoardViewModel.kt`. Settings are session memory, cleared on forget-phone. |
| Board | `src/manager.ts`, `src/relay/session.ts`, `src/relay/facade.ts`, `src/relay/run.ts`, `src/relay/archive.ts` |
| Public relay | `relay/src/protocol.ts`, `relay/src/hub.ts`, `relay/PROTOCOL.md`, `PROTOCOL.md` |
| Standalone dialer | `connector/src/session.ts` and its archive/settings counterparts |

## 9. Open risks

1. **Page 2 of 归档 is broken** on the embedded dialer until the cursor regex is widened. Page 1 is fine.
2. **`stopTask` currently un-archives** by writing `stopped`. Ship the service reject before any phone 归档 button.
3. **`draft` and `queued` share a badge.** Users cannot start a draft from the phone. Continue stays disabled. This is accepted.
4. **Turn text is capped** at 12 rounds and 2,000 characters, and `outputTruncated` means either clip or dropped rounds. The heading rule covers that without a new field. A later pagination command would be another 101 change and is not in this wave.
5. **No settings etag.** Two phones can overwrite each other. The form reloads from the ack, so the loser sees the winner's document only after their own save fails or they reopen. Say so in the error path if a save fails; do not invent a conflict dialog without a version field.
6. **Archive paging without `workspaceId`** can return other workspaces' rows. The optional filter is in the protocol wave. Until 101 has it, the phone may follow cursors client-side and must not treat an empty filtered page as the end.
7. **Web restore** (`lane: "done"` on an archived card) still leaves the archive. The phone does not offer it. Closing that HTTP path is a separate web change and is not required for S4.
8. **Git summary can be slow** (`git status` caps at 4s per repo). `cmd.workspace.get` should still return name, path, and settings if git fails, with `git.error` set, so a hung git does not block editing instructions.
9. **Sandbox off is a privilege change** on the ThinkBook for new Codex runs. The confirm copy must match the web hint. The phone cannot know whether `~/.codex/hooks` exists.
10. **Idle sync is operational, not a repo edit.** This plan does not authorize restarting the ThinkBook or redeploying 101. Those happen only after the implementation review, and only when no board task is running.

## Out of scope

Pixel-perfect CSS, editing the Make file, direct phone-to-board HTTP, live MCP server configuration, a stored default model, phone-side delete, draft start, unarchive, attachments, and shipping the APK before the sol code review.
