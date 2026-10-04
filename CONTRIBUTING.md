# 贡献指南

## 开发环境

- Windows 10/11
- Node.js 22.13.0 或更新的 Node.js 22 LTS
- 使用 `npm ci` 按 `package-lock.json` 安装依赖

从 `config.example.json` 复制本机 `config.json`。不得提交真实 QQ 号、群号、API Key、访问令牌、会话、日志、模型或运行时状态。

## 变更要求

1. 保持 Direct Runtime 不依赖 DSH，DSH 集成仍为可选能力。
2. 权限判断、白名单、SSRF、日志遮罩和发送防护必须保持 fail-closed。
3. 新增配置需同步示例配置、桌面 UI、文档和可移植性测试。
4. 面向用户的错误信息应说明下一步操作，内部堆栈只写入受控日志。
5. 不直接修改生成物或 `node_modules`；需要兼容补丁时使用可重复执行的脚本。

## 提交前门禁

```powershell
npm ci
Copy-Item config.example.json config.json
npm run quality:ci
```

完整门禁包括核心审计、桌面端、Direct Runtime、MCP、安全边界、图片输入、ComfyUI 管理、配置迁移、脱敏打包、文档完整性和依赖安全检查。涉及真实 QQ、SnowLuma、DSH 或模型服务的集成测试应在隔离测试账号和非生产凭据下另行执行。

Pull Request 应写明用户影响、风险、验证证据、配置或迁移影响，以及必要的回滚方式。
