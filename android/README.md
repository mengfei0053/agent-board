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
3. Enter the `pc_…` pair code (46 characters) and a device name. The screen shows how many characters are present and does not send a short or overlong code. Pair stores the device token and only then sends `client.hello`. Unknown, expired, and used codes all surface as one invalid-or-expired message.
4. Pick a board. The phone sends `sub.tasks` and `sub.logs`.
5. The task list follows the web board: pick one workspace and only that workspace's tasks are shown. The header is the workspace name and path. The search field under the status chips filters those tasks by title, id, prompt, or promptPreview. It does not filter workspace names or paths, and switching workspace clears it. Tasks with no `workspaceId`, or an id the snapshot does not list, stay under 「未分配」. Detail shows 工作区. New task copies the selected workspace path, and sends `workspaceId` while the path still matches. 我的看板 can add a board or forget one on this phone only. The last paired board cannot be forgotten. Cards say 「本机会话已保存」 and do not show a token prefix.
6. 新建工作区 sends `cmd.workspace.create` (`name` + absolute `path`). 删除 asks for the same confirmation as the web board, then `cmd.workspace.delete`. The board still refuses the default workspace and any workspace that still has tasks. Switching workspaces is local; it is not a relay frame.
7. Task detail matches the web popup: 任务信息, 继续会话 (copy), 工作区, prompt/reply rounds, side jobs, error text, 停止, and 继续任务 with an optional prompt. Opening the screen sends `cmd.detail`. Snapshots only carry short previews; a later snapshot does not wipe a full card already loaded. Delete and draft start stay on the web board.
8. 归档 is a separate read-only page (`cmd.archive.list`) when the board advertises `archive.list`. It is not mixed into the hot snapshot. Opening an archived row sends `cmd.detail` and does not offer stop or continue. Archiving does not post a completion notification. Switching boards clears the previous detail and logs before the next snapshot arrives.
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

### Debug signing (in-place updates)

`assembleDebug` signs with the checked-in debug keystore `keystore/debug.keystore`. The path, alias (`androiddebugkey`), and passwords live in `gradle.properties` (`DEBUG_STORE_FILE`, `DEBUG_STORE_PASSWORD`, `DEBUG_KEY_ALIAS`, `DEBUG_KEY_PASSWORD`). Those passwords are the well-known Android debug password `android`. They are not a Play Store or release secret, and they are safe to commit for this sideload build.

A laptop and `.github/workflows/release-apk.yml` both use that file. The package stays `tech.mengfei.agentboard`, and successive debug APKs share one certificate, so a later build installs as an update.

Do not delete the keystore or point debug signing at `~/.android/debug.keystore`. Android Gradle Plugin creates that file per machine. On GitHub-hosted runners it is a new certificate every job. A different certificate cannot update the installed package.

Confirm an APK used this keystore:

```bash
apksigner verify --print-certs app/build/outputs/apk/debug/app-debug.apk
keytool -list -v -keystore keystore/debug.keystore -storepass android
```

Both must show the same SHA-256. For this keystore that fingerprint is:

```text
79:54:FA:E5:89:3D:51:99:57:02:53:51:D0:4B:2B:07:53:2D:0D:2F:E3:A9:2C:50:5B:65:D8:7F:EC:4C:83:1E
```

The certificate subject is `CN=Agent Board Debug, OU=Debug, O=Android, C=US`.

**One-time uninstall.** A phone that already has this package from an older CI runner, or from a laptop `~/.android/debug.keystore`, was signed with a different certificate. Android refuses the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, or a message that the package conflicts with an existing package). Uninstall Agent Board once, then install this APK. That uninstall clears app data. After it, later debug builds from this keystore update in place.

Release builds stay unsigned. There is no Play signing key in the repo.

```bash
./gradlew :app:assembleRelease
```

The APK is `android/app/build/outputs/apk/release/app-release-unsigned.apk`.

## GitHub Release

Publishing a GitHub Release builds a debug-signed APK and attaches it to the release. The workflow runs `./gradlew :app:assembleDebug`, which uses `keystore/debug.keystore` rather than a keystore generated on the runner. The APK has an APK Signature Block and can be sideloaded, and a later release can update the previous one. `assembleRelease` stays unsigned and is not what this workflow ships.

1. Push the commit you want to ship.
2. On GitHub, open **Releases → Draft a new release**, choose or create a tag such as `v0.2.0`, and publish it.
3. `.github/workflows/release-apk.yml` runs on `release: types: [published]` and on pull requests. It sets up JDK 17 and Android SDK 35, then runs `./gradlew :app:assembleDebug` in `android/`.
4. The workflow checks the APK with `apksigner` (API 30+), checks the signer SHA-256 matches `keystore/debug.keystore`, and uploads `agent-board-<tag>-<sha>-debug.apk` to that release with `GITHUB_TOKEN`. On `main`, the artifact name is `agent-board-<sha>-debug.apk`.

`workflow_dispatch` builds the same APK and stores it as an Actions artifact. It does not attach a release asset.

No release signing secrets are required. `ANDROID_KEYSTORE_*` is unused. Store signing is out of scope until a release keystore is added on purpose. The debug passwords in `gradle.properties` are debug-only. If the phone still has a build signed with a different debug certificate, uninstall once before installing this APK.
