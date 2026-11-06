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

## Ordinary chats, projects and runs

- `GET /api/threads` -> `{threads}` lists only the caller's ordinary chats, ordered by latest activity. No user/project query parameter is accepted.
- `POST /api/threads` with `{title?}` -> 201 `{thread}` creates an ordinary chat. Title defaults to `新对话`. It never creates a project or any project filesystem. Maximum 500 ordinary chats per user; create requests are rate limited.
- `Thread.projectId` and `Run.projectId` are `string | null`. Null means a genuine standalone chat, not a hidden project. Usage rows retain user, thread and key attribution while `projectId`/`projectName` are null.
- Existing `/api/projects/:id/threads` lists/creates only that project's chats. Project limits, ownership, UTF-8 file operations, Git diff and checkpoint operations remain unchanged.
- `/api/threads/:id`, `/api/threads/:id/turns`, `/api/runs/:id/interrupt` and `/events` support both modes with unchanged response shapes. Owner checks cover every route. Starting either mode needs the caller's own key, shares the one-active-task-per-user and server concurrency limits, and uses the same turn rate limit. No balance or admin allocation check remains.
- The API appends the user message before `runtime.start({run,thread,project,user,text})`. For ordinary chats `project` is null and no `projects.withLock`/filesystem operation occurs. On startup failure the user message is removed and the run marked failed. Project tasks retain their project lock.
- SSE sends `snapshot`, `message` and `done`; persisted output/logs support reconnect. The default new-chat title becomes the first submitted message's prefix after an accepted task.

Store `createThread(null,userId,title)` and `listStandaloneThreads(userId)` handle ordinary chats. `getMessagesForContext(threadId,{maxMessages=200,maxBytes=4*1024*1024})` reads ordered history including the just-appended user message and fails with HTTP 409/code `context_too_large` when limits are exceeded; context is never silently truncated. Runtime ordinary-chat execution does not need a project filesystem or Docker runner. Project execution continues using isolated workers.

Runtime `providerConfigured(userId)` checks only user credentials. Gateway capability binds user+run. Every upstream request retrieves `store.getUserApiKey(cap.userId)` and never falls back to global configuration. Runtime workers get only a short-lived gateway capability.

`store.beginUsage(userId,runId,{model,keyLast4})` starts a request record. `settleUsage(id,{status,inputTokens,outputTokens,totalTokens})` is idempotent; statuses completed/unknown/failed, only completed usage enters actual totals. No input-token-count preflight, reservations or platform deductions. Interrupted requests without reliable usage remain unknown rather than becoming zero or estimated cost. Legacy usage stays readable and legacy estimated rows are excluded from actual totals.

## Boundaries

OpenAI origin is fixed to `https://api.openai.com/v1`. No user-controlled base URLs, provider-hosted tools, shared provider conversations or remote file IDs. Sanitize provider error bodies before returning them to the runner/client. Keep CPU/memory/PID/storage/request/output/time/concurrency limits, path checks, owner checks and per-run Docker internal network isolation for project execution. The trusted API alone has the Docker socket and private egress helper. The worker has no real OpenAI key, no Docker socket, no host shell permissions, and only its own project's mounts. Ordinary chats have no project mounts, shell or file tools.
