# agent-board Android

Kotlin Compose client (`tech.mengfei.agentboard`). The phone pairs with the relay and never dials the ThinkBook board. Shared framing, worktree eligibility, and command validation live in the `protocol` module.

JDK 17+. Android SDK 35.

```bash
cd android
./gradlew :protocol:test
./gradlew :app:assembleDebug
./gradlew :app:assembleRelease
```

`assembleRelease` is **unsigned**. The output is `app/build/outputs/apk/release/app-release-unsigned.apk`. Play Store or device-owner signing is out of scope: there is no keystore in this repo and the release workflow does not read signing secrets.

## GitHub Release APK

1. Push the commit you want to ship.
2. On GitHub, open **Releases → Draft a new release**, choose or create a tag (for example `v0.1.0`), and publish the release.
3. `.github/workflows/release-apk.yml` runs on `release: published`. It installs JDK 17 and Android SDK 35, runs `./gradlew :app:assembleRelease` in `android/`, and uploads `agent-board-<tag>.apk` onto that release with `GITHUB_TOKEN`.
4. `workflow_dispatch` builds the same unsigned APK and stores it as an Actions artifact. It does not attach a release asset, because there is no release event.

No `ANDROID_KEYSTORE_*` secrets are required. Adding them later would be a separate signing change; this workflow will keep producing an unsigned APK until then.
