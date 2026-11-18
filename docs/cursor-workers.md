# Cursor workers

Cursor can participate in Lead & workers as a Chat worker using Relay's existing Cursor subscription connector. Each bot retains its enabled model, instructions, memory/library references, and distinct perspective. This extension adds no account, billing, or mode migration.

## Use

1. Edit a bot and open Advanced options.
2. Select Cursor and an enabled model from that subscription.
3. Set its saved mode to Chat.
4. Add it as a worker in a Lead & workers group and send the lead a task.

Automatic provider routing can also select Cursor for a resolved Chat assignment when its account permits automatic routing. Existing provider priority/default-model preferences still apply. Tool assignments exclude Cursor. A fixed Cursor route with Work, Agent, or Auto plus a workspace is rejected before lead planning with guidance to choose Chat. The saved mode is never silently downgraded.

Cursor Work/Agent workers remain unavailable on this Windows host because the installed SDK's tool sandbox is unsupported. The process-tree guard controls lifecycle; it is not a filesystem or network sandbox. Use Codex/Claude workers for file and shell tasks.

## Account compatibility

An actual-account check exposed Cursor's account-gated custom-system-prompt option. Relay now uses Cursor's built-in system prompt and sends the configured bot mission as JSON-escaped user-level guidance before the existing role-preserving conversation input. This keeps the mission without requesting a privileged override or claiming the mission outranks Cursor's system instructions. The change also applies to ordinary Cursor chat.

Cursor documents the per-account restriction under [Replacing the system prompt](https://cursor.com/docs/sdk/typescript#replacing-the-system-prompt). Relay does not retry a rejected prompt, switch models silently, enable API-key fallback, or request a plan change.

The Chat SDK configuration still disables tools, MCP, subagents, custom tools, settings sources, retries, and auto-review. Unexpected tool events stop the call. The same provider-managed credential snapshot is checked against the expected account and catalog selection; confirmed billing and enabled-model policy remain enforced.

## Private SDK storage

No-inference checks reproduced an SDK SQLite checkpoint-open failure on this host. Relay now explicitly supplies the official JsonlLocalAgentStore under the private Cursor home at .cursor/relay-sdk-stores/<unique-operation-id>. Each operation gets a separate directory and uses the same store instance for metadata, runs, events, and checkpoint blobs, avoiding cross-process file sharing. Existing credentials and SQLite databases are left intact; no data conversion, automatic resume, retry, or fallback is performed.

Actual-store tests reopen all four substores and compare persisted values. Source tracing confirms the SDK executor uses the supplied checkpoint adapter rather than opening another SQLite blob store. The lower-level cause of the SQLite open failure is unproved; this is a supported storage backend choice, not a vendor patch or a filesystem-permission bypass. See Cursor's [local agent store documentation](https://cursor.com/docs/sdk/typescript#local-agent-stores).

These files contain SDK conversation state and stay under Relay's private data directory. They should be included in private local backups and kept out of shared repositories.

## Process ownership and evidence

The Windows Job Object guard is assigned before the Cursor SDK process is launched with its IPC channel. SDK cancellation and async disposal run first; kernel membership is then drained and process exits observed. A detached descendant cannot survive merely because its original parent exits. If the bridge dies without final cleanup evidence, the outcome stays unknown and its exclusion persists; no task replays.

Cursor's SDK echoes the selected model rather than verified server identity. Results retain that limitation and remain Finished · unverified without independent artifact proof.

## Reproduce the actual worker check

Build Relay, ensure localhost:3210 has an authenticated Cursor account with confirmed billing and an enabled specific model, then explicitly run:

```powershell
node --no-warnings scripts/verify-cursor-worker.mjs --live
```

This uses the saved default/economy selection and makes one tiny Cursor worker request in a separate store/runtime with a deterministic lead. A random verification code exists only in the worker's private bot instructions. The script checks the returned code exactly, one combined lead reply, all recorded owned processes gone, successful cleanup reconciliation, and absence of a fabricated verified-model marker. It leaves the live bots/rooms/conversations/billing unchanged.

Proof files are under .data-herdr-cursor/live-*/proof.json. The runtime test session is private and closed after the check. Normal npm test does not make subscription calls.

The test uses the account's already-confirmed billing arrangement. It does not measure remaining Ultra allowance or assert zero cost.
