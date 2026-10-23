# Provider runtime dependency provenance

Installed from the npm registry with exact versions, lifecycle scripts disabled, on 2026-10-23 (Asia/Shanghai). Lockfile integrity and resolved tarballs are recorded in the root package-lock.json.

- `csv-parse` 7.0.3: MIT, official project https://github.com/adaltas/node-csv ; public `csv-parse/sync` entry used for bounded Jira CSV parsing. License retained as csv-parse-LICENSE.txt.
- `dingtalk-stream` 2.1.5: MIT, official project https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs ; installed package's internal version string is `v2.1.5`. Use the package export map (`dist/index.cjs` or `dist/index.mjs`); its legacy `main` points at `dist/index.js`. License retained as dingtalk-stream-LICENSE.txt.

Initial npm install encountered the existing electron-vite 5 / Vite 8 peer range conflict. Installation then used --legacy-peer-deps, preserving existing framework versions. This does not establish build/runtime compatibility. No scripts, builds, tests, application restarts or provider business operations were executed.

The Stream adapter supplies bounded socket frames and explicit token/endpoint requests. A configured proxy requires a compatible socket adapter; lack of that adapter is reported and blocks Stream rather than bypassing proxy configuration. SDK availability is not proof of application credentials, bot installation, identity binding or sending permission.
