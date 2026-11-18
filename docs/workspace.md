# Persistent workspace

Relay 0.2 adds a task inbox around the existing OpenAI, Claude and Cursor subscription runtimes. Open **Tasks & workspace** in the sidebar. Main chat and group discussions stay available.

## Tasks and team handoffs

Create a task with a bot and a concrete outcome. Optional start time and repeat interval run while the Relay server and computer are online. Closing the browser does not stop the server. Task states are Queued, Working, Needs you, Scheduled, Done and Stopped. Direct Agent requests also adopt tracked work. Provider-turn completion and task outcome are separate: unfinished work remains actionable, with bounded continuation and chat-visible questions/checks. A reported completion remains unverified unless suitable evidence establishes the result.

Bots can create task tickets, delegate a specific assignment to another existing bot, save checkpoints, ask for input and retrieve visible results. Delegation returns immediately; after workers finish, a continuation returns their attributed results to the parent's original conversation. Worker private instructions and memory are never supplied by the delegation tool. Full worker results remain saved; long results enter a bounded continuation excerpt with an explicit omission notice and a linkable task/conversation identity.

Scheduled work survives restart. A task interrupted during dispatch or execution needs explicit review and continuation. Earlier side effects are never replayed automatically. A cancellation that cannot prove termination stays visibly uncertain and retains the existing inference exclusion. Recurring tasks schedule their next run after the current one completes; missed intervals do not generate a catch-up storm.

Task conversations window older whole messages explicitly when necessary; stored history and mandatory private context are retained. Oversized mandatory context fails visibly. Task continuation uses the same subscription, account, model and capability guards as ordinary work. Cursor native Work remains unavailable on this Windows host; its direct Agent conversations can use Relay workspace and browser tools.

## Browser and connected tools

Ask an Agent to enable its permitted browser access, or grant it through Connections. Each bot gets a separate persistent Chromium profile under the Relay data directory, independent of the user's personal browser. Open browser/sign in gives the human control; Return control lets the bot continue. Agent calls stop while the human has control. Password, payment and verification-code fields require human takeover.

Authorized Agent navigation, clicks and fills execute through the conversation without repeated approval buttons; explicit human questions and takeover remain separate. Revoking the grant closes the owned session. The browser uses Chromium sandboxing and an owned forwarding proxy that blocks Relay's own origin on every request and redirect. A browser profile is not a general OS filesystem sandbox. Native shell permissions remain provider-specific.

HTTP MCP connections can be attached to a bot through Connections. The connection stores only an opaque managed-vault reference for its optional bearer credential, returns sanitized status and discovers the remote tool catalog. New and verified migrated tokens use DPAPI CurrentUser protection; legacy pages/backups may retain prior plaintext. Each external tool invocation requests approval and rechecks ownership/current connection. Responses are untrusted data. Supported Streamable HTTP JSON/SSE servers use a single endpoint; arbitrary stdio process launch and imported OAuth/browser credentials are not provided. Relay itself and unsafe destinations are rejected. No paid model API fallback is added.

## Reviewed memory and routines

Knowledge holds private bot notes and explicitly shared notes. Every proposal is pending until the human approves it. Only approved private notes for that bot and approved shared notes participate in selective, bounded retrieval; retrieved text remains attributed reference data and cannot grant permissions. Stop using excludes an entry without deleting it. Approved routines create normal task tickets and use the same execution permissions.

## Artifacts and verification

Bots can save generated text or publish a file from their configured workspace. File publication requires a separate exact-path approval, including for app-only providers; a home-folder default is not a file grant. File capture validates canonical paths and regular files, copies bytes into the artifact store and records owner, run/task provenance, size and SHA-256. Downloads are attachments with a restrictive content policy, including HTML.

Check integrity independently reads saved bytes and compares the recorded hash. This proves byte integrity, not that the requested business or coding task is correct. Screenshots and reports can accompany outputs; task correctness still needs suitable external tests or review.

## Routing and operation

Routing records direct run completion/failure, latency, returned token usage and human feedback by task category. After sufficient comparable observations, Auto can prefer an eligible subscription default with better observed outcomes and speed. User-selected provider/model choices remain authoritative. Marking a subscription Exhausted excludes it from Auto, including queued dispatch. A passed declared reset becomes Unknown, not presumed renewed allowance. Provider quotas and contract prices remain unknown where not exposed; Relay cannot pool subscriptions or guarantee the cheapest monetary result.

Notifications are opt-in and work while Relay's web app is open, including while chatting. Local scheduling requires the computer and server online; no cloud compute or remote service is created.

Run **Setup Relay.cmd** to install/update into the detected user's home. The staged installer checks dependencies, builds and installs its browser engine, preserves the prior installation and leaves data in the user's `.relay-data`. Provider CLIs require their official setup and sign-in. `scripts/doctor-relay.ps1 -Json` reports dependency readiness without logging credentials. Optional `-Autostart` is explicit and creates an owned startup launcher; it is never silently enabled.

`scripts/backup-relay.ps1 -Action Create` makes a consistent SQLite snapshot and saved-artifact/attachment copy, validating required attachment bytes and extracted text against the snapshot records. `-Action PreviewRestore -BackupPath <path>` validates a backup before restoring. Restore requires the server stopped and keeps a recoverable copy of the existing database/artifacts/attachments. Provider and browser sign-in profiles are excluded; reconnect accounts after moving to a different computer. Explicit `-DataRoot` and `-ServerPort` support non-default setups.

## HTTP additions

All routes remain local-session protected; mutations require CSRF.

- GET /api/workspace returns task, capability, routing, artifact, knowledge and actual directory metadata.
- GET/POST /api/tasks; GET /api/tasks/:id; POST /api/tasks/:id/resume, /cancel, /checkpoint.
- GET/POST /api/knowledge; POST /api/knowledge/:id/approve or /reject. Only human routes approve or share entries.
- GET/PATCH /api/capabilities/:agentId/browser; POST /api/browser/:agentId/takeover or /return. An authorized Agent can establish a permitted browser grant through chat; revocation and human takeover are rechecked.
- GET /api/artifacts; GET /api/artifacts/:id/content; POST /api/artifacts/:id/verify.
- GET /api/routing; POST /api/routing/:runId/feedback; PATCH /api/routing/:provider/availability.
- GET/POST /api/mcp; DELETE /api/mcp/:id; POST /api/mcp/:id/refresh. Authorized Agent calls can configure connection metadata; secrets use the masked one-use chat field.

## Verification boundary

Offline tests exercise persistent scheduling/recovery, native tool identity, scoped notes, parent/worker continuation, cancellation races, queued routing revocation, artifact provenance and app HTTP security. Real Chromium tests use disposable localhost websites without inference or sign-in. Operations tests create and restore disposable SQLite/artifact backups. A test-only provider drives the task UI; it is not proof of every subscription's live entitlement. Existing official provider runtimes and their platform limits still apply.
