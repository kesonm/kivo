# kivo

Cloudflare 免费 Worker + 现有 Ubuntu 完整功能部署见 [Cloudflare 部署说明](cloudflare/README.md)。新域名配置为 `https://kivo.iptnet.xyz`，数据库、个人 Key 和 Codex 项目执行器保留在原服务器。

基于 OpenAI Responses API 与官方 Codex app-server 的多用户浏览器工作台。部署地址：<https://kivo.iptnet.xyz>。官方仓库源码保留在上级目录，网页服务位于 `web/`，执行器固定使用 `@openai/codex@0.167.0`。

## 跨会话工作连续性

本轮提供阶段 1–3 基础实现：独立工作对象和 Task、明确目标与只读参考、跨对话上下文、产物版本依赖、执行租约和人工验收。普通问答仍可直接发送，不额外调用路由模型。配置默认 `WORK_ROUTING_MODE=shadow`；启用方式、HTTP 契约、上下文预算、迁移和验收覆盖见 [工作连续性说明](WORK_CONTINUITY.md)。原生自动压缩、持久多 Worker 和可信外部事件入口尚未实现。

已有 managed 混合会话的新库不能直接回滚给完全旧 binary。优先保留新 binary，切为 off/shadow，由保护逻辑阻止这些对话执行。恢复完全旧版本需要停写并使用配套备份；本节规则优先于下方历史版本的简化回滚说明，详见 [迁移、上线与回滚](WORK_CONTINUITY.md#迁移上线与回滚)。

## 统一对话入口与执行来源

工作台不再常驻显示左侧对话和项目列表；顶部提供新对话、搜索历史、工作对象和账户入口。每轮新回复分别展示可展开的执行活动、实际组装的上下文来源与本次执行会话。历史来源可查看引用片段及已记录的 Session/Run，旧记录没有来源映射时明确显示未记录。实现与边界见 [对话内执行记录与来源](WORK_CONTINUITY.md#对话内执行记录与来源2026-11-10)。

## iOS 与扫码登录（1.5.0）

登录页保留账号密码，增加“App 扫码登录”。iOS 个人测试客户端位于 [`ios/`](../ios/README.md)，使用 SwiftUI 原生外壳、WKWebView 工作台与 AVFoundation 相机。登录现有账号后扫码，核对域名、浏览器及六位确认码，再明确确认，电脑网页登录同一账号。iPhone 不直接运行 Codex，继续操作云端或已配对电脑上的项目。

二维码仅包含 256 位随机授权挑战，服务器只存哈希；120 秒过期，只绑定生成它的匿名网页 Cookie。手机扫描不登录网页，必须另行确认；只有原浏览器能兑换新会话，旧会话和二维码随即销毁。手机授权绑定具体登录会话，退出、修改密码、停用账号均阻止尚未兑换的授权。所有变更接口继续校验 JSON、同源与 CSRF，增加频率限制与授权审计。二维码由本站生成，没有第三方二维码服务或长期登录令牌出现在二维码中。

新增 SQLite `qr_logins` 表及索引，旧账号、会话、项目和密钥不迁移、不覆盖。部署前先构建 `codex-workspace-build:1.5.0`、执行全套测试，再构建 `codex-workspace-web:1.5.0`。确认没有运行任务，备份数据库及运行配置后仅替换 web 容器；保留 Tunnel、代理、数据库卷及加密主密钥。回滚使用旧镜像和旧 Compose 即可，新表可保留。

## 本地助手（1.4.0）

侧栏“本地助手”提供安装、设备配对和撤销授权。“创建项目”可在已配对电脑的授权父目录中创建文件夹或打开现有项目；普通聊天输入框的文件夹按钮也可以打开本地项目。云端项目继续可用。

本地文件操作、代码差异和 Codex 命令在用户电脑上执行，额外命令或文件权限在网页逐次审批。文件检查点不修改 Git 历史，移除网页项目不会删除本机目录。助手通过 HTTPS 主动连接网站，不需要开放本机端口；模型上下文、对话和执行日志仍经过 kivo 服务器，使用本人已配置的 API Key 记录实际用量。安装、权限边界及验收说明见 [本地助手部署说明](deploy/LOCAL_ASSISTANT.md)。

## 普通聊天与项目（1.3.0）

登录后的首页和侧栏“新对话”直接进入普通聊天，无需创建或选择项目。第一次发送时创建独立会话，侧栏“最近对话”保留历史。普通聊天使用自己的 OpenAI API Key，支持连续上下文、流式回复、停止和实际 token 记录；不创建隐藏项目，也不读取项目文件或运行命令。

“项目空间”保持独立：选择项目后可创建项目对话、上传编辑文件、查看代码差异和保存版本。侧栏顶部“新对话”始终回到普通聊天，项目会话通过项目下的“新建项目对话”开启。管理员可只读查看两类会话，普通记录显示“普通聊天”。

普通会话的 `project_id` 为 NULL。升级会事务性重建旧 threads 表以移除 NOT NULL，并验证外键，保留现有项目、消息、运行及用量记录。普通聊天仅重放当前会话的用户和助手文本；历史超过 200 条消息或 512 KiB 时提示新建会话，不静默丢弃历史。实现参考 [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)。

## 浏览器界面（1.2.0）

采用浅色对话布局：项目与会话侧栏可收起，空白会话输入框居中，开始对话后输入框位于底部。项目页面顶部“聊天 / 工作”切换文件与差异面板；输入框的 `+` 也可以打开项目文件。默认进入聊天模式。账户设置、只读后台与登录注册使用一致的中性色与清晰字号，保留用户提供的 Logo。

## 个人 OpenAI API Key

所有用户（包括管理员）登录后，在 **账户设置 → 我的 OpenAI API Key** 中保存自己的普通 OpenAI API Key，即可用于自己的普通聊天和项目。可替换或移除 Key；该用户有任务运行时必须先停止任务。保存成功表示凭据已保存，不代表账户余额、模型权限或密钥有效性已通过 OpenAI 验证。

- 网站只显示末四位，不返显完整 Key。Key 用 AES-256-GCM 加密并绑定用户身份，解密主密钥与数据库分开保存在服务器。
- 每次模型请求只使用发起用户自己的 Key，不回退到管理员或全局 Key。隔离执行器只收到短期任务令牌，不接触真实 Key。
- 取消平台额度、额度分配、预留和充值。费用直接计入用户自己的 OpenAI 账户。
- 管理员可在「模型」中勾选普通聊天可用的模型，并用上下箭头排序。保存后，聊天菜单按该顺序显示，第一个勾选的模型为默认。用户、用量和会话记录仍为只读，后台不显示完整 Key。
- 注册及工作台会告知用户：管理员可以查看会话记录。

旧版 `/etc/codex-web/openai-api-key` 文件不再挂载或使用。无需在服务器填写用户的 OpenAI Key；旧文件保留以便回滚，不会自动分配给任何用户。

## 余额和消耗

账户页显示本站每次模型请求的模型、时间、Key 末四位、输入、输出、总 token 和状态，换 Key 不会删除历史记录。缓存输入包含在输入 token 中，推理 token 包含在输出 token 中，不重复计数。

只有 OpenAI 返回的可靠 usage 才计入实际 token 总量；中断后未返回 usage 的请求标为未知，不伪装成实际零消耗，也不估算扣除平台额度。历史旧版估算记录仍与实际用量区分。

**普通推理 API Key 没有已公开文档支持的账户余额查询接口。** 官方组织 Usage/Costs 接口需要单独的 OpenAI Admin API Key，网站不索取这一额外管理凭据。账户页提供官方入口：

- [OpenAI 账户余额与账单](https://platform.openai.com/settings/organization/billing/overview)
- [OpenAI 全账户用量](https://platform.openai.com/usage)
- [官方 Usage/Costs API 说明](https://developers.openai.com/cookbook/examples/completions_usage_api)

本站 token 记录只覆盖通过本站发生的调用，不包含同一 Key 在其他应用的消耗，也不等同于美元账单或账户剩余余额。

项目品牌和软件包名称为 `kivo` / `kivo-web`。现有部署路径、容器及密钥绑定标识保留 `codex-web` / `codex-workspace`，兼容已有数据库与运维配置。

## 部署位置

| 服务器路径 | 用途 |
| --- | --- |
| `/opt/codex-web/current` | 应用源码、Compose 和运维脚本 |
| `/var/lib/codex-web` | SQLite、各项目文件和 Codex 历史 |
| `/etc/codex-web/app.env` | 模型、域名、资源限制及出网配置 |
| `/etc/codex-web/credentials-key` | 32 字节随机凭据加密主密钥，root 600，不能随意重建 |
| `/etc/codex-web/admin-password` | 初始管理员密码，root 600 |
| `/etc/codex-web/openai-proxy.json` | 专用出网配置，root 600 |
| `/opt/codex-web/vendor/v2ray` | 专用出网程序独立副本 |
| `/opt/codex-web/backups` | 版本升级前的受限备份 |

管理员初始账号为 `admin`，初始密码读取方式：

```sh
ssh ubuntu
sudo cat /etc/codex-web/admin-password
```

登录后可在个人账户设置中修改自己的密码。密码文件仅用于首次创建管理员，并不覆盖数据库中的后续修改。

## 运行和更新（仅服务器）

首次部署时，将本仓库 `web/` 内容放入服务器 `/opt/codex-web/current`，准备 Docker、Compose、Nginx 和 HTTPS 证书。创建 `/var/lib/codex-web` 与仅 root 可读的 `/etc/codex-web`，复制 `deploy/app.env.example` 到 `/etc/codex-web/app.env`，设置自己的 HTTPS 地址和可访问的模型。首次生成 `/etc/codex-web/credentials-key`（32 字节随机原始数据）与 `/etc/codex-web/admin-password`（至少 12 位随机密码），权限均设为 `600`；已有部署绝对不要重新生成这些文件。

先构建项目执行器：`sudo docker build --network host -f deploy/Dockerfile.runner -t codex-workspace-runner:0.167.0 .`。按下面步骤构建并启动网页，安装已替换域名和证书路径的 Nginx 模板。能直接访问 OpenAI 的服务器无需启动 `openai-proxy`；该可选服务需要另行准备个人出网配置和程序，公开仓库不附带代理凭据。仓库中继承的上游发布工作流在新 kivo 仓库默认禁用，避免运行仅适用于 OpenAI 上游的发布流程。

按要求，不在本地启动、构建或测试应用。服务器执行：

```sh
ssh ubuntu
cd /opt/codex-web/current
sudo install -m 755 /usr/bin/docker deploy/docker-cli
sudo docker build --network host --pull=false \
  --build-arg DEBIAN_MIRROR=http://mirrors.tencentyun.com \
  -f deploy/Dockerfile --target build -t codex-workspace-build:1.4.1 .
sudo docker run --rm --network none codex-workspace-build:1.4.1 npm test
sudo docker build --network host --pull=false \
  --build-arg DEBIAN_MIRROR=http://mirrors.tencentyun.com \
  -f deploy/Dockerfile -t codex-workspace-web:1.4.1 .
sudo docker compose -f deploy/compose.proxy.yaml up -d openai-proxy
sudo docker compose -f deploy/compose.yaml up -d --force-recreate web
```

日常查看状态：

```sh
sudo docker logs --tail 100 codex-workspace-web
sudo docker compose -f /opt/codex-web/current/deploy/compose.yaml ps
sudo systemctl status codex-cert-renew.timer
```

两个 Compose 文件分别维护同一项目的网页与专用出网服务；不要使用 `--remove-orphans`，否则可能停止另一个所需容器。二者均自动重启。`deploy/nginx.conf` 是部署模板，安装时替换示例域名与证书路径。Nginx 提供 HTTPS，应用端口仅绑定 `127.0.0.1:18300`。IP 证书由定时器每日两次检查续期。

模型在 `app.env` 的 `CODEX_MODEL` 中配置，当前为 `gpt-6.1-sol`。用户的 OpenAI API 账户必须有该模型访问权限。

## 出网与执行隔离

服务器直接访问 OpenAI 曾超时，已按用户明确授权复用服务器现有出网凭据，部署 Codex 专用 helper。它只允许 `api.openai.com:443`，不发布端口，不持有用户 OpenAI Key。TLS 验证保持开启。独立任务网络不能连接该 helper；只有可信 API 服务使用它。

```dotenv
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://openai-proxy:18082
NO_PROXY=localhost,127.0.0.1,::1,gateway
```

旧项目服务保持停止和禁用自启动，旧数据保留。专用 helper 的程序与配置已经独立于旧项目目录。专用出网的首次准备脚本与旧项目接管脚本仅保留在原部署环境，不随公开源码发布。无 Key 探针 `proxy-probe.mjs` 返回 401 只能证明链路可达，不能证明有余额或能完成真实推理。

每次项目任务启动独立非 root Docker 执行器，只挂载该项目及其 Codex 历史；只读根文件系统、资源和超时限制、独立内部网络、不挂载 Docker socket。全站最多同时运行两个任务，每个用户及项目同时一个。执行器不能任意访问互联网，因此此版本不支持任务中下载外部依赖。

## 数据与备份

`upgrade-personal-keys.py` 在服务器创建一致 SQLite 备份、保存旧源码及配置，并在缺失时生成主密钥。数据库变更为增量迁移，保留用户、项目、会话及历史用量。升级前应确认没有运行中的任务。

完整备份必须一起保存 `/var/lib/codex-web` 和 `/etc/codex-web`，权限限制为仅维护人员可读。**丢失 credentials-key 后无法恢复已加密的用户 Key；不能在更新时重新生成它。** 备份含私人项目、会话与秘密，不得提交到仓库。

## 范围

- 支持账号密码注册登录、独立项目、持久对话、流式输出、停止任务、UTF-8 文件上传编辑删除、Git 差异和版本保存。
- 文件编辑每文件最多 1 MB，项目文件 API 总量最多 100 MB。私有 Git 凭据和 push/pull 尚未提供。
- 不支持 OpenAI 托管收费工具、任意上游转发、跨用户供应商会话引用。
- 真实 OpenAI 推理需要用户自行配置有效 Key、余额及模型权限；模拟接口测试不代表真实付费调用已通过。

## 普通聊天与 kivo 品牌验收（2026-11-06，v1.3.0）

- 最终 TypeScript/Vite 构建与全部 62 项自动化测试在服务器通过，包括真实 HTTP → runtime → gateway 的模拟流式多轮集成、用户密钥隔离、并发限制、停止/超时及未知用量。
- 浏览器实际验证了零项目直接聊天、多轮上下文、刷新后恢复历史、停止后保留部分回复、生成中切换新对话互不串话，以及返回后台已完成会话时刷新用量。
- 1440px 桌面与 390px 手机界面检查通过，无横向溢出。网站名称为 `kivo`，保留用户提供的 Logo。
- 正式 HTTPS 站点检查了管理员登录、默认普通聊天入口、原有项目文件与代码差异入口。验收没有使用用户的真实 Key 进行付费调用。
- 对最新一致数据库副本完成迁移验证：所有表的数据指纹完全一致，外键完整；原有用户、个人密钥、项目及对话均保留。备份：`/opt/codex-web/backups/direct-chat-1.3.0-20261106T094047Z`。

## 界面升级验收（2026-11-06，v1.2.0）

- 所有构建与测试均在服务器完成：最终 TypeScript/Vite 构建通过；现有 44 项自动化测试全部通过。
- 浏览器检查了 1440px 桌面、390px 手机与 430px 高度的短视口；页面无水平溢出。
- 实际验证注册/登录、创建项目、快捷提示、收起侧栏保留草稿、模拟会话排版、文件编辑保存、代码差异与未保存修改确认、账户设置、管理员只读会话查看。
- 手机侧栏支持初始焦点、Tab / Shift+Tab 循环、Escape 关闭与返回焦点；关闭的侧栏不可获得键盘焦点。
- 验收只使用临时账户和明确标注的模拟消息，没有真实模型调用；临时账户、项目及文件已精确清理。
- 原有用户、个人密钥、项目与历史保留。升级前一致数据库/配置/源码备份：`/opt/codex-web/backups/ui-1.2.0-20261106T090048Z`。

## 个人密钥版本验收（2026-11-06，v1.1.0）

- 服务器 TypeScript/Vite 生产构建通过；44 项自动化测试全部通过，覆盖旧库迁移、用户身份绑定加密、密钥隔离、Key 轮换、未知用量和管理员只读权限。
- 真实 Codex 0.167.0 + Docker 执行器通过 6 次模拟上游调用，验证两个用户各自的 Key、独立文件写入、会话恢复以及断流后的未知用量。没有调用真实付费模型。
- 真实 HTTPS 浏览器验证：注册提示、个人 Key 保存/替换/删除与输入清空、调用时尾号保留、本站用量、余额官方入口、管理员用户筛选/用量/会话消息/工具执行记录。
- 390px 手机页面无水平溢出；保留上传的 Logo。
- 本次临时账户、项目、模拟会话、模拟用量、测试容器和网络已精确清理；现有真实数据保留。
