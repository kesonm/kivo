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

## Tunnel 回源（当前部署方式）

若公网源站域名在云厂商网络侧被阻断，Worker 的 HTTPS 回源会返回 525，即使服务器本机 TLS 检查正常。当前入口改用命名 Cloudflare Tunnel：Worker 仍请求 `https://origin-kivo.iptnet.xyz`，该域名通过 Tunnel 到 Ubuntu 的 `http://127.0.0.1:18400`，再经 Nginx 转发原后端。云端至 `cloudflared` 保持加密连接，HTTP 仅在服务器 loopback 使用；既有 `ORIGIN_TOKEN`、客户端 IP 检查与业务权限继续生效。

使用现有 Cloudflare 账号的 **Networking → Tunnels** 创建 remotely-managed Tunnel（建议名 `kivo-origin`）。只发布 `origin-kivo.iptnet.xyz` 到 `http://127.0.0.1:18400`；不添加私有网络、其他端口或 Cloudflare Access 登录。发布路由时将旧 DNS-only A 记录替换为该 Tunnel 的 proxied CNAME，目标由 Cloudflare 提供。先记下原记录，只有 connector Ready 后再切换域名。

`cloudflared` 使用官方发布的二进制，部署前核对版本与 SHA256，安装为 `/usr/local/bin/cloudflared`。此服务仅需单个 Tunnel 的运行令牌，不需要保存账号 API Token 或 `cert.pem`。把 Tunnel token 安全写入 `/etc/codex-web/cloudflared-token`，所有者 root、权限 `0600`；不要把值放进 shell 历史、进程参数、环境变量或仓库。`--token-file` 要求 cloudflared 2025.4.0 或更新版本。

仅在服务器执行：

```sh
sudo python3 -m py_compile deploy/cloudflare-tunnel.py
sudo python3 deploy/cloudflare-tunnel.py prepare
# 安全提供 root:root 0600 的 /etc/codex-web/cloudflared-token 后：
sudo python3 deploy/cloudflare-tunnel.py start
# Cloudflare 配好上述主机名路由与 DNS 后：
sudo python3 deploy/cloudflare-tunnel.py verify
```

`prepare` 仅建立 `127.0.0.1:18400` Nginx 入口与 `kivo-cloudflared.service`，复用既有授权 map，验证后 reload Nginx，不重启业务容器。服务使用 systemd `DynamicUser` 与 `LoadCredential`，令牌通过运行时凭据文件交给 `--token-file`。metrics/ready 仅监听 `127.0.0.1:18401`。保持 info 日志，不使用会输出请求头的 debug 日志。

业务 API 和健康检查仍要求回源令牌。仅 `/.well-known/acme-challenge/` 从既有 `/var/www/codex-acme` 公开读取挑战文件，让历史公网源站证书可以继续自动续期；其余路径返回 404。

默认 `--protocol auto` 先尝试 QUIC，UDP 不通会回退到 HTTP/2；两者均连接 Cloudflare **7844** 端口，分别使用 UDP 和 TCP。必要时停止服务后执行 `prepare --protocol http2` 再 `start`。HTTP/2 不改用 443；普通 `HTTPS_PROXY` 不能视为已验证的 Tunnel 出网方案。先按官方防火墙文档确认两个区域的 endpoints 均可达。

若启动后 90 秒仍未 Ready，helper 会停止 connector，保留配置与凭据供检查。`verify` 检查未授权请求为 403、缺少客户端 IP 为 400、授权本机健康为 200，以及公网 Worker 健康。之后仍需通过公网 `/api/session` 验证 Cookie/CSRF，并验证登录、项目与 SSE。

本机配置回滚命令是 `sudo python3 deploy/cloudflare-tunnel.py rollback`，快照路径保存在 `/etc/codex-web/cloudflare-tunnel-backup-path`。它停止此 connector、恢复本次新增前的 Nginx/unit 文件，不删除凭据、不修改数据库；Cloudflare 主机名路由/DNS 需要单独恢复。原公网域名已遭阻断时，恢复旧 A 记录并不能修复该网络问题，须先准备可用回源路径。

官方参考：[创建 Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、[运行参数与 token-file](https://developers.cloudflare.com/tunnel/reference/run-parameters/)、[7844 出站要求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)。

## 初次服务器切换与历史公网 TLS 回源

以下操作只在部署服务器上执行，先检查脚本里的域名是否适合目标环境。

1. `sudo python3 deploy/cloudflare-origin.py prepare`：一致备份 SQLite、配置和源码，生成独立回源令牌及 HTTP ACME 入口。
2. 初次公网 TLS 方式添加 DNS-only A 记录 `origin-kivo` 指向现有服务器；当前使用上面的 Tunnel 路由时不要恢复此 A 记录，也不修改邮件或其他服务记录。
3. `sudo python3 deploy/cloudflare-origin.py tls`：使用既有 Certbot 账户签发有效回源证书，启用凭据校验；现有证书续期 timer 同时维护它。
4. 部署 Worker，并在 Cloudflare Secrets 保存 `ORIGIN_TOKEN`。令牌不允许明文显示给普通用户。
5. Worker 域名和 HTTPS 就绪后，执行 `sudo python3 deploy/cloudflare-origin.py activate`：确认无活动任务，切换 `PUBLIC_ORIGIN`，保留数据库和既有运行镜像，健康检查通过后将旧 IP 入口跳转到新域名。

激活前会另存即时配置和数据库快照，先检查候选 Nginx 配置；切换失败会自动恢复。需要手动撤销入口切换时，确认没有运行中的任务，再执行 `sudo python3 deploy/cloudflare-origin.py rollback`。回滚保留最新数据库，避免丢失切换后产生的用户数据；快照位置记录在 `/etc/codex-web/cloudflare-activation-path`。

新域名需要重新登录，账号和历史不变。源站验证令牌后才采用 Worker 覆盖的单个客户端 IP；Express 仍仅信任 Nginx 的精确桥接地址。浏览器 Origin、CSRF、Cookie 不被伪造为可信来源，不使用 CORS 通配。禁止携带凭据跟随上游重定向。

SSE 原样流式转发，后端每 15 秒发送心跳。断线由客户端重连恢复；不要重试创建任务的 POST，以免重复启动任务。项目初始化仍由 Ubuntu 完成，异常慢启动可能受到 Cloudflare 源站请求期限限制。

## 免费范围与验证

静态资源请求免费且不限次数，Worker 动态请求受免费计划每天 100,000 次和每次 10ms CPU 等限制；不承诺超出免费额度后的可用性。原服务器、域名续费及用户自己的 OpenAI API 费用仍然存在。

所有应用构建与测试在服务器执行：`npm test` 覆盖原有功能及 Worker 的来源校验、固定回源、伪造头清理、Cookie/CSRF 透传、SSE、重定向拒绝、静态安全头。`npm run check:cloudflare` 进行不发布的 Wrangler 打包验证。

## 原生 workerd 冒烟测试（仅服务器）

`native-smoke.mjs` 将实际 Worker 源码交给 Miniflare 的原生 workerd 执行，所有回源均由内存假服务处理，只使用假 Cookie、CSRF 和回源令牌。它覆盖健康检查、POST 请求体、会话头、分块 SSE 与心跳、重定向和跨域拒绝；另将旧的 `cache: 'no-store'` 与 `cf.cacheTtl: 0` 冲突重新注入内存副本，断言原生运行时在发出请求前拒绝，防止只用 Node mock 漏掉兼容约束。

2026-11-09 已在 Ubuntu 的 Node 24.22.2 构建容器中通过上述正测与负控。临时安装使用官方 npm 的固定 `wrangler@4.158.0`，当次附带 `miniflare@5.20261104.0-beta`；脚本使用该版本提供的 `convertV4MiniflareOptions`。Miniflare 不加入应用日常依赖。脚本首个参数是包含 `cloudflare/worker.mjs` 和 `wrangler.jsonc` 的来源目录；未传时默认脚本所在目录的上一级，即 `web/`。

以下沿用已验证的临时安装和隔离容器方式；将来源目录与构建镜像改为服务器上要验证的版本。脚本复制到临时 npm 安装目录，使其能解析 Miniflare。安装阶段允许联网，正式测试使用 `--network none`，仅只读挂载发布源码和测试依赖，不挂载生产数据、配置或 Docker socket。

```sh
ssh ubuntu
native_smoke_source=/opt/codex-web/releases/1.3.1
native_smoke_dir=$(sudo mktemp -d /tmp/kivo-cf-native-smoke.XXXXXX)

sudo docker run --rm --name kivo-cf-native-install --network host \
  --mount "type=bind,source=$native_smoke_dir,target=/probe" \
  --entrypoint npm codex-workspace-build:1.3.1 \
  install --prefix /probe --no-audit --no-fund \
  --registry https://registry.npmjs.org wrangler@4.158.0

sudo install -m 600 "$native_smoke_source/cloudflare/native-smoke.mjs" "$native_smoke_dir/smoke.mjs"
sudo docker run --rm --name kivo-cf-native-smoke --network none --read-only \
  --tmpfs /tmp:rw,nosuid,size=256m \
  --mount "type=bind,source=$native_smoke_dir,target=/probe,readonly" \
  --mount "type=bind,source=$native_smoke_source,target=/source,readonly" \
  --workdir /tmp --entrypoint node codex-workspace-build:1.3.1 \
  /probe/smoke.mjs /source

# 测试容器退出时自动删除；仅清理本次创建的临时依赖目录。
case "$native_smoke_dir" in
  /tmp/kivo-cf-native-smoke.*) sudo rm -rf -- "$native_smoke_dir" ;;
esac
```

通过时输出两行 `PASS`。该测试验证 Worker 原生语义与流式代理，不代表生产 DNS/TLS、真实回源凭据或付费 OpenAI 调用已通过；线上链路仍需单独验收。

官方参考：[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
