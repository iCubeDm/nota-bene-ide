# mobile/

The phone side of remote access (issue #63), in three Dart packages:

| Package | What |
|---|---|
| `protocol/` (`nb_protocol`) | the window protocol's types, generated from `shared/src/protocol.ts` by `npm run gen:protocol` |
| `channel/` (`nb_channel`) | the end-to-end channel of `server/src/remote/CHANNEL.md`: Noise IK, pairing values, relay admission, the stream mux |
| `app/` (`nb_app`) | the Android app (Flutter) |

## Checks

```sh
(cd mobile/channel && dart pub get && dart analyze --fatal-infos && dart test)   # includes the cross-language test
(cd mobile/app && flutter pub get && flutter analyze --fatal-infos && flutter test)
npm run mobile:assets && npx playwright test -c mobile/app/web_test/playwright.config.ts   # the app's Mermaid page
```

The cross-language test (`channel/test/cross_test.dart`, tag `cross`) runs `server/src/remote/crossHost.ts` with Node
and builds the Go relay, so it needs `node` (>=23.6) and `go` on PATH and `npm ci` done at the root. It uses a
temporary `NOTA_BENE_HOME` and free loopback ports.

## The APK

CI builds it in the `mobile` job and uploads it as the `nota-bene-android` artifact. Builds of this repository are
signed with the keystore in the repository secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (alias
`nota-bene`); without them (forks) the job builds a debug APK. A local build needs the Android SDK:
`npm run mobile:assets && (cd mobile/app && flutter build apk --debug)`.

`npm run mobile:assets` copies the web's own `mermaid.min.js` (MIT) into `app/assets/mermaid/` (git-ignored): the app
draws diagrams with the same version as the desktop.
