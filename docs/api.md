# V1 HTTP contract
All responses JSON unless SSE; errors {error:string}. Cookie session established by GET /api/bootstrap (same origin), response includes csrfToken. All mutations require X-CSRF-Token from bootstrap. Browser fetch credentials same-origin.

- GET /api/bootstrap -> Bootstrap, including detected homeDirectory for folder setup
- GET /api/agents/:id -> {agent,conversations,files}
- POST /api/agents body {name,role?,instructions?,color?} -> Agent
- PATCH /api/agents/:id body Partial<Agent> (server accepts editable fields only, incl. mode:'chat'|'work'|'auto'|'agent' and workspace:string; workspace is validated server-side and stored as its realpath, '' clears it; mode 'work' requires a workspace) -> Agent
- POST /api/agents/:id/conversations body {title?} -> Conversation
- GET /api/conversations/:id -> {conversation,messages:Message[],runs:Run[]}
- POST /api/conversations/:id/messages body {content,routeMode?:RouteMode,model?:string,mode?:'chat'|'work'|'auto'|'agent'} -> {run:Run,message:Message}; mode defaults to agent.mode; explicit work without a workspace is 400, auto without one resolves to chat; Run.mode is the resolved mode; errors before inference gating return 400/409
- GET /api/runs/:id/events -> SSE data: RunEvent JSON; snapshot route then accumulated text; closes on done.
- POST /api/runs/:id/cancel -> {ok:true}
- POST /api/agents/:id/files body {name,content} -> LibraryFile
- DELETE /api/agents/:id/files/:fileId -> {ok:true}
- POST /api/providers/refresh -> {providers:ProviderState[]}
- POST /api/providers/:id/login -> LoginResult
- PATCH /api/providers/:id/billing body BillingConfig & {expectedAccount?:{accountLabel:string,plan:string}} -> ProviderState; confirmed=true requires the account snapshot and rejects a changed account.
- PATCH /api/providers/:id/models body {defaultModel:string,allowedModels:string[]|null} -> ProviderState
- PATCH /api/settings body Partial<Settings> -> Settings; maxWorkSeconds is an integer 1..3600 (default 900) used instead of maxRunSeconds for work runs
- GET /api/health -> {ok:true,version:string} (no user data)
- POST /api/groups body {title?:string,agentIds:string[],mode?:'moderated'|'roundtable',moderatorAgentId?:string|null} -> GroupRoom; two to five unique existing agents, no inference. New rooms default moderated; moderator defaults to the first selected participant and must belong to the room.
- GET /api/groups/:id -> {room:GroupRoom,messages:GroupMessage[],runs:GroupRun[]}
- POST /api/groups/:id/runs body {content?:string,rounds?:number,maxReplies?:number,executionMode?:'bounded'|'continuous'} -> {run:GroupRun,message:GroupMessage|null}; omitted executionMode retains bounded behavior for API compatibility. The UI explicitly selects continuous by default. Bounded roundtable rounds 1..3, default 2; bounded moderated maxReplies 1..15, default 6. First run requires a topic; omitted content continues an existing discussion.
- GET /api/group-runs/:id/events -> SSE data: GroupEvent JSON; current-run snapshot followed by future events, closes on done.
- POST /api/group-runs/:id/cancel -> {ok:true}

No websocket, no remote URL inputs, no arbitrary file path or process endpoints. GET bootstrap auto-creates a local session only after Host and Fetch Metadata validation. Read routes require session except health/bootstrap/static.

ProviderState includes modelPreferences. allowedModels=null permits the full current/future catalog; [] disables every model for that provider; an explicit list permits only those IDs. A nonempty defaultModel must be listed and enabled. Blank selects the economy preference among enabled models. Preferences apply to manual requests, direct routing, classification and fallback; they never enable billing or authenticate an account. Missing saved selections stay visible and must be corrected rather than silently substituted.

Active provider IDs are openai, claude and cursor; routeMode also accepts auto. Legacy gemini/grok IDs can remain in stored history but cannot be configured, authenticated or dispatched. Their provider endpoints return 404. Cursor starts with allowedModels=[] and unknown, unconfirmed billing. Cursor included billing requires an explicit model allowlist without dynamic Auto aliases. The model and billing endpoints enforce this policy, and routing repeats the check for persisted configurations. Model discovery does not establish entitlement or remaining allowance.

Bootstrap includes rooms. Group messages are stored separately from direct conversations and retain agentId, authorName, status and route. GroupRun records requested rounds, completed/total replies, modelCalls/maxModelCalls, deadline, active speaker, and terminal error. SSE snapshots and message events upsert by message ID; delta events append only after the snapshot. Agent configuration is captured when starting a run, while current provider access is checked before each model call. Group and direct work share global concurrency and account-switching guards.

Rooms without mode are legacy roundtables. Moderated runs include moderatorAgentId, moderatorRoute, phase, moderatorCalls, and nextSpeakerReason. Moderator calls include routing and fallback and are a subset of modelCalls. Validated moderator control JSON is never stored as a chat message. The moderator may choose any participant, including itself. A null speaker ends a bounded run; continuous runs require a valid participant. Invalid or foreign choices fail visibly.

GroupRun.executionMode is bounded or continuous; missing values mean bounded. Continuous totalReplies, maxModelCalls and maxSeconds are null, with no session cap or timer. Each step retains configured request timeouts and retry/call bounds. contextWindowed records whether continuous model input omitted older transcript messages. Full messages stay persisted; model input retains the original topic, latest human input and recent whole attributed replies with an explicit omission notice. Private instructions are never truncated. Continuous loops yield between replies for cancellation and other requests. Stops, errors, policy revocations and restarts terminate work without automatic replay.

- GET /api/agents/:id/telegram -> TelegramStatus {configured,enabled,botUsername,allowedUserId,running,error}
- PUT /api/agents/:id/telegram body {token?:string,allowedUserId:number,enabled:boolean} -> TelegramStatus; token is required the first time (or to rotate), is verified with Telegram getMe, must be unique per agent, and resets the stored update offset. Omit token to keep the saved one.
- DELETE /api/agents/:id/telegram -> TelegramStatus (record removed, bot stopped)

Work mode and Telegram. RunEvent adds {type:'tool',runId,name,summary}; ordinary Chat never emits it (any tool attempt aborts the run); an app-only Agent run can use provider mode Chat plus an explicit process-local appTools capability. Work-mode providers run with cwd = the agent workspace; workspace must be an absolute existing directory that is not a drive root, the home folder, or inside/containing Relay's data folder. Telegram is outbound-only long polling (getUpdates), one bot per enabled agent, answering only message.from.id === allowedUserId in a private chat; messages go through the same run limits as the web UI. Commands: /chat /work /auto /mode /new /stop /status /help; workspace and token are never settable from Telegram. Bot tokens are stored server-side only and are redacted (`\d+:token`, `bot<token>` URLs) from errors; they never appear in any API response, SSE event or log.

## Herdr delegation

Group creation also accepts mode:'delegated'; moderatorAgentId identifies the selected lead. Existing rooms are not migrated. A delegated run requires new nonempty content and executes one finite validated batch, with one assignment per non-lead participant and an acyclic dependency graph. Its phases are planning, working, and synthesizing. Chat/Work/Agent permissions remain per worker; planning and synthesis use Chat. Cursor Chat workers are supported; Work/Agent Cursor workers are rejected before dispatch. A fixed Cursor route with Auto mode plus a workspace requires explicit Chat before paid planning, since assignment-based mode resolution may select Work. Automatic provider routing can choose Cursor only for resolved Chat workers. Ordinary Cursor chat and text-only lead calls remain supported.

GroupRun.delegations contains public DelegationRecord entries with stable id, parentRunId, workerId/name, assignment, expectedResult, dependency worker IDs, status, route, mode, workspace, result/error, evidence, executionVerified, and terminationUnconfirmed. Worker events upsert by delegation ID. A snapshot contains current pending interactions; GET /api/groups/:id also returns interactions. Questions and approval responses use the existing run interaction API with the parent group-run ID and the exact worker-bound interaction ID. Foreign, expired, cancelled, and already answered requests are rejected.

- GET /api/herdr -> {available,version?,error?,quarantines?}; requires the local session. Quarantines have stable owned IDs, source, runId/provider when available, workspace, createdAt, and reason.
- POST /api/herdr/reconcile body {delegationId:string} -> {stopped:boolean,error?}; requires CSRF. Accepts an owned delegated task ID or persisted inference exclusion ID. It verifies cleanup only, never restarts work. Missing descendant cleanup proof returns stopped:false. Ordinary provider exclusions can lack enough durable evidence to clear and remain reserved.

All direct chats, legacy discussion calls, lead calls, and workers share two actual inference leases. Canonical overlapping tool workspaces serialize. Account, billing, automatic-routing intent, and enabled-model policy are revalidated inside a granted inference slot. A process-local dispatch guard is never serialized into a worker job.

Unknown provider or Herdr termination keeps its inference/workspace exclusion in persistent storage across restart. Interrupted tasks never replay automatically. A dead root PID or kernel containment assignment alone does not prove all descendants exited.


## Relay app tools

Direct Agent runs receive process-local relay_list_bots, relay_create_bot, relay_create_group and relay_start_group definitions. Their strict service shares browser validation and never receives a browser cookie or CSRF credential. Saved app-action receipts bind run ID, actor ID, exact native call ID, action name and canonical argument hash. Creation commits with its receipt atomically. Group starts reserve a pending receipt before asynchronous policy refresh and return the accepted group-run ID without waiting for inference. Unknown or interrupted starts are never automatically replayed. Only an active direct Agent run can invoke these actions. Group/planning/synthesis requests receive no appTools. No public generic app-action mutation endpoint exists.

Agent without a workspace is valid and supplies app controls only. With a workspace, OpenAI/Claude support native Agent permissions; Cursor remains app-only. Google/Grok are removed connections: active-ID checks reject them in manual, automatic, classifier and queued dispatch paths. retired-connections-v1 changes only affected saved bot preferences to routeMode:auto and model:empty, preserving history, private context, folders and account/model records. New/current bots default to Agent with a one-time agent-defaults-v1 migration. New bots default their workspace to the detected home; workspace-home-v1 fills existing blank folders once. Explicit later clearing and custom folders persist. Exact canonical home is valid only for Agent; Work/Auto retain project-only validation. PATCH mode:chat after mode migration remains Chat across restart.

## Persistent workspace

Relay 0.2 adds durable tasks, reviewed knowledge, artifacts, browser grants/control, measured routing and per-bot HTTP MCP connections. The full endpoints and authority boundaries are documented in [workspace HTTP additions](workspace.md#http-additions). All use the same local session and CSRF checks. Bootstrap remains backward compatible.

## TypeSafe optional integration

All routes use the existing local session; mutations require CSRF and JSON. There is no HTTP paid-decision endpoint.

- GET /api/integrations/typesafe returns configured/enabled/model/catalog/storage status without a key.
- POST /api/integrations/typesafe/credential-request accepts {} for settings or {runId,interactionId} for a host-created secure question; returns {nonce,expiresAt}. Nonces are session-bound, expire after at most five minutes and are single-use. Inline entry also requires the same live Agent task and current host capture.
- POST /api/integrations/typesafe/connect accepts {nonce,apiKey,model?}; validates the catalog then encrypts the key outside SQLite. This is the sole credential entry route.
- POST /api/integrations/typesafe/test accepts {} and validates the model catalog without inference.
- PATCH /api/integrations/typesafe accepts {model?,enabled?}; model must be in the validated catalog.
- DELETE /api/integrations/typesafe removes the active encrypted key and metadata and aborts TypeSafe requests.

Direct live Agent tools are relay_typesafe_status, relay_typesafe_connect (no key arguments), relay_typesafe_disconnect, relay_typesafe_configure {model?,enabled?}, relay_typesafe_test and relay_typesafe_decide {state,questions}. The secure question uses a host-generated relay-typesafe-credential: ID; a provider-supplied lookalike cannot obtain a credential nonce. Ordinary message/interaction answer routes reject credential entry while pending. Toolkit receipts bind exact call ID and hashed arguments so completed decisions are not charged again on replay; unknown outcomes are never automatically retried. Selected TypeSafe models are independent of subscription model choices.

Relay 0.5.1 TypeSafe connect failures return a closed {error,code} envelope with locally defined text. Status may include errorCode plus its fixed error message. No upstream response body, header, exception string or key is returned. See [TypeSafe connection troubleshooting](typesafe-connection-troubleshooting.md).

Relay 0.5.2 may include a closed catalogIssue with invalid_catalog failures and status. Model identifiers are opaque strings up to 512 characters, without controls, preserved exactly in JSON. Catalog display metadata is redacted then bounded; ignored extensions cannot grant authority. Wire-size and cancellation limits remain enforced.
