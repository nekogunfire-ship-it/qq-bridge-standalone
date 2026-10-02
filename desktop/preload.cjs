// 预加载脚本（CommonJS：Electron 的 preload 在 sandbox:false 下仍按 CJS 解析）。
//
// 只暴露白名单式的方法，不提供通用 IPC 转发 —— 渲染层拿到的能力就是这些，边界清晰。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 应用信息
  info: () => ipcRenderer.invoke('app:info'),

  // 自动检查
  checkHealth: () => ipcRenderer.invoke('health:check'),

  // 生命周期（一键启动/停止/重启）
  launcherStatus: () => ipcRenderer.invoke('launcher:status'),
  diagnose: () => ipcRenderer.invoke('launcher:diagnose'),
  lifecycle: (action) => ipcRenderer.invoke('lifecycle:run', action),
  lifecycleLog: () => ipcRenderer.invoke('lifecycle:log'),
  dshRestartLog: () => ipcRenderer.invoke('dsh:restartLog'),
  openConsoleWindow: () => ipcRenderer.invoke('console:openWindow'),

  // 出图服务（ComfyUI，可选）：单独一对动作 + 打开它的网页界面
  comfyStart: () => ipcRenderer.invoke('comfy:start'),
  comfyStop: () => ipcRenderer.invoke('comfy:stop'),
  openComfy: () => ipcRenderer.invoke('shell:openComfy'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  comfySetupStatus: () => ipcRenderer.invoke('comfy:setupStatus'),
  comfyInstall: (options) => ipcRenderer.invoke('comfy:install', options || {}),
  comfyInstallModel: (options) => ipcRenderer.invoke('comfy:installModel', options || {}),
  comfyCancelSetup: () => ipcRenderer.invoke('comfy:cancelSetup'),

  // 设置（自动保存）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 常用跳转
  openPath: (which) => ipcRenderer.invoke('shell:openPath', which),
  openDsh: () => ipcRenderer.invoke('shell:openDsh'),
  openConsole: () => ipcRenderer.invoke('shell:openConsole'),
  createConfig: () => ipcRenderer.invoke('config:createFromTemplate'),

  // 应用自身生命周期（区别于服务启停）：加载界面改动 / 退出
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // 卸载：plan 只读（拿计划做展示），start 会交接给根目录的独立卸载程序
  uninstallPlan: () => ipcRenderer.invoke('uninstall:plan'),
  startUninstall: () => ipcRenderer.invoke('uninstall:start'),

  // 配置导出 / 导入（与命令行同一套工具）
  exportConfig: (opts) => ipcRenderer.invoke('config:export', opts || {}),
  importConfig: () => ipcRenderer.invoke('config:import'),

  // AI 运行时（dsh / direct）：查看 / 保存 / 测连接。
  // 注意 apiKey **不回传**过来 —— 主进程只告知"填过没有"，界面留空即"不修改"。
  runtimeGet: () => ipcRenderer.invoke('runtime:get'),
  runtimeSave: (patch) => ipcRenderer.invoke('runtime:save', patch || {}),
  runtimeTest: (form) => ipcRenderer.invoke('runtime:test', form || {}),
  runtimeSwitchModel: (form) => ipcRenderer.invoke('runtime:switchModel', form || {}),
  runtimeListModels: (form) => ipcRenderer.invoke('runtime:listModels', form || {}),

  // 监测页：会话唤醒状态 / 活动流 / 某会话的最近消息
  monitorStates: () => ipcRenderer.invoke('monitor:states'),
  monitorActivity: () => ipcRenderer.invoke('monitor:activity'),
  monitorRecent: (key, limit) => ipcRenderer.invoke('monitor:recent', key, limit),

  // 主进程推送
  onHealth: (fn) => ipcRenderer.on('health:changed', (_e, payload) => fn(payload)),
  onLifecycle: (fn) => ipcRenderer.on('lifecycle:state', (_e, payload) => fn(payload)),
  onSettings: (fn) => ipcRenderer.on('settings:changed', (_e, payload) => fn(payload))
});
