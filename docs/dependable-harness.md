# Relay: dependable subscription agents and browser viewing

Relay keeps one conversation around supported subscription runtimes. It does not merge provider accounts, transfer allowances, or turn an unknown contract into a guaranteed spending limit. OpenAI/Codex, Claude Code and Cursor retain separate accounts, catalogs, billing permissions and tool capabilities. TypeSafe/Jev is an optional metered decision service, not a conversation model.

## Watch a bot's browser

New Agent bots use the current user's detected home folder as their working directory. You can optionally choose a narrower folder in **Edit bot → Advanced options**. Existing custom folders and deliberately cleared folders stay saved. Work and Auto retain their separate project-folder requirements. A working directory is a starting location, not a universal access boundary or an OS sandbox.

In an ordinary Agent conversation, ask the bot to browse using its existing browser tools. On desktop, its running browser automatically opens in an inline panel beside the chat. You can also select **Browser** in the chat header. On mobile, the header shows browser activity; tap **Browser** to open the drawer. Neither watching nor opening the panel requires Advanced mode or a selected folder. Dismissing the panel suppresses automatic reopening for that bot's current browser session; a new session can open again. The browser belongs to the bot across its ordinary conversations. Group chats hide the viewer rather than selecting an arbitrary member's browser.

The panel shows the current page URL, control state, last-frame time and the last 40 browser actions with their phases. The read-only preview updates about once a second when capture succeeds. It is not full video or remote keyboard/mouse control. Waiting, unavailable engine, access off, stale and disconnected states remain visible; a last frame is not proof of current activity. Opening the viewer does not grant browser access, launch or navigate a browser, or invoke a model. Closing the panel stops observation and leaves the bot working.

Each bot uses its own persistent Chromium profile, separate from your personal Chrome profile. Preview frames are kept only in memory, are not saved as screenshots/history/artifacts, and are not automatically forwarded to a model. Visible page pixels can still contain private content or sign-in data; the operator preview does not redact them. The activity list exposes action and phase, excluding fill values.

Use **Take over** to sign in or interact in a separate Chromium window. Chromium relaunches and reloads the current URL, so unsaved forms or other transient page state may be lost. Bot browser actions are blocked while you have control. Select **Return control** yourself when finished. The model cannot take or return control through Relay's app controls, or clear the human-ownership latch by toggling its browser grant.

**Stop bot** requests cancellation of that bot's current working, queued and waiting-for-input tasks and active runs, and closes its browser. It preserves future scheduled tasks. Parent-task cancellation retains its existing child-cancellation behavior. **Stop requested** acknowledges the request; **Could not confirm stop** reports uncertainty. Neither is proof of physical/native process termination. Inspect task and run outcomes when cancellation remains uncertain.

This viewer observes Relay's existing browser tools. It does not give every model, native runtime, group or worker a universal browser/computer capability. Existing provider permissions, browser grants, subscription eligibility and Windows native-tool limits still apply.

## Agent capabilities

| Area | Behavior | Boundary |
| --- | --- | --- |
| Completion | Direct Agent requests adopt durable tasks with outcomes, evidence, checkpoints, bounded continuation and chat-visible progress/questions. | A finished provider turn, model success statement or matching file hash is not proof of correctness. |
| Usage | Actual reported counters and historical costs are labeled and bound to the dispatch account. Supported Codex allowance windows carry source, age and reset information. | Missing counters, contract prices and unsupported remaining balances stay unknown. Provider counters are not a monetary cap. |
| Context | Bounded history and relevant saved sources retain omission notices and original provenance; Agent tools search/read saved sources in pages. Verified Cursor checkpoints send only the new delta. | Mandatory instructions/current input/anchored task sources must fit the actual escaped text budget. Codex/Claude reconstruct; uncertain side effects are never replayed to repair a session. |
| Jev routing | Jev can choose from currently eligible models using bounded, redacted account/task-specific observations and operator feedback. Manual choices remain authoritative. | Execution completion, user feedback and verified quality are separate. Sparse evidence and fallback rules are disclosed; no universal model ranking or minimum-cost guarantee. |
| Recovery | Persisted journals expose interrupted work in chat. The Windows supervisor restarts a proven owned server with bounded backoff and adopts proven updater replacements. | Unknown outcomes retain exclusions; intentional stops, unrelated listeners and uncertain activations are not blindly retried. Scheduling requires the computer and server online. |
| Capabilities | Routing, task admission, delegation and final queued dispatch share provider/mode/host capability checks. Chat inspection distinguishes the current dispatch binding from prospective defaults. | App-only Agent is distinct from native filesystem tools. Groups remain tool-free Chat; classifiers receive text and metadata only. Image-capable leads and selected Herdr workers receive bounded original-message images through host-authorized memory transport, without Relay callbacks or image bytes in saved jobs/bootstrap files. |
| Managed secrets | TypeSafe, Telegram and MCP tokens use verified DPAPI CurrentUser storage and opaque database references. One-use masked chat fields keep secrets out of ordinary messages. | This is protection at rest, not encryption of the whole database or isolation from code running as the same Windows user. Legacy SQLite pages/backups may retain old plaintext. |
| Input and setup | Compact conversation attachments, editable optional dictation, keyboard credential retry, per-port sessions, validated backup/restore and truthful setup diagnostics. | Supported input formats, model evidence, parser/resource limits and host prerequisites remain explicit. |

## Work entirely through the conversation

Ask an Agent to create/configure a bot, start a discussion, delegate a task, inspect account/model capability, search its sources or prepare a Relay change. Its current tools and permissions govern what can execute. Essential questions and exact-revision Relay activation approval appear in the same chat. A checked draft is not applied until the trusted updater reports its result; editing a checked revision requires fresh checks.

A direct Agent request creates a task in the same transaction as its original messages/run. Automatic continuation remains bounded by the task's inference/time budget and does not grant itself a fresh budget. A new authenticated human turn can renew an eligible task once; synthetic continuation text cannot. A tracked Chat/Work task receives only the three task-reporting tools, not Agent app controls. Normal untracked Chat remains normal chat.

Worker results retain their own owner/task/run attribution. A parent can inspect descendant artifacts through scoped list/read/integrity tools without receiving a worker's private instructions or filesystem path. Integrity verification proves the stored bytes match a recorded digest, not that the output satisfies the task.

## Files and dictation

Use the attachment control beside the composer. TXT, text-bearing PDF, canonical supported DOCX and PNG/JPEG/WebP are supported within the displayed limits. Uploads are conversation/bot scoped; successful message admission atomically claims their immutable metadata. Image-only messages are supported where both the chosen model and actual transport have image support. Unknown model vision support is rejected rather than inferred from an alias. A tested adapter format does not establish a live subscription's entitlement or image comprehension.

Each source is at most 4 MiB; messages allow eight attachments and at most four images. Rasters are decoded and limited to 8,192 pixels per dimension and 16 million pixels. PDF extraction is text-only, at most 100 pages and 80,000 extracted characters; scanned/image-only or encrypted files receive explicit limitations. DOCX accepts the validated canonical package layout; relocated structural parts and other unsupported variants are rejected. ZIP entry/inflation limits and a ten-second extraction deadline apply. HTML, SVG and raw audio are unsupported.

Documents enter model context as labeled untrusted excerpts/manifests, never permission grants. Full capped extraction remains saved for scoped search/paged retrieval by Agent tools. Cold reconstruction preserves original task input anchors; new input cannot silently replace an original mandatory image. Optional historical sources can be omitted with a notice. Text budgets count actual escaping; image count/decoded bytes/private-operation bytes are separate. Cursor images live in one ephemeral request table, shared by full/delta references rather than duplicated in the serialized operation.

Sending commits only the submitted draft text/chips after the server accepts the message. New typing, dictation and newly added chips remain the next draft. A later refresh failure does not turn already claimed attachments back into retryable uploads. Switching chats isolates late upload and dictation callbacks. Attachments cannot silently become text-only answers to a pending credential or question interaction.

Dictation starts only on an explicit action in browsers that expose speech recognition. Transcripts stay editable and never send themselves. Recognition may use the browser vendor's speech service; Relay does not promise offline recognition. Switching conversation or closing the component aborts recognition. No microphone is required for text/file use.

## Setup, backup and supervision

Install with **Setup Relay.cmd** or `powershell -NoProfile -File scripts/setup-relay.ps1 -Apply`. Start with **Start Relay.cmd**. Paths use the detected user's home: `%USERPROFILE%/Relay` and `%USERPROFILE%/.relay-data`, with the existing explicit data-directory override retained. No developer-specific home path is required on another computer.

Run `powershell -NoProfile -File scripts/doctor-relay.ps1 -Json` for Node >=22.13, npm, build, connector/browser/runtime and synthetic DPAPI capability checks. Connector presence is not authentication or subscription entitlement. Optional connector failures do not make the base application unready; managed-secret failure is shown separately. The DPAPI probe does not read real credentials.

The independent Windows supervisor verifies process identity, listener, installation, data and instance binding before adopting a server. Unexpected owned exits use bounded retries; a stable period resets the retry budget. It follows only a proven exact trusted-update job and does not reapply an activation merely because its receipt is uncertain. Foreground `npm start` does not create this independent supervisor.

`powershell -NoProfile -File scripts/backup-relay.ps1 -Action Create` snapshots SQLite and required artifacts/attachments. Snapshot records determine required original/extracted files; a missing or changed required file makes the backup incomplete even if the listed-file manifest hashes pass. Preview and restore revalidate completeness. Restore requires the server stopped and preserves a recovery copy of the previous database/artifacts/attachments. Provider/browser profiles and the managed vault are excluded: reconnect integrations/accounts when moving to a new data root or computer. Old backups without attachment records remain supported.

Trusted updates hold background initialization/migration and verify preserved records during candidate startup before releasing the hold. Normal credential migration and recovery may legitimately update records afterward. Activation and rollback reports, rather than a generic process-exit message, establish the installation outcome.

## Security and verification limits

A prompt guides behavior; it is not an OS security boundary. Native provider tools retain their own permissions. Claude's Windows shell is not OS sandboxed; Cursor's Windows native Work/Agent filesystem runtime remains unsupported, while its direct app-only Agent works through Relay controls. Codex native Windows execution requires its verified MXC backend. Approved Relay source checks run local code as the user's account.

Parsers run in owned disposable child processes with finite input, text, ZIP, image and deadline limits. Their 128 MiB V8 old-space setting and Cursor's 512 MiB setting are not total native-memory/OS-RAM limits or a complete hostile-file sandbox. Cursor SDK 1.0.40 and Zod 4.6.6 are pinned; the SDK still reaches its legacy zod/v3 remote parser before Relay's wrapper. A clean dependency audit is not proof that this upstream parsing boundary is fully patched.

Implementation evidence uses synthetic storage, injected official-protocol adapters, mocked speech, disposable browsers and real isolated Windows scripts/DPAPI. Actual account/model entitlement, paid inference, microphone recognition and every provider-side failure are outside those tests. Run the applicable platform checks and inspect their results and intentional skips for this beta.
