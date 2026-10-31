# Agent Board for Android

Kotlin and Jetpack Compose phone for the agent-board relay. The app speaks protocol v1 and never dials the ThinkBook board on `127.0.0.1:8791`.

Pairing is required. The WebSocket stays closed until `POST /auth/pair` returns a device token, and that token is stored in `EncryptedSharedPreferences`. The relay URL and device name are ordinary preferences.

The default relay URL is the placeholder `https://relay.mengfei.tech` (`wss://relay.mengfei.tech/v1/ws`). It is not deployed by this repo. For a relay on the same computer as an emulator, use `http://10.0.2.2:8787`. Cleartext HTTP is allowed so a local relay works. A phone on the LAN should use the computer's address, not the phone's own loopback.

## Pair

1. Start the relay and create a one-time code:

```bash
curl -s -X POST http://127.0.0.1:8787/auth/pair/create \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"boardIds":["thinkbook-main"]}'
```

2. Install the debug APK. On the pair screen, set the relay HTTP URL. The WebSocket URL is derived (`http` becomes `ws`, `https` becomes `wss`, path `/v1/ws`).
3. Enter the `pc_…` pair code and a device name. Pair stores the device token and only then sends `client.hello`.
4. Pick a board. The phone sends `sub.tasks` and `sub.logs`.
5. The task list follows the web board: pick one workspace and only that workspace's tasks are shown. The header is the workspace name and path. Tasks with no `workspaceId`, or an id the snapshot does not list, stay under 「未分配」. Detail shows 工作区. New task copies the selected workspace path, and sends `workspaceId` while the path still matches.
6. 新建工作区 sends `cmd.workspace.create` (`name` + absolute `path`). 删除 asks for the same confirmation as the web board, then `cmd.workspace.delete`. The board still refuses the default workspace and any workspace that still has tasks. Switching workspaces is local; it is not a relay frame.
7. Task detail matches the web popup: 任务信息, 继续会话 (copy), 工作区, prompt/reply rounds, side jobs, error text, 停止, and 继续任务 with an optional prompt. Opening the screen sends `cmd.detail`. Snapshots only carry short previews; a later snapshot does not wipe a full card already loaded. Delete, archive, and draft start stay on the web board.
8. Create needs a title, prompt, agent (`pi`, `claude`, `cursor`, `devin`, or `codex`), and a local `cwd`. When that cwd is a git workspace root in a fresh snapshot, the create screen can start the task in a git worktree. The checkbox is off by default and stays disabled while the list is stale or the relay is disconnected.

Settings can change the relay URL, refresh the device token (`POST /auth/refresh` drops the old socket), or forget the phone.

Commands use one idempotency key per attempt. `accepted` waits. `executed` is the board ack, not completion. `timeout` or a stored `failed` sends `cmd.lookup` and does not send `cmd.create` again. `board_offline` did not consume the key, so a later tap reuses it. After a create times out, "Check stored result" only looks the key up. "Start a different command" is explicit and mints a new key. Stop and Continue can send a new command only from "Send a new stop" / "Send a new continue" after lookup.

`evt.task.done` posts one notification per `eventId` on the `task_done` channel while the socket is online. The dedupe set lasts for the signed-in session, including a switch to another board. `evt.gap` keeps the list marked stale until a recovery snapshot covers that gap or a snapshot arrives on a new board generation. A log, task update, completion, or the cached snapshot replayed with the gap does not clear it, and the phone subscribes again. A dropped socket looks up an in-flight command instead of sending it again.

## Build

JDK 17 or newer and Android SDK 35.

```bash
export ANDROID_HOME="$HOME/android-sdk"   # or sdk.dir in android/local.properties
cd android
./gradlew test assembleDebug
```

JVM tests live in `protocol/` and do not need a device. They cover pair parsing, snapshot and task apply, `eventId` dedupe, create payload, and the timeout lookup policy.

Debug APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` is machine-specific and is not committed. This tree does not publish to a store.

Release builds are unsigned. There is no keystore in the repo.

```bash
./gradlew :app:assembleRelease
```

The APK is `android/app/build/outputs/apk/release/app-release-unsigned.apk`.

## GitHub Release

Publishing a GitHub Release builds that unsigned APK and attaches it to the release.

1. Push the commit you want to ship.
2. On GitHub, open **Releases → Draft a new release**, choose or create a tag such as `v0.2.0`, and publish it.
3. `.github/workflows/release-apk.yml` runs on `release: types: [published]`. It sets up JDK 17 and Android SDK 35, then runs `./gradlew :app:assembleRelease` in `android/`.
4. The workflow uploads `agent-board-<tag>.apk` to that release with `GITHUB_TOKEN`.

`workflow_dispatch` builds the same APK and stores it as an Actions artifact. It does not attach a release asset.

No signing secrets are required. `ANDROID_KEYSTORE_*` is unused. Store signing is out of scope until a keystore is added on purpose.
