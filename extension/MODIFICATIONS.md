# Qingjian Web Clipper — source and modifications

This extension derives from EdgeEver Web Clipper and its required shared/UI modules at https://github.com/tianma-if/edgeever, commit `8fc9851c0b6a8e764b74a835237b2920c3b5120f`, under GNU AGPL version 3. Original copyright notices, LICENSE and third-party notices remain in `vendor/edgeever`. `UPSTREAM.json` identifies the original import and its original file hashes; it is not a claim that Qingjian's adapted files are unchanged.

Qingjian modifications:

- The extension settings, HTTP client and popup/background readiness checks directly use the existing Qingjian admin password. There is no separate API token, scope system, old credential fallback or credential migration.
- Settings labels and diagnostics in all four locales describe admin-password authentication. Corresponding upstream-derived tests use the same authentication contract.
- `src/adminPassword.ts` encodes UTF-8 HTTP Basic credentials, preserving spaces, colons and non-ASCII passwords.
- `build.mjs` changes generated branding, icons, version, source/privacy links and Firefox identity. The builds belong to Qingjian and are not official EdgeEver builds.
- All clipping saves directly to the configured notebook or group. The legacy preview entry, draft handoff and Qingjian `/clip` page have been removed.
- Video clipping saves available transcripts, timestamps, chapters, cover images and metadata without requesting an AI summary. Model configuration endpoints and the extension's model permission UI have been removed. Unused upstream outline helpers and their fixtures remain for upstream reference and are excluded from the shipped background bundle.
- The Go server stores documents/images using native Qingjian data and provides protected edit sessions for concurrent-content checks.

Corresponding source and build instructions are included in https://github.com/sunxin121/qingjian/tree/main/extension . Distributors of modified builds must provide the corresponding complete source under the applicable AGPL terms. This extension does not use an EdgeEver relay, analytics service, official store identity or service credentials.
