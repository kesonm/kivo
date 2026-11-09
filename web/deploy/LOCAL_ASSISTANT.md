# 本地助手部署与验证

1.4.0 保留原有云端项目，新增每用户设备配对、项目目录关联与本地 Codex 执行。
前端和助手下载资源部署至原 Cloudflare Worker；Node 后端仍在 Ubuntu。

助手使用 Node.js 22+ 和固定的官方 `@openai/codex@0.167.0`。自动安装目前面向 macOS/Linux，入口为 `/local-assistant/install.sh`。用户在本机选择授权父目录，运行助手，在网页登录本人账号后输入 10 位配对码。设备凭据只存入本机 `~/.kivo-local/<目录标识>/device.json`（0600），服务端仅保存其 SHA-256。不要把此文件提交仓库或放入日志。

## 连接与权限

- 助手仅发起出站 HTTPS 请求；20 秒长轮询获取任务，无须本机监听端口。
- 设备仅绑定一个用户；管理员查看记录的权限不会赋予操作其他用户设备的权限。
- `/api/local-agent/*` 独立使用 bearer capability，拒绝浏览器 Cookie/Origin；其他 API 继续校验原登录会话及 CSRF。
- Worker 只在上述专用前缀透传 Authorization。Nginx 的回源凭据/IP 校验仍有效。
- 每个本地任务仅获得限时的模型网关凭据，真实 OpenAI Key 留在原服务器加密存储，实际 token 用量仍由模型网关结算。
- Codex 使用 workspace-write / on-request。额外命令与文件权限在网页逐次允许或拒绝；不自动降级至 danger-full-access。
- 断线 45 秒、服务端重启、撤销配对、停止任务或退出助手时停止本地 Codex 进程组。
- 网页文件操作拒绝目录穿越、符号链接和常见密钥/依赖路径；每个文本文件最多 1 MB。文件列表最多显示前 3000 项，文本检查点总量最多 128 MB，差异超限明确标记截断。
- 检查点位于本机助手状态目录，不改变原 Git 仓库、提交或索引；删除网页项目只移除关联和网页会话，不删除电脑文件。

首次连接已有目录会读取可处理的文本以生成本地检查点，不把整个目录同步到服务器；模型所需上下文、会话和任务日志会经过服务器，并遵循现有管理员查看权限。

## 数据与发布

新增 `local_devices` 和 `local_projects` 两张表；不修改现有用户身份、密码、项目文件或 API Key。升级前使用 SQLite backup API 备份生产数据库，确认无活动任务再替换业务镜像。旧版本可以继续读取原表；若回滚，请先断开新建的本地项目关联，避免旧版本将其误当云端项目。

构建和测试均在 Ubuntu 执行。`npm test` 包含设备隔离、凭据保护、目录限制、真实文件差异、审批和 Worker 透传回归。`test/local-runner-smoke.mjs` 使用真实 Codex + 本地助手 + HTTP 后端和模拟 OpenAI 服务，验证本地文件、审批接受/拒绝、线程恢复与用量；不要挂载生产数据或凭据，也不要改成真实模型。

2026-11-09 已在 Ubuntu 通过真实 Codex 端到端模拟模型验收，模型未连接真实 OpenAI。服务器 Docker 的外层隔离会阻止 Codex 嵌套沙箱的 mount 与回环初始化；当次仅在断网、无生产挂载的临时测试容器中使用 root、SYS_ADMIN/NET_ADMIN 以及解除外层 seccomp/AppArmor，使 Codex 自身 workspace-write 沙箱可以运行。该设置不用于生产镜像或用户电脑。

用户后续启动：`bash "$HOME/.kivo-local/start.sh" --root "/项目父目录"`。如网页已撤销授权，使用 `--pair` 重新配对。

协议参考：[OpenAI App Server 审批](https://learn.chatgpt.com/docs/app-server#approvals)。
