# Relay

> **Beta / testing — 0.10.1.** This is an early public source snapshot, not a claim of production readiness. Windows/Chrome controller pairing has been tested. Physical iPhone installation and close/reopen behavior still need device verification; native macOS/Linux behavior and provider entitlements have separate limits.

A local, conversational workspace for multiple agents and your ChatGPT, Claude, Cursor and OpenCode connections. Keep conversations, job activity, bot browsers and terminals together. Simple mode centers the conversation; Advanced exposes routing, accounts and execution settings.

Project: [GiovanniVarg/Relay](https://github.com/GiovanniVarg/Relay). Feedback and reproducible bug reports are welcome. Do not put API keys, pairing codes, private connection profiles or unredacted logs in public issues.

## Run on Windows

Requires Node.js 22.13+ and npm. Install the official Codex and Claude Code CLIs for the providers you use. Native Codex Work/Agent execution on Windows requires Codex 0.162.0+ and the MXC sandbox. Cursor's official SDK is an application dependency; OpenCode requires its supported installed CLI and provider configuration.

For a source checkout:

```sh
npm ci
npm run check
npm run build
npm start
```

Open [Relay on localhost](http://127.0.0.1:3210/). Foreground `npm start` stops with Ctrl+C. On Windows, **Setup Relay.cmd** prepares the per-user installation; **Start Relay.cmd** uses the independent Windows supervisor. Installed application and data paths use the detected user's home: `%USERPROFILE%/Relay` and `%USERPROFILE%/.relay-data`. `RELAY_DATA_DIR` can explicitly override the data directory.

The supervisor restarts an unexpectedly exited owned server with bounded backoff and follows verified trusted updates. It does not install an automatic Windows login trigger. Native dependencies, browser installation and OS permissions may require their own supported setup; unavailable capabilities report their limitation.

## Connect subscriptions and models

Use Relay's account settings and each provider's official sign-in. Multiple Claude, OpenAI/ChatGPT and Cursor profiles have separate catalogs, approvals and continuity partitions. New accounts start unapproved, outside Auto routing, with no enabled models. Select models and confirm your actual billing arrangement before enabling usage. Duplicate sign-ins do not create extra subscription allowance.

Sign-in is not proof of model entitlement or included usage. Enterprise and legacy plan coverage depends on the account's agreement. Cursor model metadata can remain a candidate because its SDK does not report the resolved server model identity. Relay does not buy credits, enable overages or guarantee remaining quota. Paid API-key fallback for subscription routes is disabled.

Optional TypeSafe uses its own API credits for typed decisions. Jev can select among eligible enabled models; the selected chat provider handles the conversation. Manual selections remain authoritative. Connect TypeSafe, Telegram or authenticated MCP tools through their masked credential forms, never ordinary chat text. See [connection boundaries](docs/subscription-connectors.md) and [TypeSafe troubleshooting](docs/typesafe-connection-troubleshooting.md).

## Conversational agents

Bots retain their own instructions, memory, models, workspaces and chats. New Agent bots use the detected user's home folder; a narrower per-bot starting folder is optional. Ask an Agent to create another bot, change allowed settings, run a task or prepare a Relay improvement. Essential questions and approvals stay visible in the conversation.

Agent instructions guide behavior; runtime permissions enforce access. A starting folder is not a universal security boundary. Codex uses its supported sandbox policy; Claude's shell has no OS sandbox on Windows. Native agents run with authority granted by their runtime and OS account. Connect and trust them accordingly.

Type `@` and choose bots or paired computers to assign explicit background work. Activity, results, cancellation and worker questions stay in the source conversation. Lead & workers groups use a lead to assign bounded tasks and combine attributed results. Workers keep their own account/model/mode and receive task-relevant context rather than other bots' private instructions. Offline machines stay queued; uncertain work is not automatically replayed. See [mentions](docs/bot-mentions.md), [connected machines](docs/connected-relay.md) and [tasks and tools](docs/workspace.md).

## Pair an iPhone or another browser

Keep the device and hosting computer on the same LAN. Open the **phone icon beside Settings**, enable local connections on the selected private interface, and wait for the QR transport to become ready. Scan a fresh QR. Supported browsers use the pinned encrypted connection without installing a root certificate. Safari needs its WebTransport certificate-hash support; allow ordinary Local Network access if requested.

For an iPhone Home Screen app, choose **Set up Home Screen app** in Safari, then **Copy public connection profile**. Use **Share → Add to Home Screen** and open the new icon. Paste into **Copied connection profile**, choose **Use copied connection profile**, then **Check connection**. Enter a new one-time sync code from the host and select **Connect securely**.

Pair in the app you intend to reopen. Safari tabs and installed apps do not share IndexedDB pairing keys. Leave automatic reconnect enabled; normal reopening uses the saved key instead of requiring another code. The browser controls persistent-storage and Local Network permissions. Deleting app/website data, revocation, changing storage context or host identity/address, or expiration of the saved trust horizon can require recovery. The host must remain awake and reachable. Physical iPhone installation and close/reopen behavior are not yet verified. See [QR pairing and persistence](docs/qr-pairing.md).

The hosted controller serves a static shell. Private commands, responses and credentials travel directly between the paired controller and LAN host. Do not expose Relay through router port forwarding. Pair only trusted devices: a controller can operate your Relay tools, files and terminals.

## Work without leaving Relay

- **Browser:** watch a bot's separate browser beside its chat. Human takeover and stop controls remain available. This is a browser preview, not proof of a site's automation compatibility.
- **Terminal:** choose a supported installed OS shell inside Relay. Windows offers Command Prompt and PowerShell; sessions run with your normal OS permissions. See [terminal behavior and limits](docs/terminal.md).
- **Appearance:** Light, Dark and System modes share the interface palette. See [appearance](docs/appearance.md).
- **Files and images:** attach owned files to supported chat, group and worker flows. Each provider/model must support the required modality; parser budgets and permissions still apply.
- **Change Relay:** ask an Agent to prepare an isolated source draft, review its diff, run checks and request exact-revision activation in chat. The trusted updater waits for idle work, backs up source/data, verifies startup and rolls back detected startup failures. Checks run local draft code with your OS permissions; source isolation is not an OS sandbox. See [self-editing](docs/self-editing.md).

See [capabilities and limits](docs/dependable-harness.md) and the [HTTP API](docs/api.md).

## Secrets and safety boundaries

Managed server credentials use Windows DPAPI or macOS Keychain with no plaintext fallback. Browser device keys remain nonextractable in IndexedDB. At-rest encryption does not protect against arbitrary code already running as your OS user. Keep account profiles, Relay data, backups and diagnostic receipts private.

LAN access retains signed exact request bytes, nonce/timestamp replay checks, role separation, CSRF protection and revocation. Codes are single-use, role-bound and short-lived. Failed or uncertain actions are not automatically replayed. Tests do not prove every provider entitlement, physical-device configuration or hostile-file boundary.

## Development and testing

`npm run check` typechecks, `npm test` runs the normal suite, and `npm run build` builds server and client. Live browser, native-runtime and subscription tests are explicit opt-ins; normal tests do not establish live account access. Review test output and intentional skips for your platform. No credentials or real user data are required in public bug reports.

This snapshot includes application source, tests, scripts and current user guides. Developer-machine histories, private data, local verification receipts and archived design/delivery reports are excluded. A project license has not been selected yet; no license file is included in this beta snapshot.
