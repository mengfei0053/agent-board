# APK multi-board sessions and workspace search — implementation plan

> **Superseded for the list field (2026-11-01).** The phone list’s main search is **task search inside the selected workspace** (title, id, prompt, promptPreview). It is not a workspace-name or path search. D5 below is historical for that field: do not wire `filterWorkspaces` to the list search box. Workspace chips stay the full selector and ignore the task query. Status chip, forget ≠ revoke, and the session model in this plan stay in force. Phone-only correction; `web/` is the ThinkBook board UI and is not an implementation reference for this search. There is no in-repo APK HTML prototype to align.

Status: **plan only**. No Compose, session-store, relay, or board code in this PR.

Design gate: **GO with conditions** (`agent-board-apk-multi-board-ws-search-sol`). D1–D11 and R1–R7 are accepted with the clarifications in that review. Plan gate: **GO with conditions** (`agent-board-apk-multi-board-ws-search-plan-sol`). **Plan-gate S1–S5 are binding.** They are must-fix before the sol code review. M1–M3 and L1–L3 are part of the implementation, not new product choices. The HTML prototype and the Make file (`https://www.figma.com/make/Mjku7xs8YBVvyRERhqUoCb`) are illustrative. `SCREENS.md` navigation that says forget lands on “列表或留在看板页” is closed by R7: forget of the current board returns to the **task list**.

Make UI S1–S4 in `docs/apk-make-ui-plan.md` stay in force. They are a different list from plan-gate S1–S5. This feature is a sub-item of that Make UI wave, not a second product. Protocol version stays **`v: 1`**. This plan adds no command, no capability, and no HTTP field.

Implementation of the phone work may start from this revision. Compose landing does not skip the sol code review. Settings and archive write still follow Make UI wave 2 and the deploy table in `docs/apk-make-ui-plan.md`. Phone-only multi-board does not waive those gates. This feature does not idle-sync the ThinkBook and does not redeploy 101.

Baseline: `origin/main` @ `2048662` (Make UI plan #15). Board wave 1 is the open PR [#16](https://github.com/mengfei0053/agent-board/pull/16) (`cursor/apk-make-board-wave1-c22f`). This plan does not edit that branch.

## Decisions locked here

1. The phone primary key for a paired board is a **local session id** minted on the phone (`nanoid`-style, stored, never derived). `(relayUrl, boardId, deviceToken)` is lookup material only. A token refresh must not create a new row.
2. Each successful pair stores the device token it actually received. The target operator practice is **one pair code bound to one `boardId`**, which the relay already supports. A pair code that returns several `boardIds` becomes several local sessions that **share one credential**. The phone cannot split that token.
3. The same normalized relay origin may hold many sessions. Display names may repeat. A card distinguishes them with the relay host and the `boardId`. The card never shows a pair code, a device token, or a prefix of either.
4. Forget deletes the local session (and the credential secret only when no remaining session uses it). Forget does not call revoke. The last remaining session cannot be forgotten. Zero sessions is only the unpaired empty state (fresh install, or secrets unreadable).
5. Switching the active session, and forgetting the current session, clear detail, restore that session’s last workspace if the snapshot still contains it, otherwise the first valid workspace, otherwise an empty state. The **筛选 chip** is unchanged. The workspace **search query** is cleared. The header **连接态** is the newly active session’s own pill.
6. Workspace search is a local, case-insensitive substring on **name or path** for the active session’s workspaces. No pinyin, no task search, no cross-board search. Search and workspace selection do not change the 筛选 chip.
7. Connection is simultaneous per credential: one WebSocket per stored credential, `sub.tasks` for every board still on that credential, `board.list` as the presence probe. The 筛选-chip sentence “状态 chip 不变” does not mean the connection pill is global. A build that leaves a non-active board painted 已连接 with no fresh proof is not this plan. `online: true` without a snapshot of that board generation is not 已连接.
8. Catalog commits follow plan-gate S1. A new secret is written first. The plain catalog commit is the cutover. Old secrets and legacy keys are deleted only after a parseable catalog no longer references them.
9. The relay’s 20 is a per-token `boardIds` cap. It is not a phone-wide session cap. The phone’s own cap and the one-time pair code follow plan-gate S2.

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
| Settings screen | Global relay URL, token refresh, “forget phone”, and it prints `deviceId`. | Not the Make gear or filter. Those are Make UI S2, scoped to the active session. |

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

### Catalog commit (plan-gate S1)

Encrypted prefs and plain prefs are two files. One `commit()` is atomic inside its own file and is not atomic across the pair. The cutover is a marked catalog, recovered on every launch.

Plain catalog, one `commit()`:

| Field | Role |
| --- | --- |
| `catalogVersion` | Integer, increases on every successful commit. |
| `commitState` | `committed` once the document below is complete. A crash cannot leave a committed catalog whose order, bindings, and active id disagree, because they are one plain commit. |
| `migrationState` | `pending` or `committed` (S5). |
| `order` | Every live `sessionId`, in forget-fallback order. |
| `sessions` | `sessionId`, `credentialId`, `boardId`, `displayName`, `createdAt`. |
| `activeSessionId` | Null only while migration is pending. Otherwise an id in `order`. |

Sequence for pair, re-pair, refresh token rotation, and forget:

1. **Stage the secret.** Encrypted `commit()` of the new credential. The committed catalog still names the old bindings and the old active id. Do not close an existing socket in this step.
2. **Commit the catalog.** One plain `commit()` of the full next document: order, every binding, active id, version, `commitState=committed`. This is the only step that changes which session is active.
3. **Drop unreferenced secrets.** After that catalog parses, delete encrypted credentials whose id appears nowhere in it, and delete legacy token keys only when S5 says the migration is committed. A credential that still has a session stays. Its socket stays.

Failure before step 2, in-process: the active session is unchanged, existing sockets stay open, and the staged secret is deleted if that encrypted `commit()` succeeds. Failure of the delete is recovered on the next launch. Failure after step 2 and before step 3: the new catalog is already in force; the next launch deletes secrets the catalog does not name. It must not delete a secret the catalog still names. Re-pair of one session on a shared credential is the case that used to delete a secret the other session still used.

Launch recovery:

- Secret file unreadable: unpaired empty state and the secure-storage banner. Plain session rows are not rendered as paired and are not connected.
- Catalog missing or not parseable, legacy token present: start S5. Do not invent an active id.
- Catalog committed: it is the source of truth for order, bindings, and active id. Encrypted credentials it does not name are deleted. Credentials it names are kept even if a previous run died during step 3.
- Catalog `migrationState=pending`: S5 retry. Do not skip `board.list` because the file exists.

Tests inject a crash or a failed `commit()` after each write, and again as a process restart, for: re-pair, forget of one session on a shared credential, and migration. Each case asserts the active id, which sockets would still be open in-process, and that a referenced secret is still present.

### Add

Form: 显示名 (required, 1–40, duplicates allowed), 中继 URL, 配对码. The pair-code field is masked. The length hint may stay. Logs, banners, and screenshots of error text must not contain the code or the token. `pairHttpFailure` already collapses unknown, expired, and used codes into one sentence; keep that. Rate limit stays its own sentence.

The relay deletes a pair code on the first successful `POST /auth/pair`. The phone does not automatically retry. A later local failure (capacity, catalog commit) must say the code was already consumed. The same code cannot be promised as a retry. An HTTP failure before success uses `pairHttpFailure` and does not claim the code was consumed.

Cutover is plan-gate S1, not “encrypt the token, then write the plain catalog” as two independent commits. On success the committed catalog switches to the first session this submit created or updated, clears detail and search, keeps the 筛选 chip, lands on the task list, and toasts `已切换到 {显示名}`. A failure before that catalog commit leaves the committed list, the active session, the chip, the search query, and existing sockets as they were. A half-parsed response is not inserted. The add form’s busy flag does not pause sockets that already exist.

For each `boardId` in a response that passes S2:

- Same normalized origin and same `boardId` already stored: **re-pair**. The new catalog binds that session to the new credential. Do not insert a second card.
- Otherwise mint one new `sessionId` and append it. Several new ids from one response share **one** new credential, in response order.

Closing the old credential’s socket, and deleting its secret, happen only after the catalog commit and only when that commit references it zero times (S1, S3).

### Phone cap and the relay cap (plan-gate S2)

| Cap | Meaning |
| --- | --- |
| Relay | At most 20 `boardIds` on **one** token. `normalizeBoardIds` rejects any other size. One pair response can therefore contain up to 20 ids. |
| Phone | At most 20 **local sessions** on the device. This is phone policy. The relay does not enforce it, and a phone total under 20 does not imply anything about a token’s `boardIds`. |

Precheck, before `POST`:

- Count is already 20 and the user is adding from the general add form: do not `POST`. Copy tells them to forget a board first (any session except when it is the only one). Freeing a slot is forget-then-add with a **new** pair code.
- Count is 20 and the user opened **重新配对** on an existing card: `POST` is allowed. The card’s `sessionId` is the only legal target.

After a successful HTTP pair, before the catalog commit, capacity is checked against the ids in the response:

- **Pure re-pair.** Every returned `boardId` already has a session on that normalized origin. Net new sessions = 0. Allowed at the cap. The 重新配对 path additionally requires that the ids match the targeted session’s origin and `boardId`. A response that contains any other id is not applied through that path.
- **Would exceed 20.** Includes 19 sessions and two new ids, and any mix of old and new ids whose net new count does not fit. Reject the **whole** response. Insert nothing. Do not rebind the overlapping ids. Erase the staged secret. Leave the committed catalog and the old sockets alone. Banner: the pair code was consumed, and the phone does not have room for every board in the response. The user frees a slot and obtains a new code.
- **Fits.** One catalog commit applies every id in the response. Do not insert a prefix and leave the rest, and do not leave the new secret without a catalog reference.

Tests cover the precheck, the post-response check, a mixed old/new response, a pure re-pair at the cap, and a consumed-code banner after a local reject.

### Re-pair and expiry

Refresh is per credential: `POST /auth/refresh`, encrypted `commit()` of the new token on that credential, then reconnect **that** socket. The relay’s `kickToken` drops the old socket. Other credentials stay up. A failed secret commit does not change the active session and does not close other credentials’ sockets. Refresh failure or `unauthorized` marks that credential 需要重新配对, closes its socket, and does not delete or retarget other sessions.

Show expiry as a time (`登录将于 {time} 失效`) with no token and no token prefix. `deviceId` stays off the board card. The current settings row that prints `deviceId` is removed from the board list.

### Forget

Forget is one S1 catalog commit. It removes that `sessionId` from the order and the session map. In the same user action, after the commit is durable, drop that session’s `ws_$sessionId`, settings drafts, archive cursor, and in-memory snapshot (L3). A late frame cannot rebuild them (S3).

| Action | Result |
| --- | --- |
| Forget a non-active session | Remove it. Active session, list screen vs detail, 筛选 chip, search query, and detail stay. If its credential still has another session, keep the secret and the socket. Ignore later frames for the removed session, including `evt.task.done` and leftover `sub.logs`. |
| Forget the active session, with others remaining | Remove it. The same catalog commit sets active to the first remaining id in the stored order. Clear detail and logs. Restore the new session’s workspace (§3). Clear search. Keep the 筛选 chip. Navigate to the **task list**, including when forget was confirmed on 我的看板. |
| Forget the only session | Control disabled. Copy explains that the phone keeps one paired board. Replacing it is add-then-forget. |
| Unpaired | Fresh install, or encrypted prefs unreadable. Empty guide and the pair form. Do not synthesize a board so the minimum-one rule looks satisfied. Plain-pref display names without a readable secret are not shown as paired. |

Forget does not `POST /auth/revoke/device`. Copy must not say the board or the relay session was revoked. The token remains valid on the relay until expiry, restart, or an admin revoke. After a local forget of the last session on a credential, this phone no longer has the secret.

There is no “forget phone” that wipes the last board. Keystore failure is the empty state above, not a forget action.

### Migration from the single token (plan-gate S5)

`migrationState` is `pending` or `committed`, stored in the plain catalog next to `commitState`.

1. Stage the legacy token as one credential (S1 secret write). Do not delete the legacy keys.
2. Commit a catalog with `migrationState=pending`, that `credentialId`, an empty session list, and no active session. This file existing is not a finished migration.
3. Connect and `board.list`. While the list has not succeeded, including across process death and including when the network is down, show `正在读取已配对看板` with pill 弱连接. Do not show the unpaired empty state. Do not invent a board id or a display name.
4. On list success, one catalog commit creates one `sessionId` per returned `boardId` (display name = `boardId`, order = list order), copies `ws_$boardId` to `ws_$sessionId` when that `boardId` appears once, sets `activeSessionId` to the first session, and sets `migrationState=committed`. A duplicate `boardId` across origins does not receive the legacy workspace value. A second list for the same pending credential reuses those `sessionId`s. It does not mint another set.
5. Delete the legacy single-token keys only after that committed catalog parses. A kill between step 4 and this delete: next launch sees `committed` plus leftover legacy keys, deletes the keys, and does not create sessions again.
6. A kill after step 2 and before a successful list: next launch sees `pending` and retries hello and `board.list`. It must not treat “a catalog file exists” as “migration is done” and skip the legacy token.

Unreadable encrypted prefs: unpaired empty state and the secure-storage banner. A pending catalog whose secret cannot be read is that empty state, not `正在读取` and not a row of plain-pref names.

## 3. Switch atomicity (D2, D4, D10, R5, R7)

The rendered list, detail, workspaces, archive page, and settings form are always the active `sessionId`. Background sessions keep their own `BoardView` so a later switch can show a snapshot, and so a live frame can update the card pill. Those views are not painted in the active list.

`openBoard` today is the wrong primitive (`lane = "active"`, one reducer, workspace key = `boardId`). The phone wave replaces it. `tasksAfterBoardSwitch` stays as a render guard and gains the session id: a view is visible only when its session id is the active one. Equal `boardId` strings on two sessions are not a match.

On **activate(session)**:

| Piece | Rule |
| --- | --- |
| Detail | `selectedTaskId` null, logs cleared from the UI, detail screen popped. In-flight `cmd.detail` / archive acks carry the session id they were sent for. An ack whose session is not active does not set the visible task and does not navigate. It may update that session’s background view. |
| Tasks | Visible rows come from the new session’s view only. Until its first snapshot, the list is loading or the offline empty state in §4, never the previous session’s cards. |
| Workspace | Remembered id is `ws_$sessionId`. Before a snapshot, keep it and do not persist a fallback (`nextWorkspaceSelection` already does this). After a snapshot, keep it when that id is still in the workspace list; otherwise `resolveWorkspaceSelection` on the **full** workspace list (first workspace that has tasks, then 「未分配」, then the first workspace). The search-filtered subset is not the candidate list (L1). Clear the query before that resolve. Zero workspaces → `null` and `此看板暂无工作区`. Do not invent a workspace named 默认. |
| 筛选 chip | Not written. A chip with no rows shows that chip’s empty copy (`此筛选下暂无任务`), including 归档. |
| Search | Query set to empty. |
| 连接态 | Header pill is `linkPill` of the new session (§4). |
| Toast | `已切换到 {显示名}` for a user switch. Forget uses the same switch without a second product rule. |
| Settings forms | Gear edits the active session’s **current workspace**. Filter edits the active session’s **board settings** (Make UI S2 documents, not a global app page). Leaving either form on a switch discards unsent edits the same way cancel does. A request already on the wire is tagged with the session id. Its ack updates that session only. It does not toast 已保存 on a different session and does not fill the new form. |
| Create / continue | The composer closes. A command already sent stays in that session’s inflight map. Completion navigation (open the new task, Make UI S4) runs only if that session is still active. |

Same workspace id on two boards is normal (`nanoid(10)` per board). Filtering is by session view, then workspace id inside that view.

Pending callbacks are routed by plan-gate S3, not by `boardId` alone. The relay idempotency key stays scoped to `boardId` + command type. The phone’s inflight map is keyed by `sessionId` + command + task id so one board’s lookup cannot settle another session.

### Frame routing (plan-gate S3)

Every socket callback closes over a `credentialId` and a `socketEpoch`. The epoch increments for each new socket on that credential, including reconnect and the socket opened after re-pair.

Each outgoing request records `ref → { sessionId, credentialId, boardId, command, taskId, socketEpoch }`.

On a frame:

| Frame | Apply when | Drop when |
| --- | --- | --- |
| Ack with `ref` | The map entry matches this callback’s `credentialId` and `socketEpoch`, and the session still binds to that credential and `boardId`. | The epoch or credential differs, the session was forgotten, or the session was rebound to another credential. An old ack does not open a card, toast, or navigate on the session that is on screen. |
| `evt.snapshot`, `evt.task`, `evt.gap`, `evt.log`, `evt.task.done` | `boardId` maps to a session that **still** binds to this socket’s credential, the id is in that credential’s hello `boardIds`, and this socket subscribed `sub.tasks` for it (logs: the stricter triple in M2). | Forgotten, rebound, or never subscribed. The same `boardId` on another origin is a different session and is not a match. |
| Event with no `boardId` | Credential has exactly one live session **and** the frame’s socket epoch is the current epoch. | Credential has two or more sessions. Also any frame whose epoch is not current, including the single-session case. |

Re-pair closes the old credential’s socket only when the committed catalog leaves that credential with zero sessions. When other sessions still use it, the socket stays, and frames for the rebound `boardId` are dropped on that old token. That includes `evt.task.done` and leftover `sub.logs`.

Tests: the same `boardId` on two origins; both tokens emitting during a same-origin re-pair; an old command ack while the UI has switched; `evt.task.done` after forget. None of those frames land on the new session.

「未分配」 remains a workspace row when **this** snapshot has tasks with a missing or unknown workspace id. It is not shared across sessions.

## 4. Connection model (R3, R4, D9)

Product intent is simultaneous observe. The implementation is:

- One OkHttp socket per credential (`wsUrl` + `credentialId`). `pingInterval` stays 30s. Reconnect backoff stays 1s, doubling, cap 15s, **per credential**. One credential’s backoff does not reset another’s.
- After hello: `board.list`, then `sub.tasks` for every `boardId` that still has a local session on that credential. Do not subscribe boards the user has forgotten.
- `sub.logs` is M2. `evt.task.done` is M3. Do not add an unsubscribe command.

### Pill (plan-gate S4)

`linkPill` is a pure function of socket phase, the last `board.list` entry that matched this socket’s request ref and epoch (M1), the generation rules below, token state, and `now`. The UI does not store a sticky “online” string.

A list entry with `online: true` is not a live list. The new board process can be registered and still have no snapshot. An older in-memory snapshot stays the cache copy for that session (`可能已过期`). It is not promoted to live rows.

Per session:

- Remember `appliedGeneration`, the generation of the snapshot that last cleared `needsResync`.
- A listed generation different from `appliedGeneration`, an `evt.gap`, or a snapshot that does not cover the gap (`snapshotStillStale`) sets `needsResync`.
- Clear `needsResync` only when a snapshot is applied whose generation is the current one and whose seq covers any open gap. A replay that is still stale leaves `needsResync` set.

While the process is in the foreground, schedule a clock tick at `lastProofAt + 60s` for each session that is currently 已连接. The tick runs when no frame arrives. It calls `linkPill` again. On resume, call `linkPill` with the current clock **before** the first frame is drawn, then take the M1 resume path. A stale `online: false` is not a fresh probe: after 60s without a new matching list, the pill is 弱连接 with `状态更新于 {time}`, not 离线 as if the list had just returned.

| Condition | Pill | Words (zh) |
| --- | --- | --- |
| Matching list ≤ 60s, `online: true`, snapshot applied for that generation, `needsResync` false, socket authenticated | 已连接 | 已连接 |
| Matching list ≤ 60s, `online: false`, socket authenticated | 离线 | 离线 |
| `online: true` but `needsResync` or no snapshot for this generation; socket connecting or reconnecting; no matching list yet; last 已连接 or 离线 proof older than 60s | 弱连接 | 弱连接，and `状态更新于 {time}` when a proof exists. No snapshot for this generation yet: 正在同步. Initial hello with no proof yet: 正在连接 |
| Hello or refresh returned `unauthorized` / `revoked` for this credential | 离线 | Banner 需要重新配对. The pill is still 离线, with that sentence, not a color by itself |

A dead board is not pushed. Presence is the existing `board.list` (M1):

- Send it on hello, on return to foreground (after the pre-paint recompute), immediately after `board_offline` or `board_disconnected` on that socket, and every 15s while the process is in the foreground and the socket is authenticated.
- `board_offline` / `board_disconnected` mark **that** session 离线 in the same state update. Other sessions on the credential keep their current proof until the follow-up list ref returns.
- One list per credential covers every board on that token, so a shared credential can show board A 已连接 and board B 离线.
- Stop the 15s timer when the process leaves the foreground. Do not take a wake lock and do not start a foreground service. Sockets stay open. If the system closes one, that credential’s pills become 弱连接 in the same state update that records the close.

The 15s poll is the lag bound only when no command error names the board. A sticky green with no timestamp is not this plan. Quiet `evt.task` does not by itself clear 已连接; the scheduled 60s tick and the list ref do.

JVM tests use a fake clock: +61s and no frames demotes 已连接; a generation change keeps the old snapshot on the cache sentence; a fresh `online: false` is 离线; a +61s offline proof becomes 弱连接; foreground, background, and a shared credential are all covered. Manual proof is the two-board matrix at the end of this section.

### Cache copy

The only cache in this wave is the in-memory `BoardView` for that `sessionId` after a snapshot has been applied in this process. There is no disk task cache. Process death means no cache.

| Situation | List body |
| --- | --- |
| 已连接 | Live rows from the snapshot whose generation cleared `needsResync`, for the active workspace and 筛选 chip. No cache sentence. |
| 离线 or 弱连接, and this session has a snapshot | Rows from that snapshot, including a snapshot from an older generation. Sentence `看板离线 · 显示本地缓存 · 可能已过期` or `连接不稳定 · 显示本地缓存 · 可能已过期`, plus the snapshot time. |
| 离线 or 弱连接, and this session has no snapshot | `无法加载，暂无离线数据`. Do not copy another session’s tasks, workspaces, or archive page. |
| Snapshot with zero workspaces | `此看板暂无工作区`, which wins over the search-miss sentence and over the cache sentence’s task list. |

Writes follow reachability. Create, continue, stop, workspace create/delete, and settings save are disabled when the pill is 离线, when the proof is older than 60s, when the token needs re-pair, or when the socket is not authenticated. The control’s reason is the pill sentence. When the socket is authenticated, the matching list is inside 60s and says `online: true`, and the pill is 弱连接 only because of `needsResync`, the command may be sent; failure shows `err.message` and does not toast 已保存 or 已创建. `board_offline` stays a real error. Disabled archive when the capability is missing stays the current copy `此看板暂不支持归档浏览`.

### Power and the test that rejects a fade

Accepted cost: one socket per credential (the phone session cap in S2 bounds how many of those exist), one 30s ping each, one `board.list` per 15s per socket in the foreground, task snapshots for subscribed boards, logs for one open task. `WS_MESSAGES_PER_SEC` is 40 per socket. A list every 15s is inside that budget. If a many-board snapshot stream hits `rate_limited`, report it. The response is not to drop background `sub.tasks` and freeze the last pill.

Manual proof, two boards, same relay, two one-board pair codes:

1. Stop one board process. Within one poll (15s) that card is 离线 with the offline sentence, and the other card stays 已连接.
2. Stop the relay. Both pills become 弱连接. Neither still reads 已连接 after 60s without a list.
3. Kill the app process, reopen offline. Copy is `无法加载，暂无离线数据`, not `显示本地缓存`.
4. Switch to the offline board after it has had a snapshot this process. Detail is gone, its tasks (if any) show the cache sentence, the other board’s tasks are absent, the 筛选 chip is the one from before the switch.

A build that tracks only the active socket and leaves the other card on the last 已连接 fails this plan even if the UI has a switcher.

## 5. Workspace search (D5, D6, D7, R6)

**Not the list field.** D5 described a workspace-name/path query inside the workspace selector. That list behavior is superseded by task search (see the note at the top of this file). `filterWorkspaces` may remain as a helper; the task-list search box must not call it. Picking a workspace clears the task query and keeps the status chip.

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
| User switches session or forget lands on another session | Query cleared, then the workspace is chosen with `resolveWorkspaceSelection` on the full list (L1), not from the filtered rows | unchanged |

Gear (workspace settings) and 新建任务 are disabled when the active session has no workspace, with `此看板暂无工作区`. Filter (board settings) stays available; it is the board document. Workspace paths wrap. The selector scrolls above the IME (`imePadding`, same inset rule as Make UI S4).

A board card shows the relay host and the **full** `boardId`. On a narrow width the subtitle wraps or expands. It is not ellipsized into a prefix. The header may ellipsize the display name. No pair code, device token, or prefix of either is shown (L2). Each card has 重新配对, which is the S2 path that may `POST` while the phone is at 20 sessions and may update only that card’s session.

## 5a. M1–M3 and L1–L3

These are implementation requirements from the plan gate. They are not new product choices and they do not reopen D1–D11.

| Id | Contract |
| --- | --- |
| M1 | Apply `board.list` only when `payload.ref` is this credential’s outstanding list id and the socket epoch matches. Ignore any other ack that happens to contain `boards`. Stop the 15s poll in the background. On resume, recompute pills before paint; if the socket is up, send `board.list` and do not paint 已连接 until that ref returns; if it is down, connect, and 已连接 waits for the new epoch’s list. `board_offline` / `board_disconnected` mark that board 离线 in the same update. |
| M2 | A log subscription is the tuple `(credentialId, boardId, taskId, socketEpoch)`. `evt.log` appends to the capped tail (200) only when the tuple matches. Clearing detail clears the tuple and drops later log frames. Do not send `sub.logs` without `taskId`. The hub treats a missing task id as every log on that board, which is not a cancel. |
| M3 | On `evt.task.done`, resolve the session from this credential and `boardId`. If none still binds, drop the event and do not claim `eventId`. Claim `eventId` only after that resolve, then notify. The title includes the display name. The click handler resolves `sessionId` again. A forgotten session does not open detail. |
| L1 | Workspace restore uses `resolveWorkspaceSelection` on the full snapshot list. Search results are not candidates. |
| L2 | Host + full `boardId`, wrap or expand. No token prefix. |
| L3 | Forget clears `ws_$sessionId`, settings drafts, the archive cursor, and the in-memory snapshot for that session. |

## 6. Make UI S1–S4 that this wave must not reopen

`docs/apk-make-ui-plan.md` is the contract for continue, settings, turns, archive, create, and insets. Apply it inside the active session.

| Gate | What changes because there are many sessions | What stays |
| --- | --- | --- |
| S1 继续 | Composer and `cmd.continue` use the active session’s task and that session’s `quickPrompts` from its own `cmd.settings.get`. A prompt typed on board A is not sitting in board B’s composer after a switch. | Non-blank `prompt` always sent. No hardcoded `请基于当前上下文继续完成任务` from the phone. Failure keeps the text. Queued, running, and archived have no composer. |
| S2 settings | Gear = active workspace. Filter = active board. Save and the 已保存 toast are tied to that session id. Proxy values are not logged and are not stored in the session catalog. | Real `GET`/`PUT` documents. No default-model field. No fake MCP connection. `clear: true` is not sent. Failed save keeps edits. |
| S3 turns | Detail unmounts on switch. Reconnect merge (`mergeRelayTask`) runs inside that session’s reducer. | Server turns, hole heading, logs are not the reply, tool chips only from `sideJobs`. |
| S4 chips and insets | `openBoard` must not reset the chip to 进行中 or 全部. Create still does not change the chip. Insets cover list, detail, both settings screens, create, continue, pair, add-board, 我的看板, and the search field. | 已完成 = `succeeded` + `failed` + `stopped`. 归档 is the other chip. Stop only for `queued` / `running` / `paused`. Archive only for terminal hot statuses. |

Screens that Make UI S2 and S4 add are hidden, with the existing unsupported copy, until `board.register` advertises `workspace.settings`, `board.settings`, and `archive.write`. That capability gate is unchanged. Multi-board itself does not wait for those capabilities. Wave 2 is still required before those screens ship. Phone-only sessions do not waive it.

## 7. Wave order

PR #16 is board-only (archived guards, archive cursor, settings facade). It does not change the phone session model. Do not add session-store commits to it.

Wave 2 (relay command allowlist, both dialers, 101) is unchanged and is still required before an APK **shows** settings, archive write, or workspace-scoped archive paging. It is not required for sessions, search, pills, or the continue composer.

Do not ship a Compose PR that still has one `token`, one `OkHttpRelay` socket, `ws_$boardId`, and `openBoard` resetting `lane`. That APK would mark Make UI S1–S4 done on assumptions this plan removes, and the next PR would break them.

Phone release branch, one install. Plan-gate S1–S5 are must-fix in that branch before code review:

1. Pure functions and store tests: S1 commit/recovery, S2 cap and consumed code, S5 pending migration, forget, `linkPill` with a fake clock, search, switch reducer. No UI dependency.
2. Credential sockets and per-session reducers (S3, S4, M1–M3), wired so the app no longer calls the single-token path.
3. Compose IA on that store: list switcher, 我的看板, add, search, then the Make UI S1–S4 order (chips, turns, settings, create and continue).

Steps 1–3 can be separate commits. They are one release. Do not tag an APK, and do not idle-sync the ThinkBook, between them.

Base that branch on `main` after #16 merges if the branch also contains settings commands. Session and search work have no file overlap with #16 and can be written against current `main`; rebase onto the facade before adding settings DTOs. Wave 2 can merge in parallel.

Then the existing tail: **sol code review after Compose lands**. Do not skip it. Idle ThinkBook sync and 101 happen **only** for the command-allowlist delta already listed in the Make UI plan. Multi-board adds nothing to that deploy table and does not waive wave 2 for settings or archive write.

An APK built from this branch talks to today’s relay for pair, hello, list, subscribe, and the commands that already exist. Pointed at a board without the new capabilities, settings and archive write show the unsupported copy. That is the same mixed-version rule as the Make UI plan.

## 8. Acceptance

Plan-gate rows are must-fix before code review. Product rows stay. Make UI S1–S4 are the other document’s ids.

| Id | Done when | Proof |
| --- | --- | --- |
| Plan-gate S1 | A crash after the secret write and before the catalog commit leaves the old active id and, in-process, the old sockets. A crash after the catalog commit deletes only unreferenced secrets. Re-pair of one session on a shared credential does not delete the secret the other session uses. Unreadable secrets do not render plain rows as paired. | Injected `commit()` failure and process restart at each write, for re-pair, shared-credential forget, and migration. |
| Plan-gate S2 | 19 sessions and a two-id response insert nothing, erase the staged secret, and say the code was consumed. At 20 sessions the general add does not `POST`. 重新配对 of the targeted card is allowed only when the response is that card’s origin and `boardId`. A mixed old/new response that does not fit is rejected whole. | Precheck test, post-response test, mixed-id test, pure re-pair at the cap. |
| Plan-gate S3 | Frames carry the callback’s `credentialId` and `socketEpoch`. A missing `boardId` is dropped when the credential has two sessions, and dropped across epochs when it has one. Re-pair masks the old token’s fanout for the rebound board, including done and logs, while a shared credential’s socket stays up. | Same `boardId` on two origins. Dual-token events during re-pair. Old ack during switch. Done after forget. |
| Plan-gate S4 | 已连接 requires a matching list inside 60s, `online: true`, and a snapshot of that generation with `needsResync` clear. An older snapshot stays on the cache sentence. A foreground tick at +61s with no frames demotes 已连接. A +61s offline proof is 弱连接, not a fresh 离线. Resume recomputes before paint. | Fake clock. Generation change. Board offline. Foreground and background. One credential and a shared credential. Manual §4 matrix. |
| Plan-gate S5 | `migrationState=pending` retries `board.list` after restart and does not skip because a catalog file exists. Offline launch shows `正在读取已配对看板`. One successful list creates each `sessionId` once. Legacy keys are deleted only after the committed catalog. A second list does not mint new ids. Unreadable encryption is the unpaired empty state. | Offline start. Kill before list success. Kill after catalog commit and before legacy delete. Unreadable secret file. |
| M1–M3, L1–L3 | The behaviors in §5a. | The S3/S4 tests plus a list ack with the wrong ref, a bare `sub.logs` that must not be sent, done dedupe that does not claim a forgotten session, click-time resolve, workspace restore ignoring a search hit, and forget clearing `ws_$sessionId`, drafts, archive cursor, and the memory snapshot. |
| P1 session | Refresh keeps `sessionId`. Two sessions can share an origin. Two sessions can share a `boardId` on different origins and not share tasks or `ws_` selection. Re-pair updates the token and leaves one card. A pair code with two `boardIds` stores one secret and two sessions. | JVM tests on the store and the pair-result reducer. |
| P2 forget | Non-active forget keeps the active session. Active forget selects the first remaining id, clears detail, restores workspace, clears search, keeps the 筛选 chip, and the screen is the task list. The only session has forget disabled. Failed add does not change the active id. Forgotten session receives no notification. | Reducer tests. One instrumented test that the forget control is disabled at count 1. |
| P3 switch | After switch, visible tasks and detail belong to the new session. A late detail ack from the old session does not open a card. Chip value is the pre-switch value when the new snapshot has no row in that bucket. Search query is empty. Settings ack for the old session does not toast and does not fill the new form. | Protocol tests with two views and a shared `boardId`. |
| P4 search | `Qt` matches `qt` and a path segment. Pinyin input does not match a Chinese name unless the characters themselves are present. Zero workspaces show `此看板暂无工作区` even with a query. A miss shows `无匹配工作区`. Picking a row and editing the query leave the chip enum unchanged. | JVM tests. Manual: IME open, last row reachable, font scale ≥ 1.3. Card subtitle shows the full `boardId` at that font scale. |
| P5 presence | Manual matrix in §4. Logcat of that run contains no `dt_` and no `pc_`. | Device or emulator, two boards. |
| Make UI S1–S4 | Unchanged proofs in `docs/apk-make-ui-plan.md`, executed on a phone that already has two sessions. Continue on board A does not append a turn on board B. | Existing protocol tests plus one two-session continue test. Settings and archive write still require wave 2. |

## 9. Phone file map (implementation PR, not this one)

| Area | Files |
| --- | --- |
| Session catalog, migration, forget, search, `linkPill` | `android/protocol/...` new unit tests next to `ProtocolTest.kt`. `SessionStore.kt` grows the catalog; tokens remain encrypted. |
| Sockets | `OkHttpRelay.kt`: a socket map. `openSocket` must not close every other credential. |
| Apply path | `BoardViewModel.kt`: per-session reducers, per-credential reconnect, `board.list` by ref and epoch, session id on every inflight. Delete the single `token` field as the source of truth. |
| IA | `Screens.kt`, `Copy.kt`, `values/strings.xml`, `values-zh/strings.xml`. List header: display name, chevron, connection words. Grid opens 我的看板. Gear and filter as in §3. Card subtitle wraps the full `boardId`. |
| Notify | `DoneNotifier.kt`: resolve the session, then claim `eventId`. Title includes the display name. The click resolves `sessionId` again. |

Board, `relay/`, and `connector/` are untouched by the implementation of this plan.

## 10. Risks

1. **Shared credential is weaker than R2’s ideal.** Forgetting one of two sessions that share a token does not revoke the other board, and the relay will keep sending that board’s events to the socket. The phone drops them. Independence holds when operators mint one-board pair codes. The add flow cannot enforce that; the pair response is the authority.
2. **No presence push.** An idle crashed board stays 已连接 until the next `board.list` (15s in the foreground). A command error `board_offline` / `board_disconnected` marks that board 离线 immediately. The stamp is part of the pill text so the lag is visible. A proof older than 60s is not shown as a fresh 离线 or 已连接.
3. **Background.** Without a foreground service, Doze can freeze sockets. The 15s poll stops in the background. Resume recomputes before paint, then refreshes the list or reconnects (M1). This wave does not add a service.
4. **Residual `sub.logs`.** The relay has no unsubscribe. Closing detail clears the local tuple and drops further lines (M2). It does not send a bare `sub.logs`. The tail stays capped. A relay unsubscribe is out of scope.
5. **`sameBoard` today treats a missing `boardId` as local.** A multi-session credential drops those frames. A single-session credential applies one only on the current socket epoch (S3). If a production dialer omits `boardId` on a required event, report it. Do not paint that frame on a different epoch or a different session.
6. **Relay restart** drops every in-memory token. Each credential on that origin shows 需要重新配对. Sessions on another origin stay. The phone does not delete the catalog on one 401; the user re-pairs that origin, which hits the re-pair rule in §2.
7. **Settings have no revision token** (Make UI plan risk 5). Two phones can still overwrite one board. Session switching does not add a conflict dialog.
8. **Minimum one board** means the user cannot reach a signed-out phone except by uninstall or by keystore loss. Add the replacement board before forgetting the old one.

## Out of scope

Mac board install and systemd. New relay or board HTTP fields, including phone revoke, display name on the wire, presence push, and log unsubscribe. Cross-board task search, pinyin, a merged inbox. Disk cache of tasks. Foreground service. Push, widgets, tablet layout. Editing the Make file. Idle-sync or 101 redeploy caused by this feature. Shipping the APK before the sol code review of the implementation.
