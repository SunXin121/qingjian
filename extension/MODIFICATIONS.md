# Qingjian Web Clipper — source and modifications

This extension incorporates EdgeEver Web Clipper and the required shared/UI modules from https://github.com/tianma-if/edgeever at commit `8fc9851c0b6a8e764b74a835237b2920c3b5120f`, under GNU AGPL version 3. Original copyright notices, LICENSE and third-party notices are retained in `vendor/edgeever`. `vendor/edgeever/UPSTREAM.json` records SHA-256 hashes of every imported original file.

The imported source files are unchanged. Qingjian's integration code is outside that snapshot:

- `build.mjs` uses the original build configuration and changes generated extension branding, icons, version, source links, privacy link and Firefox extension identity. The builds belong to Qingjian and are not official EdgeEver builds.
- `scripts/prepare.mjs` provides the original monorepo tool lookup without editing the source. `scripts/vendor-edgeever.mjs` reproduces the source import from the pinned checkout.
- The earlier Qingjian preview/whole-page/link workflow is bundled as `legacy.html`, with its background listener alongside the upstream worker; its messages use a separate namespace.
- The Qingjian Go server implements the clipper's notebook, memo, image resource, protected edit and video outline preparation contracts. Markdown and localized images use native Qingjian documents and attachments.
- Qingjian's `/clip` page manages the scoped API token and optional video summary model configuration, and retains the earlier draft preview workflow.

Corresponding source, build instructions, tests, imported source and these changes are included in the Qingjian project: https://github.com/sunxin121/qingjian/tree/main/extension . When distributing a modified build, make the corresponding version of the complete source available under the applicable AGPL terms. This build contains no EdgeEver account, relay, analytics, official store identity or service credentials.
