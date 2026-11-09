# Cloudflare 前端与安全回源

公网入口为 `https://kivo.iptnet.xyz`，Cloudflare Workers Assets 托管 Vite 构建产物，Worker 只将 `/api/*` 和 `/healthz` 转发到 `https://origin-kivo.iptnet.xyz`。账号、SQLite、加密个人 Key、项目文件和 Codex 执行器继续运行在现有 Ubuntu。无需 Cloudflare Containers、D1、R2 或付费 Workers 套餐。

## Workers Builds

- 仓库：`kesonm/kivo`，生产分支 `main`。
- 根目录：`web`。
- 构建命令：`npm ci --include=dev && npm run build`。
- 部署命令：`npm run deploy:cloudflare`，固定 Wrangler 4.158.0。
- 构建环境变量：`NODE_VERSION=24.22.2`、`SKIP_DEPENDENCY_INSTALL=1`。跳过仓库根目录 pnpm workspace 的自动安装，使用 `web/package-lock.json` 单独安装网页版依赖。
- 关闭 Preview builds；Wrangler 也关闭 `workers.dev` 与预览 URL。
- 运行时 Secret：`ORIGIN_TOKEN`，必须与服务器 `/etc/codex-web/cloudflare-origin-token` 一致。不要放进 Git、公开变量、构建日志或客户端。

`wrangler.jsonc` 绑定自定义域名。静态资源优先直出，只有 API 路由调用 Worker；API 响应不缓存。`public/_headers` 与 Worker 均设置 CSP、禁止嵌入及其他安全响应头。关闭 Worker Observability，不记录用户会话、Cookie 或请求密钥。

## 服务器切换

以下操作只在部署服务器上执行，先检查脚本里的域名是否适合目标环境。

1. `sudo python3 deploy/cloudflare-origin.py prepare`：一致备份 SQLite、配置和源码，生成独立回源令牌及 HTTP ACME 入口。
2. 添加 DNS-only A 记录 `origin-kivo` 指向现有服务器；不修改邮件或其他服务记录。
3. `sudo python3 deploy/cloudflare-origin.py tls`：使用既有 Certbot 账户签发有效回源证书，启用凭据校验；现有证书续期 timer 同时维护它。
4. 部署 Worker，并在 Cloudflare Secrets 保存 `ORIGIN_TOKEN`。令牌不允许明文显示给普通用户。
5. Worker 域名和 HTTPS 就绪后，执行 `sudo python3 deploy/cloudflare-origin.py activate`：确认无活动任务，切换 `PUBLIC_ORIGIN`，保留数据库和既有运行镜像，健康检查通过后将旧 IP 入口跳转到新域名。

激活前会另存即时配置和数据库快照，先检查候选 Nginx 配置；切换失败会自动恢复。需要手动撤销入口切换时，确认没有运行中的任务，再执行 `sudo python3 deploy/cloudflare-origin.py rollback`。回滚保留最新数据库，避免丢失切换后产生的用户数据；快照位置记录在 `/etc/codex-web/cloudflare-activation-path`。

新域名需要重新登录，账号和历史不变。源站验证令牌后才采用 Worker 覆盖的单个客户端 IP；Express 仍仅信任 Nginx 的精确桥接地址。浏览器 Origin、CSRF、Cookie 不被伪造为可信来源，不使用 CORS 通配。禁止携带凭据跟随上游重定向。

SSE 原样流式转发，后端每 15 秒发送心跳。断线由客户端重连恢复；不要重试创建任务的 POST，以免重复启动任务。项目初始化仍由 Ubuntu 完成，异常慢启动可能受到 Cloudflare 源站请求期限限制。

## 免费范围与验证

静态资源请求免费且不限次数，Worker 动态请求受免费计划每天 100,000 次和每次 10ms CPU 等限制；不承诺超出免费额度后的可用性。原服务器、域名续费及用户自己的 OpenAI API 费用仍然存在。

所有应用构建与测试在服务器执行：`npm test` 覆盖原有功能及 Worker 的来源校验、固定回源、伪造头清理、Cookie/CSRF 透传、SSE、重定向拒绝、静态安全头。`npm run check:cloudflare` 进行不发布的 Wrangler 打包验证。

官方参考：[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
