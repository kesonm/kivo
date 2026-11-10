# kivo

<img src="web/public/logo.png" alt="kivo logo" width="96" />

kivo 是基于 OpenAI 和 Codex 的多用户网页聊天与代码工作台。

- **直接聊天**：注册登录后即可新建普通对话，无需先创建项目，支持多轮上下文、流式回复、停止生成和独立历史。
- **项目工作台**：独立项目与项目会话，支持上传和编辑文件、查看代码差异、保存 Git 版本，以及隔离的 Codex 执行器。
- **个人密钥**：每位用户填写自己的 OpenAI API Key，密钥加密保存，记录服务方实际返回的 token 用量。
- **只读管理后台**：管理员查看用户、用量、会话及执行记录；无充值或额度分配。
- **iOS 与扫码登录**：iPhone 客户端复用工作台，原生相机扫描网页二维码并明确确认授权。个人真机安装见 [iOS 说明](ios/README.md)。

网页源码位于 [`web/`](web/)，部署与配置见 [网页服务文档](web/README.md)。本仓库保留 [OpenAI Codex](https://github.com/openai/codex) 上游代码及提交历史；上游介绍见 [README.upstream.md](README.upstream.md)。kivo 是独立项目，并非 OpenAI 官方服务。

跨会话任务、目标选择、版本化产物和执行恢复的阶段 1–3 基础实现见 [工作连续性说明](web/WORK_CONTINUITY.md)。启用模式与回滚须遵循该文档；尚未实现原生自动压缩、持久多 Worker 或可信外部事件入口。

## 部署

采用 Node.js 24、React、SQLite、Docker 和 Nginx。构建和验收在部署服务器执行，配置与用户数据保存在仓库之外。详细步骤见 [web/README.md](web/README.md)。

普通聊天通过 OpenAI Responses API 工作；项目任务使用固定版本的 Codex 执行器。实际调用需要用户自己的有效 API Key、余额和模型权限。

## 许可证

保留上游 [Apache-2.0 许可证](LICENSE) 与 [NOTICE](NOTICE)。
