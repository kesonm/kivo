# kivo contract (personal keys and standalone chat)

Local source editing only. Build, tests and application execution happen on `ssh ubuntu`.

## Ownership

- Backend: `server/app.mjs`, `store.mjs`, `projects.mjs`, `credentials.mjs`, corresponding tests.
- Runtime: `server/runtime.mjs`, `gateway.mjs`, runtime/gateway tests and runner smoke.
- Frontend: `client/`, `index.html`, Vite and TypeScript configuration.
- Root: deployment, package versions, docs, integration and external verification.

## Authentication and personal credentials

Node 24 ESM / Express / SQLite / React. Username-password public registration, scrypt password hashes, HttpOnly Secure SameSite Strict sessions, CSRF and origin checks on mutations. No recharge or platform quota. Administrators are read-only for other users; every user, including admin, configures their own OpenAI key.

`CREDENTIALS_KEY_FILE` names a private regular file containing exactly 32 random raw bytes. `createStore(dbPath,{credentialsKey})` encrypts personal keys with AES-256-GCM and user-bound AAD. Never log or return plaintext keys. The master key remains outside the database and outside worker containers. Existing database data is preserved. The standalone-chat migration relaxes only `threads.project_id` from NOT NULL to nullable using a transactional table rebuild, retaining IDs, rows, indexes/triggers and inbound messages/runs references. It checks all foreign keys before commit and restores FK enforcement; migration failure stops startup.

User: `{id,username,displayName,role,disabled,usedTokens,apiKeyConfigured,keyLast4,createdAt}`. `usedTokens` includes known actual usage only.

- `GET /api/session`: `{user,csrfToken,providerConfigured,model}`; providerConfigured refers only to the logged-in user.
- `POST /api/auth/register`, `/login`, `/logout`; `POST /api/auth/password` changes only the caller's password and revokes prior sessions.
- `GET /api/account/api-key`: `{configured,last4,updatedAt}`.
- `PUT /api/account/api-key` with `{apiKey}`; `DELETE` with no target identity. Returns metadata only. Key changes fail 409 while that user has an active run.
- `GET /api/account/usage?limit=&offset=`: `{usage,total,limit,offset,totals}` scoped to caller.

Each usage row contains `{id,userId,username,displayName,runId,threadId,projectId,credentialId,keyLast4,model,inputTokens,outputTokens,totalTokens,status,source,createdAt}`. Unknown usage has nullable token counts. Key last4 and credential identity are snapshotted per request. Rotation preserves historical attribution. Totals distinguish known tokens, total requests and unknown requests.

There is no documented normal inference-key balance API. Show an explicit unavailable state and links to official OpenAI billing/usage. Site usage is not the user's global OpenAI balance or USD bill. Do not request an extra organization Admin API Key.

## Read-only administration

- `GET /api/admin/users`, `/overview`, `/audit`.
- `GET /api/admin/usage?userId=&limit=&offset=`.
- `GET /api/admin/threads?userId=&query=&limit=&offset=` -> `{threads,total,limit,offset}`; entries include owner, project, messageCount and runCount.
- `GET /api/admin/threads/:id?messageLimit=&messageOffset=&runLimit=&runOffset=` -> `{thread,owner,project,messages,runs,messagesTotal,runsTotal,nextMessageOffset,nextRunOffset,...}`. Page through complete history, cap each response's records and bytes.
- Ordinary chats appear in the same admin list/history with `project: null`; owner, messages, runs, usage and audit behavior are unchanged.
- All admin endpoints enforce admin role and audit reads. Removed quota allocation, user mutations, password-reset and credential-management routes must not be reintroduced.
- Clearly inform users that site administrators can read conversations, execution history and usage. Never imply administrators can retrieve key plaintext from the webpage.

## kibot primary conversation and display summaries

`kibot_threads` incrementally maps each user to one unique standalone thread. Opening kibot is idempotent, does not merge existing conversations or consume their 500-thread quota, and preserves the title `kibot`. Only that thread has `isPrimary: true`. Ordinary `/api/history` and `/api/threads` lists exclude it; administrator history remains complete. All new endpoints retain authentication, owner scoping and existing CSRF/origin protections for mutations. Binding a Task or execution target through the primary conversation's `work` field is rejected; ordinary question routing never grants project access. Source-linked task references and controlled delegation are described below.

- `POST /api/kibot` with `{}` -> `{thread}` initializes or returns the caller's primary thread.
- `GET /api/kibot/timeline?timeZone=&limit=&before=` -> `{threadId,timeZone,summaries,activeMessageIds,nextBefore,serverNow}`. Summaries are newest first; default 20, maximum 50 per page. Each includes `{id,kind,date,startAt,endAt,title,bullets,messageCount,segmentCount,source:'extractive'}`.
- `GET /api/kibot/history?summaryId=&timeZone=&limit=&cursor=` -> `{messages,nextCursor,total}`. Default 50, maximum 100 messages; preserve text, attachments, artifacts and citations. Byte bounds can shorten a page but never truncate an original message.
- `GET /api/threads/:id?timeZone=` for a primary thread returns only its active segment's messages, with the existing run/reply-link fields. The primary display is bounded at 2,000 messages / 16 MiB; overflow returns `kibot_current_large`, never silently drops records.

Use the same validated IANA `timeZone` for primary message reads, timeline and detail requests. The UI sends its browser timezone; omitted timezone defaults to `Asia/Shanghai`. Grouping uses server time. Today's conversations split when a new user message follows at least one hour of inactivity; the last segment remains visible until idle for one hour. Previous days become daily groups. An in-flight reply keeps its request segment visible across midnight until it ends. Cursor and summary identity are scoped to the primary thread and timezone. A segment cursor may become stale when midnight replaces it with a daily group; clients must refresh rather than reinterpret it as another range.

Display summaries are bounded extracts of original text, not model-generated completion claims. They introduce no provider call or token charge and never rewrite original messages. Independent ordinary chat retains the 200-message / 512 KiB runtime limit. The primary assistant uses the bounded source-linked working context described below; this is not native model compaction or a cross-task transcript merge. Existing realtime voice calls do not persist transcripts in `messages`; only dictation text explicitly sent through the composer participates in these summaries.

## kibot task supervision (1.15.0)

The primary thread remains a standalone question conversation and cannot bind a project via `work`. Its standard automatic text mode can call trusted application tools to list, delegate, inspect, continue and stop independent Tasks. The model never supplies the acting user/primary Run/source identity. Exact function descriptions are capability-bound; ordinary conversations and project runners cannot enable these tools. Ultra, attachments and dedicated hosted-tool modes remain analysis-only for the primary assistant, with an explicit capability notice.

`supervisor.mjs` persists a single-worker-per-user queue in `kibot_jobs`, deduplicates calls and repeated same-request delegation, and uses the existing Task/Run/environment/lease pipeline. A primary reply has a separate bounded runtime slot, so it can proceed while a worker runs. A successful enqueue survives stopping the primary reply; explicit Task cancellation stops subsequent work. Queued follow-ups wait for the current worker to finish and never claim to modify an in-flight execution. A Run is bound before dispatch, unknown startup or stop outcomes require reconciliation, and no arbitrary external operation is automatically replayed. Manual turns cannot bypass pending/unknown queue work. Server shutdown stops dispatch before closing runtimes and the database.

Completion/failure and required execution approvals create idempotent primary notifications with source Task/Job metadata. Run completion is not acceptance. The frontend polls account-scoped snapshots every four seconds while visible and refreshes on focus, preserving drafts and deferring transcript reload during primary streaming. The single-worker queue is the first supervision stage; this release does not add parallel project workers or separate worker workspaces.

- `GET /api/kibot/tasks` -> `{tasks,counts,revision}`; the current account's delegated tasks and derived state.
- `GET /api/kibot/tasks/:id` -> `{task,events,artifacts,evidence}`; owner-scoped actual results.
- `POST /api/kibot/tasks/:id/stop` -> explicit task cancellation, preserving uncertain-stop evidence.
- Primary `POST /api/threads/:id/turns` accepts optional `taskReferenceId` as a subject reference, not execution authorization; both JSON and multipart use owner validation.
- `GET /api/kibot/memory` and `DELETE /api/kibot/memory/:id` expose only the caller's notes. Assistant memory tools can record/replace/forget notes, search original primary history and page through an original message.

`primary-memory.mjs` stores assistant-maintained decisions, constraints, preferences and todos with original user-message evidence. Notes are visible and removable, not independently verified facts or fresh authorization. Admission is bounded to 200 notes and 128 KiB serialized note context; existing notes are not silently evicted. The request includes all saved notes, up to 40 whole recent messages within 128 KiB, a bounded task overview, source IDs and archive search hints. Earlier originals remain retrievable; this is bounded retrieval, not a claim that all historical constraints were automatically extracted. A task reference supplies identity and current state, while details are retrieved as needed. Tool outputs have UTF-8 budgets and explicit truncation/pagination. Task creation/changes continue to require a user request and valid owner/version checks.

Validation uses isolated server containers and fake model responses: `test/supervisor*.test.mjs`, `test/primary-memory.test.mjs`, runtime/gateway tests, and `deploy/supervisor-browser-qa.mjs`. No live account inference key is used for QA.

## Ordinary chats, projects and runs

- `GET /api/threads` -> `{threads}` lists only the caller's independent ordinary chats, excluding kibot, ordered by latest activity. No user/project query parameter is accepted.
- `POST /api/threads` with `{title?}` -> 201 `{thread}` creates an ordinary chat. Title defaults to `新对话`. It never creates a project or any project filesystem. Maximum 500 ordinary chats per user; create requests are rate limited.
- `Thread.projectId` and `Run.projectId` are `string | null`. Null means a genuine standalone chat, not a hidden project. Usage rows retain user, thread and key attribution while `projectId`/`projectName` are null.
- Existing `/api/projects/:id/threads` lists/creates only that project's chats. Project limits, ownership, UTF-8 file operations, Git diff and checkpoint operations remain unchanged.
- `/api/threads/:id`, `/api/threads/:id/turns`, `/api/runs/:id/interrupt` and `/events` support both modes with unchanged response shapes. Owner checks cover every route. Starting either mode needs the caller's own key, shares the one-active-task-per-user and server concurrency limits, and uses the same turn rate limit. No balance or admin allocation check remains.
- The API appends the user message before `runtime.start({run,thread,project,user,text})`. For ordinary chats `project` is null and no `projects.withLock`/filesystem operation occurs. On startup failure the user message is removed and the run marked failed. Project tasks retain their project lock.
- SSE sends `snapshot`, `message` and `done`; persisted output/logs support reconnect. The first submitted message's prefix is a provisional title; successful non-primary turns can update it asynchronously as described below.

Store `createThread(null,userId,title)` and `listStandaloneThreads(userId)` handle ordinary chats. `getMessagesForContext(threadId,{maxMessages=200,maxBytes=4*1024*1024})` reads ordered history including the just-appended user message and fails with HTTP 409/code `context_too_large` when limits are exceeded; context is never silently truncated. Runtime ordinary-chat execution does not need a project filesystem or Docker runner. Project execution continues using isolated workers.

Runtime `providerConfigured(userId)` checks only user credentials. Gateway capability binds user+run. Every upstream request retrieves `store.getUserApiKey(cap.userId)` and never falls back to global configuration. Runtime workers get only a short-lived gateway capability.

### Conversation title summaries (1.16.0)

`AUTO_THREAD_TITLES` defaults on. Successful ordinary/project turns schedule one asynchronous `thread_title_jobs` attempt per Run; the fixed primary name is excluded. A bounded recent transcript and previous title are submitted as untrusted data using the owner's key and the turn's model, without tools, Ultra or a default output-token override. Known title-call usage is separately attributed with `source: 'thread_title'`; missing usage remains unknown. The dedicated usage entry validates the completed Run and title job, without relaxing ordinary inference's active-Run requirement.

Apply a title only while the owner is enabled and the source is still the latest completed Run, latest message boundary and unchanged previous title. Failure or stale results retain the current title; shutdown aborts and drains calls, and restart never replays uncertain paid requests. Do not change Task goals, message content, native session IDs or conversation activity order. Existing conversations update on their next successful reply.

Thread metadata exposes optional `titlePending` and `titleUpdatedAt`. `GET /api/threads/:id/title` returns only owner-scoped `{thread:{id,title,titlePending?,titleUpdatedAt?,updatedAt}}`. The UI briefly polls pending metadata after completion and refreshes on focus; it does not reload whole transcripts just to update a navigation label. Supervisor task snapshots expose `conversationTitle` for display while preserving the original `goal`.

Output tokens follow provider defaults unless explicitly limited. An absent/blank `MAX_OUTPUT_TOKENS` leaves `max_output_tokens` absent from chat and gateway requests; explicit configuration must be a positive safe integer. The gateway preserves valid request limits and applies the smaller value only when an explicit server limit also exists. There is no 4096 fallback or 32768 clamp. Existing deployments must remove their old explicit environment value to opt into provider defaults. Provider/model limits, request timeouts, output-byte bounds and tool-loop bounds still apply independently.

`store.beginUsage(userId,runId,{model,keyLast4})` starts a request record. `settleUsage(id,{status,inputTokens,outputTokens,totalTokens})` is idempotent; statuses completed/unknown/failed, only completed usage enters actual totals. No input-token-count preflight, reservations or platform deductions. Interrupted requests without reliable usage remain unknown rather than becoming zero or estimated cost. Legacy usage stays readable and legacy estimated rows are excluded from actual totals.

## Boundaries

OpenAI origin is fixed to `https://api.openai.com/v1`. No user-controlled base URLs, provider-hosted tools, shared provider conversations or remote file IDs. Sanitize provider error bodies before returning them to the runner/client. Keep CPU/memory/PID/storage/request/output/time/concurrency limits, path checks, owner checks and per-run Docker internal network isolation for project execution. The trusted API alone has the Docker socket and private egress helper. The worker has no real OpenAI key, no Docker socket, no host shell permissions, and only its own project's mounts. Ordinary chats have no project mounts, shell or file tools.
