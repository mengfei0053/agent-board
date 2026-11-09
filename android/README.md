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

2. Install the release APK (or a local debug APK for development). On the pair screen, set the relay HTTP URL. The WebSocket URL is derived (`http` becomes `ws`, `https` becomes `wss`, path `/v1/ws`).
3. Enter the `pc_…` pair code (46 characters) and a device name. The screen shows how many characters are present and does not send a short or overlong code. Pair stores the device token and only then sends `client.hello`. Unknown, expired, and used codes all surface as one invalid-or-expired message.
4. Pick a board. The phone sends `sub.tasks` and `sub.logs`.
5. The task list follows the web board: pick one workspace and only that workspace's tasks are shown. The header is the workspace name and path. The search field under the status chips filters those tasks by title, id, prompt, or promptPreview. It does not filter workspace names or paths, and switching workspace clears it. Tasks with no `workspaceId`, or an id the snapshot does not list, stay under 「未分配」. Detail shows 工作区. New task copies the selected workspace path, and sends `workspaceId` while the path still matches. 我的看板 can add a board or forget one on this phone only. The last paired board cannot be forgotten. Cards say 「本机会话已保存」 and do not show a token prefix.
6. 新建工作区 sends `cmd.workspace.create` (`name` + absolute `path`). 删除 asks for the same confirmation as the web board, then `cmd.workspace.delete`. The board still refuses the default workspace and any workspace that still has tasks. Switching workspaces is local; it is not a relay frame.
7. Task detail matches the web popup: 任务信息, 继续会话 (copy), 工作区, prompt/reply rounds, side jobs, error text, 停止, and 继续任务 with an optional prompt. Opening the screen sends `cmd.detail`. Snapshots only carry short previews; a later snapshot does not wipe a full card already loaded. Delete and draft start stay on the web board.
8. 归档 is a separate read-only page (`cmd.archive.list`) when the board advertises `archive.list`. It is not mixed into the hot snapshot. Opening an archived row sends `cmd.detail` and does not offer stop or continue. Archiving does not post a completion notification. Switching boards clears the previous detail and logs before the next snapshot arrives.
8. Create needs a title, prompt, agent (`pi`, `claude`, `cursor`, `devin`, `codex`, or `kimi`), and a local `cwd`. When that cwd is a git workspace root in a fresh snapshot, the create screen can start the task in a git worktree. The checkbox is off by default and stays disabled while the list is stale or the relay is disconnected.

Settings can change the relay URL, refresh the device token (`POST /auth/refresh` drops the old socket), or forget the phone.

Commands use one idempotency key per attempt. `accepted` waits. `executed` is the board ack, not completion. `timeout` or a stored `failed` sends `cmd.lookup` and does not send `cmd.create` again. `board_offline` did not consume the key, so a later tap reuses it. After a create times out, "Check stored result" only looks the key up. "Start a different command" is explicit and mints a new key. Stop and Continue can send a new command only from "Send a new stop" / "Send a new continue" after lookup.

`evt.task.done` posts one notification per `eventId` on the `task_done` channel while the socket is online. The dedupe set lasts for the signed-in session, including a switch to another board. `evt.gap` keeps the list marked stale until a recovery snapshot covers that gap or a snapshot arrives on a new board generation. A log, task update, completion, or the cached snapshot replayed with the gap does not clear it, and the phone subscribes again. A dropped socket looks up an in-flight command instead of sending it again.

## Connection recovery

「正在同步」means the relay reports the board online but the phone is still waiting for a complete snapshot of the current board generation. Cached pre-gap snapshots do not make the data current. The app shows the last receive time in local `HH:mm:ss` and offers 「重新连接」 without deleting pairing or resending task commands.

Foreground status polling starts after authentication (including cold starts and reconnects), every 15 seconds. A status request with no reply triggers a reconnect after 15 seconds; an unfinished connection/authentication attempt is retried after 20 seconds. Healthy subscriptions are not replayed on every poll. Gap recovery subscriptions are limited to once per board per 15 seconds.

A persistent `seq_gap` also requires a healthy board-to-relay stream: update the desktop board connector as well as the APK. The connector re-registers after a sequence/generation mismatch to publish a new baseline. Continuing a task and completing it again now uses a distinct completion event ID, avoiding a dropped sequence during relay deduplication. Restart the desktop service only when it is safe for running tasks.

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

Local debug builds and pull-request CI both use that file. Published releases use a separate private production key. The package stays `tech.mengfei.agentboard`, and successive debug APKs share one certificate, so a later build installs as an update.

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

### Production release signing

Release builds require a separate private keystore. There is no production private key in Git, and release builds fail without complete signing configuration rather than shipping an unsigned APK or falling back to the public debug key.

Set these environment variables from your secure local credential store (never commit their values):

- `ANDROID_RELEASE_STORE_FILE`: absolute path to the production keystore.
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

```bash
./gradlew :app:testReleaseUnitTest :protocol:test :app:assembleRelease
```

The signed APK is `android/app/build/outputs/apk/release/app-release.apk`. Release is non-debuggable; shrinking is currently disabled. This is a signed production build for sideloading, not a Play Store publishing integration.

**Migration from 1.0.0/debug:** the production certificate differs from the public debug certificate. Android normally refuses an in-place update from the old debug build. Back up anything needed, uninstall the debug app, install the production APK, and pair again. Uninstalling clears local app data. Subsequent production builds signed with the same production key can update in place; `versionCode` must increase for each new version.

Back up both the private keystore and its passwords in a secure off-machine location. GitHub Secrets cannot be used to retrieve them later, and losing the signing key prevents normal updates to installed production apps.

## GitHub Release

Production release signing requires these repository Secrets:

- `ANDROID_RELEASE_KEYSTORE_BASE64`: base64-encoded production keystore.
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

Also configure the repository variable `ANDROID_RELEASE_CERT_SHA256` with the expected public certificate SHA-256 fingerprint (colon-separated or plain hex). The workflow checks the APK against this independently configured fingerprint. Never store private keys or passwords in repository variables.

1. Update `versionName` in `app/build.gradle.kts` to the intended tag (an optional `v` prefix on the tag is accepted), and increase `versionCode`.
2. Push the verified commit and tag, then publish a GitHub Release for that tag. Pushing a tag alone does not trigger this workflow.
3. `.github/workflows/release-apk.yml` runs `:app:testReleaseUnitTest :protocol:test :app:assembleRelease` with the production key decoded only under the temporary runner directory, then removes the keystore when the build step exits.
4. Before uploading, the workflow verifies the APK signature (API 30+), production certificate fingerprint, non-debuggable flag, application ID, internal versionName/versionCode, and that versionName matches the published tag.
5. It attaches `agent-board-<tag>-<sha>-release.apk` to the GitHub Release and keeps an Actions artifact. Missing credentials or failed verification block publication; there is no debug fallback.

`workflow_dispatch` also builds and verifies a production release APK, but only stores an Actions artifact; it does not attach a release asset. Select a trusted branch or tag. Pull requests run unit tests and `assembleDebug` without receiving production signing credentials.

The historical `1.0.0` release used the old debug workflow and remains unchanged. Production signing starts with `1.0.1` (`versionCode = 2`).
