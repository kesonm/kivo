# kivo iOS（个人真机测试版）

iOS 16+，SwiftUI + WKWebView 工作台 + AVFoundation 原生相机。固定连接 https://kivo.iptnet.xyz，复用现有账号、对话、项目、文件与差异、用量和后台。不是离线执行器：项目运行继续在服务器或已配对电脑上执行，iPhone 远程操作这些项目。没有新增付费登录服务。

## 安装到自己的 iPhone

1. 从 Mac App Store 安装完整 Xcode，首次打开完成组件安装。只有 Command Line Tools 不能编译 iOS App。
2. 打开 `ios/Kivo.xcodeproj`。在 Xcode → Settings → Accounts 登录自己的 Apple Account；无需将密码或验证码发给维护者。
3. 选 Kivo target → Signing & Capabilities → Automatically manage signing，选择自己的 Personal Team。默认 Bundle ID 为 `xyz.iptnet.kivo`；若提示被占用，改成自己唯一的 ID，例如 `com.yourname.kivo`。不要把个人 Team ID、证书、描述文件提交到仓库。
4. 用数据线连接 iPhone，信任电脑，按 Xcode 提示开启“设置 → 隐私与安全性 → 开发者模式”，选择该 iPhone 为运行设备，然后点击 Run。
5. 打开 kivo，用原有用户名密码登录。免费 Personal Team 的签名通常 7 天到期，到期需重新用 Xcode 安装。TestFlight / App Store 分发需要开发者会员，当前工程并未上架或发布 TestFlight。

[Apple 个人设备测试说明](https://developer.apple.com/help/account/basics/about-your-developer-account/)。

## 扫码授权网页

电脑打开网站登录页 → “App 扫码登录”。iPhone 在 App 登录后点击顶部“扫码登录”，首次允许相机权限。扫描后核对域名、浏览器和六位确认码，点击“确认登录”。电脑自动登录同一个账号；取消不登录。二维码 120 秒过期，刷新会撤销旧码，其他浏览器不能领取授权。

原生网络请求从当前 WKWebView 的 HttpOnly 会话 Cookie 读取身份，继续使用服务端 CSRF 校验；不保存账号密码，不暴露 Key，不增加 JavaScript 桥。Cookie 由 WebKit 持久存储，遵循网站现有 24 小时登录有效期。只访问固定 HTTPS 域名，不跟随 API 重定向。相机画面仅在本机识别二维码，不上传视频，不打开麦克风。二维码不包含密码、API Key 或手机登录 Cookie。

二维码中的 `kivo://web-login?v=1&token=…` 是 App 内扫描数据，不注册系统 URL Scheme，也不支持图片/剪贴板自动授权。必须在本 App 内扫码并确认。

## 验证

网页构建、Node 测试在 Ubuntu 上执行。`.github/workflows/kivo-ios.yml` 在 GitHub 的 macOS runner 编译 iOS 模拟器和未签名真机目标，并运行二维码解析边界测试，不使用个人证书。模拟器产物不能直接安装到 iPhone。实际相机权限、扫码识别、确认后网页登录，以及后台/网络切换需在用户 iPhone 最终验收。

图标由构建步骤从仓库中既有 Logo 等比例生成，不重新设计 Logo。此版本用于个人测试；公开上架前还需准备商店隐私披露、账号删除等发布要求和真机验收。
