# kivo 跨会话工作连续性

本轮是通用 Super Agent 改造的**阶段 1–3 基础实现**：在现有 Express、SQLite、React 与执行器外层增加稳定工作身份、目标路由、任务上下文和可核对的执行记录。它保留现有模型与工具循环，不代表已实现完整的长期自主 Agent。原生自动压缩、持久多 Worker 调度和可信外部事件入口尚未实现。

## 当前集成与职责

| 路径 | 实际执行引擎 | 本轮应用层职责 |
| --- | --- | --- |
| 普通聊天 | OpenAI Responses API、SSE、已有图片/搜索/文件分析、取消和真实用量 | 普通问答范围；显式持续任务的必要历史、产物来源及版本 |
| 云端项目 | 固定 `@openai/codex@0.167.0` app-server，在独立 Docker 中 `thread/start`、`thread/resume`、`turn/start` | Task/Run/Engine Session 绑定、目标租约、环境检查、验收和续跑条件 |
| 本地项目 | 同版 app-server，通过配对助手在用户电脑执行 | 设备归属、干净线程、审批、停止确认和结果未知状态 |

云端 `danger-full-access` 限于现有非 root、只读根文件系统、单项目挂载和隔离网络的容器。本地继续使用 `workspace-write`、`on-request` 及禁用网络的沙箱；未知交互拒绝。路由和参考材料不能扩大执行器权限。本人 API Key、短期网关凭据、用量记录、SSE、项目锁和本地审批继续复用。

| 模块 | 职责 |
| --- | --- |
| [`work-store.mjs`](server/work-store.mjs) | SQLite 权威状态、归属校验、版本、租约、消息范围、证据和产物依赖 |
| [`work-routing.mjs`](server/work-routing.mjs) | 确定性意图与目标解析、有限候选、冲突和消歧；不调用路由模型 |
| [`work-context.mjs`](server/work-context.mjs) | 来源清单、任务历史片段、参考产物、预算检查 |
| [`engine-adapter.mjs`](server/engine-adapter.mjs) | 已集成能力、环境快照、新建/继续/重建/分叉决策 |
| [`work.mjs`](server/work.mjs) | 将路由、对象、上下文与运行绑定连接起来 |
| [`work-requests.mjs`](server/work-requests.mjs) | HTTP 执行请求去重及内容冲突检测 |
| [`app.mjs`](server/app.mjs)、[`runtime.mjs`](server/runtime.mjs) | 身份和 CSRF、实际目标锁、引擎调用、取消、迟到结果检查与停止结算 |
| [`WorkContext.tsx`](client/WorkContext.tsx) | 工作方式/目标选择、候选确认、任务检索、产物和人工验收 |

## 身份、路由和普通问答

Conversation 是网页对话，Work Object 是持续处理的对象，Task 是有目标、约束与完成条件的工作，Run 是一次执行尝试，Engine Session 是一个引擎上下文。任务可以跨多个对话；对话也可以承载多个任务。`run.projectId` 来自当次任务的操作目标，不要求等于对话原有的 `thread.projectId`。切换执行目标不会搬移或改名原对话。

对象支持 `repository`、`document`、`research`、`asset`、`collection`。项目通过稳定 `projectId` 映射对象；聊天标题、文件名、相似技术栈和相同 Git remote 不构成工作区身份。非项目对象不要求仓库字段。任务的对象关联明确分成 `target` 和 `reference`：一次执行最多写一个目标，参考对象不获得挂载目录或写租约。

显式 `taskId` / `objectId` 优先；发生冲突时阻塞。名称、别名和当前对话焦点提供候选依据，多个合理目标必须选择，不按最近使用时间直接写入。现阶段检索使用本人可访问的 SQLite 记录、名称/别名和任务目标，不含向量索引或语义召回服务；列表和候选有数量上限。找不到可确认的旧任务、历史尚未关联或检索失败，不会自动伪造一个续跑任务。

选择 `question` 后，当前对话的工作焦点清空并保留 `explicit_question` 标记。后续普通问答不会因对话原属项目而自动重新获得项目权限。普通问答不创建 Task，不额外调用路由模型；它仍有原有的 Run 和用量记录。已接管或项目混合对话只加载明确标记的普通问答消息，排除 Task 消息。尚未接管的旧独立聊天仍兼容原普通历史。工作状态响应中的 `executionScope` 区分 `task`、`question`、`legacy_project`，前端据此显示当次执行范围。

## 模式和 HTTP 契约

`WORK_ROUTING_MODE=off|shadow|enforce` 默认 `shadow`，变更配置后需重启应用。

| 模式 | 未接管的旧对话 | 已有 managed 标记的对话 |
| --- | --- | --- |
| `off` | 使用旧路径；拒绝新的显式工作选择 | 拒绝执行，返回 `work_routing_disabled` |
| `shadow` | 使用旧路径，同时记录路由决策；影子失败只审计，不改变旧目标 | 拒绝执行，避免重新解释原对话项目 |
| `enforce` | 按路由定位目标；歧义、权限、版本、预算失败即阻塞 | 按 Task 或明确普通问答范围执行 |

`shadow` 不接受显式工作切换，返回 `work_observation_only`；不会默默忽略用户选定的新目标。managed 标记持久保存，不会因清空焦点或裁剪焦点历史而丢失。绑定 Task 或位于 managed 对话中的旧 Run（包括尚无 Task 绑定的旧记录）也不能在 off/shadow 中走旧续跑路径。

接口沿用登录会话、本人归属校验、同源及 CSRF。对象和任务变更接口仅在 enforce 启用；路由预览不启动执行，发送接口遵循上面的模式规则：

| 接口 | 输入/结果 |
| --- | --- |
| `GET /api/work`、`GET /api/threads/:id/work` | 本人对象与任务；对话接口额外返回焦点、执行范围、产物、会话及决策 |
| `GET /api/work/objects?q=...`、`GET /api/work/tasks?q=...&objectId=...` | 授权范围内检索；每次最多返回 200 项 |
| `GET /api/work/tasks/:id` | 任务、关联消息、证据、产物、执行会话与最近 Run |
| `POST /api/threads/:id/route` | `{text, work?}`；只预览/记录路由，不启动模型或创建任务 |
| `POST /api/threads/:id/turns` | 现有发送接口增加 `requestId` 和可选 `work`；成功返回 `202 {run}` |
| `POST /api/work/objects` | `kind`、`name`、可选别名/身份元数据；已有项目由 `projectId` 关联 |
| `PATCH` / `DELETE /api/work/objects/:id` | 必须带 `expectedVersion`；项目执行位置不能用元数据重定向 |
| `POST /api/work/tasks` | `goal`、对象关联和可选 `constraints` / `acceptance` |
| `PATCH /api/work/tasks/:id` | `expectedVersion` 与修订内容；增加版本/代次，使旧会话与相关产物失效，并停止该任务在途 Run |
| `POST /api/work/tasks/:id/history` | `expectedVersion`、`conversationId`、`startMessageId`、可选 `endMessageId`；明确关联连续消息范围，单次最多 500 条 |
| `POST /api/work/tasks/:id/cancel` | `expectedVersion`；取消任务并请求停止执行，不撤销已经发生的文件或外部操作 |
| `POST /api/work/tasks/:id/reconcile` | `expectedVersion`、`runId`；核实停止后释放租约，云端实际检查容器；本地暂不支持自动解锁 |
| `POST /api/work/tasks/:id/accept` | `expectedVersion`、`artifactId`；人工确认本任务当前有效的具体产物版本 |

`work` 仅接受 `intent`、`taskId`、`objectId`、`referenceIds`、`focusRevision`、`taskVersion`。意图有 `question`、`new`、`continue`、`fork`、`revise`、`reference`、`compare`、`cancel`、`pause`；后两者在发送接口只识别目标并提示使用停止操作，未实现原生暂停。参考实现必须明确区分目标与参考对象。比较及分叉创建独立 collection；不会自动复制代码工作区。

enforce 下每次发送必须有 `requestId`，包括普通问答；客户端使用随机 UUID，服务端接受 16–100 位字母、数字、下划线或连字符。去重键作用域是用户和对话。重复 ID 且内容相同返回原 Run 与 `replayed:true`，不会再次调用模型；复用 ID 改文字、目标、模型或文件返回 `work_request_conflict`。已登记但尚未绑定 Run 的请求不会被自动重放，需要核对后用新 ID 重发。这是应用请求去重，不是任意命令或外部 API 的 exactly-once 保证。

## 引擎生命周期和环境

| 决策 | 实际行为 |
| --- | --- |
| 新建 | 新 Task 和独立引擎会话；不复用其他任务的供应商线程 |
| 继续 | 同一 Task、任务版本一致、旧会话 ready、线程可用且云端环境兼容，才 `thread/resume` |
| 重建 | 保留 Task、约束和来源，从必要上下文创建干净线程 |
| 分叉 | 新 Task、父任务关系和只读来源；使用干净线程，没有原生 fork RPC |
| 修订 | 保留当前 Task，从已核实产物和约束建立干净线程；显式修改目标/约束走版本化 PATCH |
| 阻塞 | 旧执行未停止、资源占用或绑定无法核实，不开始写操作 |

云端 `projects.executionEnvironment()` 在项目锁内读取真实路径与设备/inode、Git 分支和基准提交，计算包含已跟踪与未跟踪文件内容的工作区指纹，记录已有修改路径。它拒绝根目录被 symlink 替换、核查期间文件改变及超过扫描边界的工作区。dirty 文件不是拒绝理由；现有修改必须保留，不执行 reset 清理。运行前再次核查环境；branch、clone、目录替换、文件版本变化会阻止旧绑定写入或使下次执行选择重建。

本地助手当前只能核实设备归属及绑定相对路径，不能端到端证明 branch/checkout 内容。因此快照标记 `verified=false`、`reusable=false`、`requiresLocalValidation=true`，使用干净线程；实际文件权限仍由助手路径检查、沙箱和审批约束。此轮没有本地版本条件写入保证。

Responses 每次只提交本次组装的上下文，不伪造持久供应商 thread。能力表明确：停止通过 abort 请求、停止容器或停止本地进程组；未接入原生 `turn/interrupt`、native fork、native pause、thread/read 或自动 compaction。模型/工具循环仍由现有 Responses 或 Codex 执行器负责。

## 上下文、证据和产物依赖

持续任务上下文包含当前请求、目标和参考对象、目标/约束/完成条件、执行位置、明确关联的历史消息、证据、产物及最近运行记录。历史消息携带原对话和消息 ID；不因聊天标题相似而复制整段混合对话。引用材料作为 user data 提交，不能充当高优先级指令或授予新权限。

引用对象时检索该对象作为目标的任务，只使用当前有效产物及来源摘录，不读取参考项目目录。当前每个参考对象最多检索 20 个相关任务，每个任务最多取 8 个当前产物，消息摘录最多 12,000 字符，并标记不完整；它不是全量文档检索。上下文返回 `inputArtifactIds`，Run 绑定时锁定产物及源 Task 版本。后续事件和结果再次校验这些输入；源产物失效或撤权后，旧执行结果不能升级当前任务。

成功回复及文件会登记为产物，并自动记录所消费输入的依赖边。修改上游任务、替换产物或失去原始来源时，下游产物变为 stale；相关验收证据失效，已验收任务需要重新核对。这个依赖图用于校验现有结果，不会自动启动下游重算。

Run completed 只表示一次执行结束。任务没有独立验收时进入 `waiting_input`。只有已持久化的独立检查成功结果，或用户通过 accept 明确确认当前具体产物版本，才能成为 `succeeded`。人工验收保存 `authority=user_acceptance`、操作者、产物版本和审计，不伪造测试退出码。存在未停止执行、租约、已取消任务或 stale 产物时拒绝人工验收。

`WORK_CONTEXT_BYTES` 默认 `393216` 字节。`WORK_MODEL_BUDGETS` 可配置 `{ "model-id": { "contextTokens": 123456, "inputTokens": 100000 } }`，必须填已核实的模型限制；不会根据名称猜测窗口。显式配置扣除输出预算和固定指令/工具预留后，以 UTF-8 字节上界保守控制输入，不是精确 tokenizer 测量。未配置的模型只使用应用字节上限。

持续任务超过字节预算、超过允许历史条数或历史读取不完整时返回 `work_context_budget`，保留原始记录并停止执行，不静默删除约束。普通问答沿用 200 条/512 KiB 限制。两条路径均**没有自动压缩或模型摘要压缩**；任务清单和干净线程重建也不能称为原生压缩。

## 状态、租约和恢复

Task version 表示用户目标/约束版本，generation 区分执行代次，Run 绑定保存租约令牌、对象版本、输入产物版本和环境。任务、目标对象及实际项目有持久租约；既有文件写入、删除、提交及旧执行入口也检查项目租约。焦点使用对话范围的 revision，后台完成不改变其他窗口的焦点。

取消、修订、撤权或输入失效后，迟到事件不能改变当前 Task 或产物。原 Run 保留可核查记录，重复结算幂等。模型网关也校验运行绑定，过期任务不能继续使用原短期凭据。

服务启动先将原有 running Run 标为 interrupted，将未结算用量与未完成检查标为未知，再将工作绑定标为 `needs_reconciliation`，会话标为 stale，保留租约。它不认为进程必然已停，也不自动重放任务。云端可通过 reconcile 或已有续跑接口核实容器停止后解锁；续跑仍核对最新任务版本、当前文件与旧结果，保留用户已有修改。

本地 `run.start` 与 `run.stop` 都未得到确认时，即使 HTTP 返回失败、Run 已结束，租约仍保留，后续文件写入受阻。本地 reconcile 返回 `work_local_reconciliation_required`，目前没有网页自动解锁。助手队列仍在内存；断联、超时或服务器 epoch 改变不代表副作用已撤销。任意 shell、发送、部署或外部写 API 的未知结果都需要实际检查，不能自动重试。

容量不足、目录检查失败等明确发生在执行派发之前的错误会释放本次租约；运行时以派发回调区分“没有启动”与“启动结果未知”，不会将本地应答丢失误判为未执行。

## 迁移、上线与回滚

阶段 1–3 已落地基础身份/关系、路由模式、任务上下文、干净重建、来源依赖与人工验收。下一阶段才考虑持久多 Worker、外部事件、语义检索、自动压缩和可靠外部副作用恢复。本轮没有引入图数据库或独立调度服务，也没有把已有 Ultra 单次多代理调用改为可独立分配 workspace 的持久 Worker。

SQLite 增量创建 `work_*` 表及索引，保留原用户、项目、会话、消息、Run 和密钥记录。已有项目按稳定项目 ID 幂等同步对象；对话按需登记，不批量猜测旧消息的 Task 归属。`historyStatus=empty|unassigned|partial|linked` 和未关联数量反映现有消息关联情况，不是后台语义索引进度。旧历史由用户明确选择连续消息范围关联；重复关联去重，新增关联会推进 Task 版本并使旧上下文和产物失效。不存在自动把相似旧会话合并为同一任务的迁移器。

上线前在服务器对一致数据库副本检查增量表、原数据指纹及外键，执行构建和相关测试。确认在途执行已结束或已核实停止，保存数据库、项目文件、源码/镜像、Compose、环境配置和凭据加密主密钥的配套备份，再改变流量。测试和构建按项目约定仅在服务器进行。默认 shadow 可先观察未接管会话的决策，再明确切为 enforce；一旦接管，失败不会偷偷落回旧执行路径。

**优先回滚方式是保留包含保护逻辑的新 binary，将模式切为 off 或 shadow。** 新 binary 会拒绝 managed 会话和绑定 Task 的旧 Run 继续执行；用户可以新建普通对话，既有记录仍可核查。持久租约也继续阻止未确认停止的项目写入。

**不能将包含 managed 混合会话的新数据库直接交给完全旧 binary。** 旧版本不认识任务实际目标、问答范围和持久租约，可能把原对话项目误当作新目标。若必须恢复旧 binary，应先停写、核实所有执行停止，再恢复与该 binary 配套的升级前数据库和必要工作区备份；期间新增数据应先留存，不能覆盖丢弃。只有经过代码审查、确认保留相同 guard/租约语义的兼容旧镜像，才可与新库共同使用。勿删除新表或手工清空 lease 来绕过保护；加密主密钥不能重建。

## 验收覆盖与未实现项

下表指向确定性测试。它们的通过状态见下方服务器验收记录；模拟接口通过不等同于真实模型或设备调用通过。

| 场景 | 应满足的行为 | 测试来源 |
| --- | --- | --- |
| 同名对象、相似故障、历史无法确认 | 有限候选/未解决，拒绝猜测写入 | [`work-routing.test.mjs`](test/work-routing.test.mjs) |
| 明确 A、焦点 B；对话原项目 A、实际目标 B | 绑定明确目标；Run 与 Conversation 项目独立 | [`work-routing.test.mjs`](test/work-routing.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| 跨对话继续与同对话多个任务 | 只带所选 Task 的消息范围，独立任务不串上下文 | [`work-context.test.mjs`](test/work-context.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| 普通问答、项目内切回问答 | 不创建 Task，不继承 Task/未分配项目消息 | [`work-store.test.mjs`](test/work-store.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| new/fork、旧会话失效、任务版本不同 | 独立线程或重建，不复用其他 Task | [`engine-adapter.test.mjs`](test/engine-adapter.test.mjs)、[`work-store.test.mjs`](test/work-store.test.mjs) |
| 改名、clone、branch、根目录替换、tracked/untracked 变更 | 稳定身份与真实文件指纹，保留 dirty 文件 | [`engine-adapter.test.mjs`](test/engine-adapter.test.mjs)、[`work-environment.test.mjs`](test/work-environment.test.mjs) |
| 参考 A 完成 B 后修改 A | 只读来源、固定输入版本、B 产物 stale | [`work-store.test.mjs`](test/work-store.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| 取消、版本纠正、重复请求、迟到完成 | 幂等、CAS、过期结果不更新当前 Task | [`work-store.test.mjs`](test/work-store.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| 崩溃、本地停止无确认、手动文件写入 | 待核对并保留 lease，禁止并发写 | [`work-store.test.mjs`](test/work-store.test.mjs)、[`work-integration.test.mjs`](test/work-integration.test.mjs) |
| enforce 回退 off/shadow | managed 会话受阻，不改写原项目 | [`work-integration.test.mjs`](test/work-integration.test.mjs) |
| 人工验收、上游失效、来源删除 | 绑定具体有效版本，不冒充自动测试，失效后需重核 | [`work-store.test.mjs`](test/work-store.test.mjs) |
| 超预算、跨用户、撤权、引用注入 | 保留原文、授权前置、材料不升权 | [`work-context.test.mjs`](test/work-context.test.mjs)、[`work-routing.test.mjs`](test/work-routing.test.mjs) |

HTTP 整合测试使用真实 app/runtime 和模拟 Responses；本地错误用模拟桥接应答；文件环境测试使用临时真实 Git 工作区。它们不证明真实用户 Key 的付费模型调用、真实本地设备或跨服务器部署已验收。当前仍为单服务/SQLite 模型，没有实现分布式多实例调度。

持续任务暂不接收新附件，需切普通问答后上传；参考产物检索有明确摘录边界。原生自动 compaction、持久多 Worker、可信外部事件入口、任意外部副作用自动恢复、语义召回及本地 checkout 版本条件写入均不在已完成范围。

## 本轮验收记录（2026-11-10）

- 远端容器完整测试 **185/185 通过**，TypeScript 检查及 Vite 构建通过；没有在本地运行应用或测试。包括派发前容量拒绝释放租约，以及 managed 对话的旧无绑定 Run 禁止绕过续跑保护。
- 使用生产数据库副本验证增量迁移：旧 20 张表共 244 行的逐行 SHA-256 与行数保持不变，新增 19 张表。按稳定身份登记副本中的 2 个用户、4 个对话后得到 5 个工作对象、0 个 Task，没有猜测历史任务归属；外键检查返回 0 项。重复初始化及登记后，全表指纹一致。验收副本已删除，未修改生产数据库。
- Chrome 实测同名研究任务会要求消歧，不自动选中；选择 A 后绑定 A 执行。人工确认产物 v1 后 Task 推进到 v2；新建对话仍可继续同一 Task。
- Chrome 实测切换普通问答后任务焦点清空、语音入口恢复，原 Task 状态保持不变。
- [`work-runner-smoke.mjs`](test/work-runner-smoke.mjs) 在 Ubuntu 使用真实 Codex app-server 0.167.0 和模拟模型通过：实际工具写文件；文件变化后重建线程；同一任务跨对话、环境一致时恢复原线程；未关联历史不进入任务包；执行结束等待验收；取消中断实际容器且租约归零。共 5 次模拟请求，临时数据和网络均已清理。

以上记录没有把模拟 Responses 结果计作真实付费模型验收，也未据此声称真实本地助手或分布式部署已经验证。

## 对话内执行记录与来源（2026-11-10）

默认工作台移除常驻的对话和项目侧栏，顶部保留「新对话」「搜索历史」「工作对象」「账户与管理」。历史搜索按本人对话标题匹配，最多返回最近 100 条；项目仍可通过工作对象弹窗进入。导航支持 Escape 关闭、焦点约束和返回触发按钮。

每条新助手回复通过 `run_reply_links` 关联其真实 Run，单独展开该次执行活动。`run_context_snapshots` 保存本次组装的上下文来源 ID 和执行会话映射，不复制历史消息正文；读取时重新校验来源权限、删除和失效状态。来源按历史对话分组，可展开引用片段及已记录的来源 Session/Run；工作对象、任务和参考产物显示所用版本。本次执行会话另行展示创建、恢复或重建状态，以及真实的 Session、引擎线程和 Run 标识。

普通 Responses 请求的历史引用不表示恢复历史执行会话。恢复 Codex 原生线程时，显式来源清单不覆盖引擎内部保留的全部工具历史，界面会说明这一边界。这些面板展示工具活动与输入来源，不声称提供模型内部思维链。仅保存附件的操作明确标注没有调用模型。旧记录没有来源映射时显示未记录，不按时间或相同文本猜测补造。

两张新增表使用增量创建与外键级联，原有消息和运行记录不重写。`GET /api/threads/:id` 返回回复绑定，`GET /api/runs/:id/context` 返回授权来源，`GET /api/history?q=` 支持历史标题搜索。

此轮 Ubuntu 隔离容器完整测试 **187/187 通过**，TypeScript 检查和 Vite 构建通过。覆盖回复关联、跨用户访问拒绝、跨会话任务来源隔离、来源删除、旧记录兼容及会话标识更新。Chrome 使用服务器上的模拟模型实测连续两轮回复、逐轮执行日志、引用片段和来源 Session、历史搜索、项目入口及 Escape 关闭；没有调用付费模型。该记录是发布前验收结果，实际发布版本以服务器部署清单及远端 main 为准。
