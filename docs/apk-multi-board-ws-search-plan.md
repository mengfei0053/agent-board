# APK multi-board sessions and workspace search — implementation plan

Status: **plan only**. No Compose, session-store, relay, or board code changes in this PR.

Design gate: **GO with conditions** (`agent-board-apk-multi-board-ws-search-sol`). D1–D11 and R1–R7 are accepted with the clarifications in that review. Those clarifications are the implementation contract below. The HTML prototype and the Make file (`https://www.figma.com/make/Mjku7xs8YBVvyRERhqUoCb`) are illustrative. `SCREENS.md` navigation that says forget lands on “列表或留在看板页” is closed by R7: forget of the current board returns to the **task list**.

S1–S4 in `docs/apk-make-ui-plan.md` stay in force. This feature is a sub-item of that Make UI wave, not a second product. Protocol version stays **`v: 1`**. This plan adds no command, no capability, and no HTTP field.

Baseline: `origin/main` @ `2048662` (Make UI plan #15). Board wave 1 is the open PR [#16](https://github.com/mengfei0053/agent-board/pull/16) (`cursor/apk-make-board-wave1-c22f`). This plan does not edit that branch.

## Decisions locked here

1. The phone primary key for a paired board is a **local session id** minted on the phone (`nanoid`-style, stored, never derived). `(relayUrl, boardId, deviceToken)` is lookup material only. A token refresh must not create a new row.
2. Each successful pair stores the device token it actually received. The target operator practice is **one pair code bound to one `boardId`**, which the relay already supports. A pair code that returns several `boardIds` becomes several local sessions that **share one credential**. The phone cannot split that token.
3. The same normalized relay origin may hold many sessions. Display names may repeat. A card distinguishes them with the relay host and the `boardId`. The card never shows a pair code, a device token, or a prefix of either.
4. Forget deletes the local session (and the credential secret only when no remaining session uses it). Forget does not call revoke. The last remaining session cannot be forgotten. Zero sessions is only the unpaired empty state (fresh install, or secrets unreadable).
5. Switching the active session, and forgetting the current session, clear detail, restore that session’s last workspace if the snapshot still contains it, otherwise the first valid workspace, otherwise an empty state. The **筛选 chip** is unchanged. The workspace **search query** is cleared. The header **连接态** is the newly active session’s own pill.
6. Workspace search is a local, case-insensitive substring on **name or path** for the active session’s workspaces. No pinyin, no task search, no cross-board search. Search and workspace selection do not change the 筛选 chip.
7. Connection is simultaneous per credential: one WebSocket per stored credential, `sub.tasks` for every board still on that credential, `board.list` as the presence probe. The 筛选-chip sentence “状态 chip 不变” does not mean the connection pill is global. A build that leaves a non-active board painted 已连接 with no fresh proof is not this plan.

## 1. What the phone does today

| Concern | Code today | Gap this wave closes |
| --- | --- | --- |
| Secrets | `SessionStore`: one `device_token`, `device_id`, `expires_at` in `EncryptedSharedPreferences`. URL and device name in plain prefs. | One credential catalog. Tokens stay in the encrypted file. |
| Board list | One socket. `client.hello` then `board.list`. Rows are `BoardInfo` (`boardId`, optional `label`, `online`). | Those rows are the relay’s view of **one token**. The phone must keep a row per local session, including sessions on another token or another origin. |
| Active board | `selectedBoardId` in memory. Relaunch opens `Screen.Boards`, not a remembered board. `openBoard` replaces the single `BoardReducer`. | Persist `activeSessionId`. Home is that session’s task list. |
| Workspace memory | Plain key `ws_$boardId`. | Key `ws_$sessionId`. Same `boardId` on two relays must not share a selection. |
| Switch | `openBoard` clears tasks, detail, and archive, then sets `lane = "active"`. | Stop writing the 筛选 chip on switch. |
| Forget | `forget()` clears the only token, closes the only socket, and returns to the pair screen. It does not call the relay. | Per-session forget. R7 landing. Minimum one session. |
| Socket | `OkHttpRelay` holds one `WebSocket`. `openSocket` closes the previous one. | One socket per credential. Opening a second credential must not drop the first. |
| Presence | `selectedOnline` is the boolean from the last `board.list`. There is no 弱连接 pill. A board that disconnects is not pushed; `releaseBoard` only fails in-flight commands. | Derive the pill. Probe with `board.list`. Demote stale 已连接. |
| Tasks | One `BoardView`. `tasksAfterBoardSwitch` hides rows when `view.boardId != selectedBoardId`. `BoardReducer.sameBoard` treats a **missing** `boardId` as the current view. | One view per session id. A missing `boardId` on a multi-board socket is dropped. |
| Search | None. Workspace UI is create / delete / select. | Local name/path filter in the selector. |
| Settings screen | Global relay URL, token refresh, “forget phone”, and it prints `deviceId`. | Not the Make gear or filter. Those are S2, scoped to the active session. |

Relay behavior that already matches the product, and must not be re-specified as new HTTP:

| Fact | Where |
| --- | --- |
| Pair code is `pc_` + 32 random bytes, one-time, default TTL 5 minutes (`PAIR_TTL_MS`). The admin chooses `boardIds` (1–20, unique, `BOARD_ID` grammar). | `relay/src/auth.ts` `createPairCode`, `POST /auth/pair/create` |
| `POST /auth/pair` returns `{ deviceId, deviceToken, role: "phone", boardIds, expiresAt }`. The token is bound to that list for its life. Refresh rotates the token and **keeps** `deviceId` and `boardIds`. Default token TTL is 7 days (`TOKEN_TTL_MS`). | `auth.ts` `pair` / `refresh` / `mint` |
| Auth state is in memory. A relay restart invalidates every token. | `relay/src/index.ts` |
| `client.hello` is once per socket. A second hello on the same socket is `already_authenticated`. Two sockets with two tokens are two `PhoneConn`s. `kickToken` drops only the rotated token. | `relay/src/hub.ts` `hello`, `kickToken` |
| `board.list` returns each allowed `boardId` with `online: Boolean(live socket)`. No presence push exists. | `hub.ts` `listBoards` |
| `sub.tasks` **adds** to `taskBoards`. One socket can subscribe to every board on its token. There is no unsubscribe frame. | `hub.ts` `subscribeTasks` |
| `sub.logs` replaces that board’s filter. `null` means every task. | `hub.ts` `subscribeLogs` |
| `evt.snapshot` / `evt.task` / `evt.gap` from the dialer carry `boardId` (`src/relay/session.ts` builds the snapshot with the board id). `evt.task.done` is fanned to every authenticated phone whose token includes that board, not only task subscribers. | `hub.ts` `fanoutTasks`, `fanoutDone` |
| Commands for an offline board return `err` `board_offline` and are not queued. `forbidden` if the token’s `boardIds` omit the id. | `hub.ts` `forwardCmd`, `allow` |
| Revoke is admin-only: `POST /auth/revoke/device` `{ deviceId }`, `POST /auth/revoke/board`. The phone has no admin token. | `relay/PROTOCOL.md` |

**Phone-only.** Multi-board sessions, search, pills, and forget do not require a ThinkBook sync or a 101 redeploy. An old APK keeps working: it still pairs one token and lists that token’s boards. A new APK uses the same frames.

Do not add a phone revoke route, a display-name field, an unsubscribe frame, or a presence push in this wave. If a later review wants those, that is a separate protocol gate. This GO does not authorize them.

## 2. Pairing, credentials, and revoke (R1, R2, R7, D3, D8)

### Local records

Two records, so a token rotation cannot renumber the UI:

| Record | Stored | Contents |
| --- | --- | --- |
| Credential | Encrypted prefs, keyed by local `credentialId` | `deviceToken`, `deviceId`, `expiresAt`, normalized `httpBase`, derived `wsUrl`, the `boardIds` from the last hello or pair response. |
| Session | Plain prefs, keyed by local `sessionId` | `credentialId`, `boardId`, user `displayName`, `createdAt`. Order is an explicit list of session ids. `activeSessionId` is plain. Workspace id is `ws_$sessionId`. |

`displayName` is phone-local. It is not sent as a new JSON field. `POST /auth/pair` still sends the existing phone `deviceName` (the current single name, 1–80 characters), not the board display name.

Normalized origin is `normalizeHttpBase` (`scheme` + `host` + explicit port). `https://relay.example` and `https://relay.example/` are one origin.

### Add

Form: 显示名 (required, 1–40, duplicates allowed), 中继 URL, 配对码. The pair-code field is masked. The length hint may stay. Logs, banners, and screenshots of error text must not contain the code or the token. `pairHttpFailure` already collapses unknown, expired, and used codes into one sentence; keep that. Rate limit stays its own sentence. The phone does not retry a failed pair.

Success path:

1. `POST /auth/pair` on that origin. Persist the token only after `commit()` of the encrypted write (`persistThenConnect`). A failed commit discards the token and does not open a socket.
2. For each `boardId` in the response, resolve the session:
   - Same normalized origin and same `boardId` already stored: **re-pair**. Replace that session’s credential binding with the new token. Do not insert a second card. If the old credential has no remaining session, delete the old secret and close its socket.
   - Otherwise mint a new `sessionId` and append it.
3. A pair response with several new ids creates several sessions on **one** new credential, in response order.
4. Switch to the first session created or updated by this submit. Clear detail and search. Keep the 筛选 chip. Land on the task list. Toast `已切换到 {显示名}`.
5. A failure (HTTP, parse, or commit) leaves the session list, the active session, the 筛选 chip, and the search query as they were. A half-parsed response is not inserted.

Cap: 20 local sessions, matching the relay’s board-id cap. The 21st add is refused before `POST`.

The add form’s busy flag does not pause sockets that already exist.

### Re-pair and expiry

Refresh is per credential: `POST /auth/refresh`, write the new token, then reconnect **that** socket. `kickToken` on the relay drops the old socket. Other credentials stay up. Refresh failure or `unauthorized` marks that credential 需要重新配对, closes its socket, and does not delete or retarget other sessions.

Show expiry as a time (`登录将于 {time} 失效`) with no token and no token prefix. `deviceId` stays off the board card. The current settings row that prints `deviceId` is removed from the board list.

### Forget

| Action | Result |
| --- | --- |
| Forget a non-active session | Remove it. Active session, list screen vs detail, 筛选 chip, search query, and detail stay. If its credential still has another session, keep the secret and the socket. Ignore later frames for the removed session, including `evt.task.done`. |
| Forget the active session, with others remaining | Remove it. Active becomes the first id in the stored order that remains. Clear detail, logs, and pending detail/archive for the removed id. Restore the new session’s workspace (§3). Clear search. Keep the 筛选 chip. Navigate to the **task list**, including when forget was confirmed on 我的看板. |
| Forget the only session | Control disabled. Copy explains that the phone keeps one paired board. Replacing it is add-then-forget. |
| Unpaired | Fresh install, or encrypted prefs unreadable. Empty guide and the pair form. Do not synthesize a board so the minimum-one rule looks satisfied. Plain-pref display names without a secret are not shown as paired. |

Forget does not `POST /auth/revoke/device`. Copy must not say the board or the relay session was revoked. The token remains valid on the relay until expiry, restart, or an admin revoke. After a local forget of the last session on a credential, this phone no longer has the secret.

There is no “forget phone” that wipes the last board. Keystore failure is the empty state above, not a forget action.

### Migration from the single token

On launch, if a session catalog is absent and the legacy `device_token` exists:

1. Move that token into one credential. Do not drop it if the network is down.
2. Connect and `board.list`.
3. Create one session per returned `boardId`, display name = `boardId` (the id is the operator name already shown in the current board list, not a secret). Order follows `board.list`.
4. Copy `ws_$boardId` to `ws_$sessionId` when that `boardId` appears once. A duplicate `boardId` across origins does not get the legacy value.
5. Set `activeSessionId` to the first session and open its task list.
6. Delete the legacy single-token keys after the catalog commit. If `board.list` has not succeeded yet, keep the legacy token until it does, and show one row `正在读取已配对看板` with pill 弱连接. That row is not a fake paired board; it is the unread credential.

A catalog that already exists wins over leftover legacy keys.

## 3. Switch atomicity (D2, D4, D10, R5, R7)

The rendered list, detail, workspaces, archive page, and settings form are always the active `sessionId`. Background sessions keep their own `BoardView` so a later switch can show a snapshot, and so a live frame can update the card pill. Those views are not painted in the active list.

`openBoard` today is the wrong primitive (`lane = "active"`, one reducer, workspace key = `boardId`). The phone wave replaces it. `tasksAfterBoardSwitch` stays as a render guard and gains the session id: a view is visible only when its session id is the active one. Equal `boardId` strings on two sessions are not a match.

On **activate(session)**:

| Piece | Rule |
| --- | --- |
| Detail | `selectedTaskId` null, logs cleared from the UI, detail screen popped. In-flight `cmd.detail` / archive acks carry the session id they were sent for. An ack whose session is not active does not set the visible task and does not navigate. It may update that session’s background view. |
| Tasks | Visible rows come from the new session’s view only. Until its first snapshot, the list is loading or the offline empty state in §4, never the previous session’s cards. |
| Workspace | Remembered id is `ws_$sessionId`. Before a snapshot, keep it and do not persist a fallback (`nextWorkspaceSelection` already does this). After a snapshot, keep it when that id is still in the workspace list; otherwise `resolveWorkspaceSelection` (first workspace that has tasks, then 「未分配」, then the first workspace). Zero workspaces → `null` and `此看板暂无工作区`. Do not invent a workspace named 默认. |
| 筛选 chip | Not written. A chip with no rows shows that chip’s empty copy (`此筛选下暂无任务`), including 归档. |
| Search | Query set to empty. |
| 连接态 | Header pill is `linkPill` of the new session (§4). |
| Toast | `已切换到 {显示名}` for a user switch. Forget uses the same switch without a second product rule. |
| Settings forms | Gear edits the active session’s **current workspace**. Filter edits the active session’s **board settings** (S2 documents, not a global app page). Leaving either form on a switch discards unsent edits the same way cancel does. A request already on the wire is tagged with the session id. Its ack updates that session only. It does not toast 已保存 on a different session and does not fill the new form. |
| Create / continue | The composer closes. A command already sent stays in that session’s inflight map. Completion navigation (open the new task, S4) runs only if that session is still active. |

Same workspace id on two boards is normal (`nanoid(10)` per board). Filtering is by session view, then workspace id inside that view.

Pending callbacks that must carry `sessionId` (and drop or background-apply when it does not match): snapshot and task apply, detail, archive page, create / continue / stop, workspace create / delete, settings get / put, command lookup. The relay idempotency key stays scoped to `boardId` + command type. The phone’s inflight map is keyed by `sessionId` + command + task id so one board’s lookup cannot settle another session.

「未分配」 remains a workspace row when **this** snapshot has tasks with a missing or unknown workspace id. It is not shared across sessions.

## 4. Connection model (R3, R4, D9)

Product intent is simultaneous observe. The implementation is:

- One OkHttp socket per credential (`wsUrl` + `credentialId`). `pingInterval` stays 30s. Reconnect backoff stays 1s, doubling, cap 15s, **per credential**. One credential’s backoff does not reset another’s.
- After hello: `board.list`, then `sub.tasks` for every `boardId` that still has a local session on that credential. Do not subscribe boards the user has forgotten.
- `sub.logs` only for the task whose detail is open, with that `taskId`. The relay cannot unsubscribe. After the detail closes, leftover log frames for that task may still arrive; append them only to that session’s capped tail. Do not add an unsubscribe command.
- `evt.task.done` dedupe stays global by `eventId` (two tokens must not double-notify). The notification title is the session display name plus the task title, so two boards are distinguishable. Ignore done for a session id that was forgotten. Tapping the notification opens that session’s detail only if the session still exists.

### Pill

`linkPill` is a pure function of socket phase, last successful `board.list` entry, snapshot flags, token state, and `now`. The UI does not store a sticky “online” string. On resume, evaluate with the current clock before the first frame.

| Condition | Pill | Words (zh) |
| --- | --- | --- |
| Latest list ≤ 60s, `online: true`, snapshot applied, `needsResync` false, socket authenticated | 已连接 | 已连接 |
| Latest list ≤ 60s, `online: false`, socket authenticated | 离线 | 离线 |
| Socket connecting or reconnecting; or authenticated but no list yet; or `needsResync`; or last 已连接 proof older than 60s | 弱连接 | 弱连接，and `状态更新于 {time}` when a proof exists. Initial hello with no proof yet: 正在连接 |
| Hello or refresh returned `unauthorized` / `revoked` for this credential | 离线 | Banner 需要重新配对. The pill is still 离线, with that sentence, not a color by itself |

A dead board is not pushed. Presence is the existing `board.list`:

- Send it on hello, on return to foreground, immediately after `board_offline` or `board_disconnected` on that socket, and every 15s while the process is in the foreground and the socket is authenticated.
- One list per credential covers every board on that token, so a shared credential still shows board A 已连接 and board B 离线.
- Stop the 15s timer when the process leaves the foreground. Do not take a wake lock and do not start a foreground service. Sockets stay open. If the system closes one, that credential’s pill becomes 弱连接 in the same state update that records the close. Resume polls immediately and re-evaluates the 60s rule before painting 已连接.

The 15s poll is the lag bound: a board can stay 已连接 until the next list, and the stamp shows when that list happened. That lag is accepted. A sticky green with no timestamp is not.

Quiet boards stay 已连接 across the 15s poll when `online` is still true. Silence of `evt.task` is not 弱连接.

### Cache copy

The only cache in this wave is the in-memory `BoardView` for that `sessionId` after a snapshot has been applied in this process. There is no disk task cache. Process death means no cache.

| Situation | List body |
| --- | --- |
| 已连接 | Live rows for the active workspace and 筛选 chip. No cache sentence. |
| 离线 or 弱连接, and this session has a snapshot | Rows from that snapshot. Sentence `看板离线 · 显示本地缓存 · 可能已过期` or `连接不稳定 · 显示本地缓存 · 可能已过期`, plus the snapshot time. |
| 离线 or 弱连接, and this session has no snapshot | `无法加载，暂无离线数据`. Do not copy another session’s tasks, workspaces, or archive page. |
| Snapshot with zero workspaces | `此看板暂无工作区`, which wins over the search-miss sentence and over the cache sentence’s task list. |

Writes follow reachability. Create, continue, stop, workspace create/delete, and settings save are disabled when the pill is 离线, when the token needs re-pair, or when the socket is not authenticated. The control’s reason is the pill sentence. When the socket is authenticated and the latest list says `online: true` but the pill is 弱连接 only because of `needsResync`, the command may be sent; failure shows `err.message` and does not toast 已保存 or 已创建. `board_offline` stays a real error. Disabled archive when the capability is missing stays the S4 / current copy `此看板暂不支持归档浏览`.

### Power and the test that rejects a fade

Accepted cost: at most 20 sockets, one 30s ping each, one `board.list` per 15s per socket in the foreground, task snapshots for subscribed boards, logs for one open task. `WS_MESSAGES_PER_SEC` is 40 per socket. A list every 15s is inside that budget. If a many-board snapshot stream hits `rate_limited`, report it. The response is not to drop background `sub.tasks` and freeze the last pill.

Manual proof, two boards, same relay, two one-board pair codes:

1. Stop one board process. Within one poll (15s) that card is 离线 with the offline sentence, and the other card stays 已连接.
2. Stop the relay. Both pills become 弱连接. Neither still reads 已连接 after 60s without a list.
3. Kill the app process, reopen offline. Copy is `无法加载，暂无离线数据`, not `显示本地缓存`.
4. Switch to the offline board after it has had a snapshot this process. Detail is gone, its tasks (if any) show the cache sentence, the other board’s tasks are absent, the 筛选 chip is the one from before the switch.

A build that tracks only the active socket and leaves the other card on the last 已连接 fails this plan even if the UI has a switcher.

## 5. Workspace search (D5, D6, D7, R6)

Pure function, JVM-tested, no I/O:

- Trim the query. Empty query keeps every row.
- Otherwise match when `name` or `path`, lowercased with `Locale.ROOT`, contains the lowercased query.
- 「未分配」 matches on its label only (no path).
- No pinyin, no normalization beyond that case fold, no server round trip.

The field lives in the workspace selector. It filters that menu. It does not filter the task list by itself; the task list still uses the selected workspace and the 筛选 chip.

| Input | Selector | Chip |
| --- | --- | --- |
| Query, some names or paths match | Those rows | unchanged |
| Query, workspaces exist, none match | `无匹配工作区` | unchanged |
| Snapshot loaded, zero workspaces | `此看板暂无工作区` even if the query is non-empty | unchanged |
| User picks a row | Selection updates, query kept | unchanged |
| User switches session or forget lands on another session | Query cleared, menu shows the restored workspace | unchanged |

Gear (workspace settings) and 新建任务 are disabled when the active session has no workspace, with `此看板暂无工作区`. Filter (board settings) stays available; it is the board document. Long paths wrap. The selector scrolls above the IME (`imePadding`, same inset rule as S4).

## 6. S1–S4 that this wave must not reopen

`docs/apk-make-ui-plan.md` is the contract for continue, settings, turns, archive, create, and insets. Apply it inside the active session.

| Gate | What changes because there are many sessions | What stays |
| --- | --- | --- |
| S1 继续 | Composer and `cmd.continue` use the active session’s task and that session’s `quickPrompts` from its own `cmd.settings.get`. A prompt typed on board A is not sitting in board B’s composer after a switch. | Non-blank `prompt` always sent. No hardcoded `请基于当前上下文继续完成任务` from the phone. Failure keeps the text. Queued, running, and archived have no composer. |
| S2 settings | Gear = active workspace. Filter = active board. Save and the 已保存 toast are tied to that session id. Proxy values are not logged and are not stored in the session catalog. | Real `GET`/`PUT` documents. No default-model field. No fake MCP connection. `clear: true` is not sent. Failed save keeps edits. |
| S3 turns | Detail unmounts on switch. Reconnect merge (`mergeRelayTask`) runs inside that session’s reducer. | Server turns, hole heading, logs are not the reply, tool chips only from `sideJobs`. |
| S4 chips and insets | `openBoard` must not reset the chip to 进行中 or 全部. Create still does not change the chip. Insets cover list, detail, both settings screens, create, continue, pair, add-board, 我的看板, and the search field. | 已完成 = `succeeded` + `failed` + `stopped`. 归档 is the other chip. Stop only for `queued` / `running` / `paused`. Archive only for terminal hot statuses. |

Screens that S2 and S4 add are hidden, with the existing unsupported copy, until `board.register` advertises `workspace.settings`, `board.settings`, and `archive.write`. That capability gate is unchanged. Multi-board itself does not wait for those capabilities.

## 7. Wave order

PR #16 is board-only (archived guards, archive cursor, settings facade). It does not change the phone session model. Do not add session-store commits to it.

Wave 2 (relay command allowlist, both dialers, 101) is unchanged and is still required before an APK **shows** settings, archive write, or workspace-scoped archive paging. It is not required for sessions, search, pills, or the continue composer.

Do not ship a Compose PR that still has one `token`, one `OkHttpRelay` socket, `ws_$boardId`, and `openBoard` resetting `lane`. That APK would mark S1–S4 done on assumptions this plan removes, and the next PR would break them.

Phone release branch, one install, after this plan is reviewed:

1. Pure functions and store tests: session id, migration, re-pair, shared credential, forget, `linkPill` with a fake clock, search, switch reducer. No UI dependency.
2. Credential sockets and per-session reducers, wired so the app no longer calls the single-token path.
3. Compose IA on that store: list switcher, 我的看板, add, search, then the S1–S4 order already listed in the Make UI plan (chips, turns, settings, create and continue).

Steps 1–3 can be separate commits. They are one release. Do not tag an APK, and do not idle-sync the ThinkBook, between them.

Base that branch on `main` after #16 merges if the branch also contains settings commands. Session and search work have no file overlap with #16 and can be written against current `main`; rebase onto the facade before adding settings DTOs. Wave 2 can merge in parallel.

Then the existing tail: sol code review, idle ThinkBook sync and 101 **only** for the command-allowlist delta already listed in the Make UI plan, then install. Multi-board adds nothing to that deploy table.

An APK built from this branch talks to today’s relay for pair, hello, list, subscribe, and the commands that already exist. Pointed at a board without the new capabilities, settings and archive write show the unsupported copy. That is the same mixed-version rule as the Make UI plan.

## 8. Acceptance

| Id | Done when | Proof |
| --- | --- | --- |
| M1 session | Refresh keeps `sessionId`. Two sessions can share an origin. Two sessions can share a `boardId` on different origins and not share tasks or `ws_` selection. Re-pair updates the token and leaves one card. A pair code with two `boardIds` stores one secret and two sessions. The 21st add does not `POST`. | JVM tests on the store and the pair-result reducer. Migration test: legacy token becomes sessions after a fixture `board.list`, and `ws_$boardId` moves when the id is unique. |
| M2 forget | Non-active forget keeps the active session. Active forget selects the first remaining id, clears detail, restores workspace, clears search, keeps the 筛选 chip, and the screen is the task list. The only session has forget disabled. Failed add does not change the active id. Forgotten session receives no notification. | Reducer tests. One instrumented test that the forget control is disabled at count 1. |
| M3 switch | After switch, visible tasks and detail belong to the new session. A late detail ack from the old session does not open a card. Chip value is the pre-switch value when the new snapshot has no row in that bucket. Search query is empty. Settings ack for the old session does not toast and does not fill the new form. | Protocol tests with two views and a shared `boardId`. |
| M4 search | `Qt` matches `qt` and a path segment. Pinyin input does not match a Chinese name unless the characters themselves are present. Zero workspaces show `此看板暂无工作区` even with a query. A miss shows `无匹配工作区`. Picking a row and editing the query leave the chip enum unchanged. | JVM tests. Manual: IME open, last row reachable, font scale ≥ 1.3. |
| M5 presence | `linkPill` is 已连接 only inside the 60s window with `online: true` and a clean snapshot. A fake clock at +61s demotes 已连接 to 弱连接. `online: false` is 离线. Cache copy is selected only when that session’s `sawSnapshot` is true. A missing `boardId` on an event is not applied when the socket has two sessions. | JVM tests. Manual matrix in §4. Logcat of that run contains no `dt_` and no `pc_`. |
| S1–S4 | Unchanged proofs in `docs/apk-make-ui-plan.md`, executed on a phone that already has two sessions. Continue on board A does not append a turn on board B. | Existing protocol tests plus one two-session continue test. |

## 9. Phone file map (implementation PR, not this one)

| Area | Files |
| --- | --- |
| Session catalog, migration, forget, search, `linkPill` | `android/protocol/...` new unit tests next to `ProtocolTest.kt`. `SessionStore.kt` grows the catalog; tokens remain encrypted. |
| Sockets | `OkHttpRelay.kt`: a socket map. `openSocket` must not close every other credential. |
| Apply path | `BoardViewModel.kt`: per-session reducers, per-credential reconnect, `board.list` timer, session id on every inflight. Delete the single `token` field as the source of truth. |
| IA | `Screens.kt`, `Copy.kt`, `values/strings.xml`, `values-zh/strings.xml`. List header: display name, chevron, connection words. Grid opens 我的看板. Gear and filter as in §3. |
| Notify | `DoneNotifier.kt`: title includes the session display name. Dedupe key stays `eventId`. |

Board, `relay/`, and `connector/` are untouched by the implementation of this plan.

## 10. Risks

1. **Shared credential is weaker than R2’s ideal.** Forgetting one of two sessions that share a token does not revoke the other board, and the relay will keep sending that board’s events to the socket. The phone drops them. Independence holds when operators mint one-board pair codes. The add flow cannot enforce that; the pair response is the authority.
2. **No presence push.** A crashed board stays 已连接 until the next `board.list` (15s in the foreground, or immediately if a command fails with `board_offline` / `board_disconnected`). The stamp is part of the pill text so the lag is visible.
3. **Background.** Without a foreground service, Doze can freeze sockets. Resume must demote stale 已连接 before paint. This wave does not add a service.
4. **Residual `sub.logs`.** Closing detail does not unsubscribe. The tail is capped and scoped to the session. A relay unsubscribe is out of scope.
5. **`sameBoard` today treats a missing `boardId` as local.** Multiplexing makes that a cross-board apply. The implementation drops those frames when the credential has more than one session. If a production dialer omits `boardId` on a required event, report it; do not paper over it by painting the frame on the active session.
6. **Relay restart** drops every in-memory token. Each credential on that origin shows 需要重新配对. Sessions on another origin stay. The phone does not delete the catalog on one 401; the user re-pairs that origin, which hits the re-pair rule in §2.
7. **Settings have no revision token** (Make UI plan risk 5). Two phones can still overwrite one board. Session switching does not add a conflict dialog.
8. **Minimum one board** means the user cannot reach a signed-out phone except by uninstall or by keystore loss. Add the replacement board before forgetting the old one.

## Out of scope

Mac board install and systemd. New relay or board HTTP fields, including phone revoke, display name on the wire, presence push, and log unsubscribe. Cross-board task search, pinyin, a merged inbox. Disk cache of tasks. Foreground service. Push, widgets, tablet layout. Editing the Make file. Idle-sync or 101 redeploy caused by this feature. Shipping the APK before the sol code review of the implementation.
