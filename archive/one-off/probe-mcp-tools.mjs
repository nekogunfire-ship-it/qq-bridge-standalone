// 说明（为什么这里不是 stdio 探针）：
//
// 最初这个脚本用 MCP 官方 SDK 的 StdioClientTransport 去 spawn
// src/mcp-snowluma-safe.js，再调 tools/list 验证工具是否注册。但受限环境
// （DSH 的文件沙箱）里 Node 以「管道」spawn 子进程会直接 EPERM，脚本永远跑不通，
// 留着只会误导。验证注册面的正确做法在 scripts/test-comfy-tools.mjs：
// 它对 registerComfyTools 传入记录型假 server，覆盖的是同一段注册代码与
// 同一份参数 schema，且顺带验证工作流构造、路径围栏与真机出图。
//
// 本文件保留为提示入口，避免有人再踩一次管道 spawn 的坑。
console.log('请改用：npm run test-comfy   （scripts/test-comfy-tools.mjs）');
console.log('');
console.log('原因：本环境禁止以管道 spawn 子进程（EPERM），MCP SDK 的');
console.log('StdioClientTransport 无法工作；registerComfyTools 的进程内验证等效且更全面。');
process.exit(0);
