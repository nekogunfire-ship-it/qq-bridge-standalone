// 渲染层逻辑：纯展示 + 调用 window.desktop 暴露的白名单 API。
// 不直接访问文件系统、不拼命令 —— 所有能力都在主进程侧。
'use strict';

const $ = (id) => document.getElementById(id);
let settings = null;
let busy = false;
let autoTimer = null;
let comfySetupTimer = null;

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ── 体检渲染 ────────────────────────────────────────────────────────────────
const STATE_LABEL = { ok: '正常', warn: '注意', error: '异常', off: '未运行' };
const OVERALL_TEXT = { ok: '全部正常', degraded: '部分异常', error: '有服务异常', checking: '检查中…' };

// 卡片上的快捷按钮 → 动作
const ACTION_HANDLERS = {
  startAll: () => runLifecycle('startAll'),
  restartAll: () => runLifecycle('restartAll'),
  restartBridgeOnly: () => runLifecycle('restartBridgeOnly'),
  stopAll: () => runLifecycle('stopAll'),
  openLog: () => openPath('state'),
  openConfig: () => openPath('config'),
  openFolder: () => openPath('root'),
  openModels: () => openPath('models'),
  openDsh: () => openDsh(),
  openDshDocs: () => openPath('root'),
  openDshRestartLog: () => showDshRestartLog(),
  createConfig: async () => {
    const r = await window.desktop.createConfig();
    if (r.ok) { toast('已从模板创建 config.json，请填写 ownerQQ 等必填项', 'ok'); refresh(); }
    else toast(`创建失败：${r.error}`, 'error');
  },
  // 出图服务：走自己的 IPC（它要等 30~60 秒加载底模，和主链路不是一套超时）
  comfyStart: () => runComfy('start', '启动出图'),
  comfyStop: () => runComfy('stop', '停止出图'),
  comfySetup: () => switchView('images'),
  openComfy: async () => {
    const r = await window.desktop.openComfy();
    if (!r.ok) toast(`打开 ComfyUI 失败：${r.error}`, 'error');
    else toast(`已在浏览器打开 ${r.url}`, 'info');
  }
};

// 出图服务的启停：与 runLifecycle 同款反馈（进度条 + 时间 + 完成后刷新）
async function runComfy(verb, label) {
  if (busy) { toast('正在执行上一个操作，请稍候', 'warn'); return; }
  const hint = verb === 'start'
    ? '要 30~60 秒加载底模；期间聊天与回复不受影响'
    : '会中断正在进行的出图任务';
  setBusy(true, `${label}中…`);
  showProgress(`${label}中…`, hint);
  toast(`正在${label}…${hint}`, 'info', 6000);
  try {
    const r = verb === 'start' ? await window.desktop.comfyStart() : await window.desktop.comfyStop();
    if (r?.ok) {
      const secs = r.timing?.totalMs ? `（${(r.timing.totalMs / 1000).toFixed(1)}s）` : '';
      toast(`${label}完成${secs}`, 'ok');
    } else if (r?.timedOut) {
      toast(`${label}等待超时：${r.error ?? ''}`, 'warn', 9000);
    } else {
      toast(`${label}失败：${r?.error ?? ''}`, 'error', 9000);
    }
    const info = (r?.payload?.info ?? []).filter(Boolean);
    if (info.length) $('diagnoseOut').textContent = info.join('\n');
    refresh();
  } catch (error) {
    toast(`${label}异常：${error?.message ?? error}`, 'error');
  } finally {
    setBusy(false);
    hideProgress();
  }
}

// 显示 DSH 重启记录（端点变化与中断时长）—— 用户抱怨过两次"掉线"，这里直接给证据
async function showDshRestartLog() {
  const out = $('diagnoseOut');
  out.textContent = '正在读取 DSH 重启记录…';
  const lines = await window.desktop.dshRestartLog();
  out.textContent = Array.isArray(lines) && lines.length
    ? lines.join('\n')
    : '暂无记录。\n\n（本窗口会在每次自动检查时对比 DSH 端点；一旦端口变化就会记下时间与中断时长。\n'
      + '若你之前遇到掉线，说明发生在该功能上线之前。）';
}

// DSH 专属入口按"这台机器上有没有 DSH"显隐。
// 直连模式下如果没有 DSH，就不该在快捷入口里摆一个「打开 DSH 界面」——
// 点它只会得到「拿不到 DSH 地址（它可能没在运行）」，既没用，又强化了
// "这软件离不开 DSH"的错觉（用户反馈的"还是与 DSH 强行绑定"就有这一份）。
// 判据用体检里有没有 `dsh` 项：挂 DSH 时它总在（ok/error 都会有）；直连且没有 DSH 时它不出现。
function syncDshUi(health) {
  const hasDsh = Boolean(health?.items?.some((i) => i.key === 'dsh'));
  for (const el of document.querySelectorAll('[data-open="openDsh"]')) el.hidden = !hasDsh;
}

// 把体检结果压缩成“一件最值得先做的事”，避免用户面对一排红黄卡片却不知道顺序。
function renderGuide(health) {
  const panel = $('guidePanel');
  const title = $('guideTitle');
  const text = $('guideText');
  const button = $('guideAction');
  const byKey = new Map((health?.items ?? []).map((i) => [i.key, i]));
  let state = 'ok';
  let action = null;

  if (byKey.get('config')?.status === 'error') {
    state = 'error'; title.textContent = '先完成基础配置';
    text.textContent = '桥接还没有可用的 config.json。可以从模板创建，再填写机器人 QQ 与运行时。';
    action = { label: '从模板创建', id: 'createConfig' };
  } else if (byKey.get('config')?.status === 'warn') {
    state = 'warn'; title.textContent = '配置还缺少必要信息';
    text.textContent = byKey.get('config').detail;
    action = { label: '打开配置', id: 'openConfig' };
  } else if (['error', 'warn'].includes(byKey.get('runtime')?.status)) {
    state = 'warn'; title.textContent = '先让 AI 运行时就绪';
    text.textContent = byKey.get('runtime').detail;
    action = { label: '检查运行时', view: 'settings' };
  } else if (byKey.get('bridge')?.status === 'error' || byKey.get('snowluma')?.status === 'error') {
    state = 'error'; title.textContent = '服务链还没有启动完整';
    text.textContent = '按当前运行时拉起 QQ 网关与桥接，已经运行的服务会自动跳过。';
    action = { label: '一键启动', id: 'startAll' };
  } else if (health.overall === 'degraded') {
    state = 'warn'; title.textContent = '主链路可用，还有可选项需要留意';
    text.textContent = '聊天通常不受影响。查看下方黄色状态卡，按需要处理即可。';
    action = { label: '查看监测', view: 'monitor' };
  } else {
    title.textContent = '服务链已经就绪';
    text.textContent = '可以查看 QQ 活动，或进入网页控制台管理聊天、角色、记忆与出图。';
    action = { label: '查看监测', view: 'monitor' };
  }

  panel.dataset.state = state;
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => action.view ? switchView(action.view) : ACTION_HANDLERS[action.id]?.();
  }
}

function renderHealth(health) {
  const pill = $('overallPill');
  pill.dataset.state = health.overall;
  $('overallText').textContent = OVERALL_TEXT[health.overall] ?? health.overall;
  $('checkedAt').textContent = health.checkedAt
    ? `最后检查 ${new Date(health.checkedAt).toLocaleTimeString('zh-CN')}`
    : '';
  syncDshUi(health);
  renderGuide(health);

  const grid = $('healthGrid');
  grid.innerHTML = '';
  for (const item of health.items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.state = item.status;

    const top = document.createElement('div');
    top.className = 'card-top';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = item.label;
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = STATE_LABEL[item.status] ?? item.status;
    top.append(title, badge);
    card.appendChild(top);

    const detail = document.createElement('div');
    detail.className = 'card-detail';
    detail.textContent = item.detail;
    card.appendChild(detail);

    if (item.actions?.length) {
      const row = document.createElement('div');
      row.className = 'card-actions';
      for (const a of item.actions) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          const fn = ACTION_HANDLERS[a.id];
          if (fn) fn();
          else toast(`未实现的动作：${a.id}`, 'warn');
        });
        row.appendChild(btn);
      }
      card.appendChild(row);
    }
    grid.appendChild(card);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function refresh() {
  const pill = $('overallPill');
  pill.dataset.state = 'checking';
  $('overallText').textContent = OVERALL_TEXT.checking;
  try {
    renderHealth(await window.desktop.checkHealth());
  } catch (error) {
    toast(`体检失败：${error?.message ?? error}`, 'error');
  }
}

async function runLifecycle(action) {
  if (busy) { toast('正在执行上一个操作，请稍候', 'warn'); return; }
  const META = {
    startAll: { label: '启动', hint: '按当前运行时启动桥接与所需服务，通常十几秒' },
    stopAll: { label: '停止', hint: '停止全部服务' },
    // 全量重启很慢（实测约 2 分 35 秒），且会打断 DSH 网页端 —— 提示写清楚
    restartAll: { label: '全量重启', hint: '按当前运行时重启整条服务链，可能需要约 2 分钟' },
    restartBridgeOnly: { label: '重启桥接', hint: '只重启桥接，约 10 秒，不重启 AI 宿主' },
    // 出图服务（可选）：冷启动要等底模加载完才监听端口
    comfyStart: { label: '启动出图', hint: '要 30~60 秒加载底模；聊天与回复不受影响' },
    comfyStop: { label: '停止出图', hint: '会中断正在进行的出图任务' }
  };
  const meta = META[action] ?? { label: action, hint: '' };

  // ComfyUI 走独立 IPC（comfy:start / comfy:stop），主链路的 lifecycle:run 不认识它
  const viaComfy = action === 'comfyStart' || action === 'comfyStop';
  const call = () => (viaComfy
    ? (action === 'comfyStart' ? window.desktop.comfyStart() : window.desktop.comfyStop())
    : window.desktop.lifecycle(action));

  setBusy(true, `${meta.label}中…`);
  showProgress(`${meta.label}中…`, meta.hint);
  toast(`正在${meta.label}…${meta.hint}`, 'info', 6000);

  try {
    const r = await call();
    if (r.ok) {
      const secs = r.timing?.totalMs ? `（${(r.timing.totalMs / 1000).toFixed(1)}s）` : '';
      toast(`${meta.label}完成${secs}`, 'ok');
      if (r.health) renderHealth(r.health);
    } else if (r.timedOut) {
      // 超时不是失败 —— 操作可能仍在后台进行，明确告知用户如何处理
      toast(`${meta.label}等待超时：${r.error}`, 'warn', 9000);
      if (r.stderr) $('diagnoseOut').textContent = r.stderr;
    } else {
      toast(`${meta.label}失败：${r.error ?? `退出码 ${r.exitCode}`}`, 'error', 9000);
      if (r.stderr) $('diagnoseOut').textContent = r.stderr;
    }
    // 无论结果如何都刷新一次状态，让用户看到真实情况
    refresh();
  } catch (error) {
    toast(`${meta.label}异常：${error?.message ?? error}`, 'error');
  } finally {
    setBusy(false);
    hideProgress();
  }
}

// ── 进度条（带实时计时，避免长时间无反馈被误判为卡死）──────────────────────
let progressTimer = null;
let progressStart = 0;

function showProgress(text, hint) {
  $('progressBar').hidden = false;
  $('progressText').textContent = text;
  $('progressHint').textContent = hint ?? '';
  progressStart = Date.now();
  $('progressElapsed').textContent = '0.0s';
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const s = (Date.now() - progressStart) / 1000;
    $('progressElapsed').textContent = `${s.toFixed(1)}s`;
  }, 100);
}

function hideProgress() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  $('progressBar').hidden = true;
}

function setBusy(isBusy, note) {
  busy = isBusy;
  for (const id of ['btnStart', 'btnStop', 'btnRestart', 'btnRestartBridge', 'btnCheck']) {
    $(id).disabled = isBusy;
  }
  if (isBusy && note) {
    $('overallPill').dataset.state = 'checking';
    $('overallText').textContent = note;
  }
}

async function openPath(which) {
  const r = await window.desktop.openPath(which);
  if (!r.ok) toast(r.error, 'error');
}

async function openDsh() {
  const r = await window.desktop.openDsh();
  if (r.ok) toast(`已在浏览器打开 DSH（${r.url}）`, 'ok');
  else toast(r.error, 'error');
}

// ── 设置 ────────────────────────────────────────────────────────────────────
function applySettings(s) {
  settings = s;
  $('setAutoCheck').value = String(s.autoCheckSeconds ?? 60);
  $('setAutoStart').checked = Boolean(s.autoStartServices);
  $('setTray').checked = Boolean(s.minimizeToTray);
  $('setWatchdog').checked = s.watchdogEnabled !== false;
  $('setWatchdogCooldown').value = String(s.watchdogCooldownSeconds ?? 180);
  scheduleAutoCheck(Number(s.autoCheckSeconds ?? 60));
}

function scheduleAutoCheck(seconds) {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (seconds > 0) autoTimer = setInterval(refresh, seconds * 1000);
}

async function saveSetting(patch) {
  const next = await window.desktop.setSettings(patch);
  applySettings(next);
  toast('设置已保存', 'ok', 1600);
}

function bindSettings() {
  $('setAutoCheck').addEventListener('change', (e) => saveSetting({ autoCheckSeconds: Number(e.target.value) }));
  $('setAutoStart').addEventListener('change', (e) => saveSetting({ autoStartServices: e.target.checked }));
  $('setTray').addEventListener('change', (e) => saveSetting({ minimizeToTray: e.target.checked }));
  $('setWatchdog').addEventListener('change', (e) => saveSetting({ watchdogEnabled: e.target.checked }));
  $('setWatchdogCooldown').addEventListener('change', (e) => saveSetting({ watchdogCooldownSeconds: Number(e.target.value) }));
}

function bindActions() {
  $('btnStart').addEventListener('click', () => runLifecycle('startAll'));
  $('btnRestartBridge').addEventListener('click', () => runLifecycle('restartBridgeOnly'));
  $('btnRestart').addEventListener('click', () => {
    const usesDsh = (runtimeInfo?.runtime?.type ?? 'dsh') === 'dsh';
    const impact = usesDsh
      ? '当前使用 DSH，操作会短暂打断 DSH 网页端，可能耗时约 2 分钟。'
      : '当前使用直连 AI，不会启动或重启 DSH；操作会重启 QQ 网关与桥接。';
    const ok = window.confirm(
      `确定要重启整条服务链吗？\n\n${impact}\n\n`
      + '如果只是应用桥接代码改动，请使用「重启桥接」，通常约 10 秒。\n\n'
      + '确定要继续全量重启吗？'
    );
    if (ok) runLifecycle('restartAll');
  });
  $('btnStop').addEventListener('click', () => runLifecycle('stopAll'));
  $('btnCheck').addEventListener('click', refresh);

  $('btnDiagnose').addEventListener('click', async () => {
    const out = $('diagnoseOut');
    out.textContent = '正在运行诊断…';
    const r = await window.desktop.diagnose();
    out.textContent = r.payload?.lines?.join('\n')
      ?? r.stdout
      ?? r.error
      ?? `诊断没有返回内容（退出码 ${r.exitCode}）`;
  });

  // 操作时间线：点过重启后可以看它到底跑了多久、卡在哪一步
  $('btnLifecycleLog').addEventListener('click', async () => {
    const out = $('diagnoseOut');
    out.textContent = '正在读取操作时间线…';
    const lines = await window.desktop.lifecycleLog();
    out.textContent = Array.isArray(lines) && lines.length
      ? lines.join('\n')
      : '还没有操作记录 —— 点一次「重启桥接」或「一键启动」后就会有。';
  });

  // 应用自身的重启/退出（区别于服务启停）
  $('btnRelaunchApp').addEventListener('click', async () => {
    if (!window.confirm('重启桌面应用？\n\n窗口会关闭并自动重新打开（约 2 秒）。\nQQ 服务不受影响，不需要重新启动它们。')) return;
    toast('正在重启应用…', 'info', 3000);
    await window.desktop.relaunchApp();
  });
  $('btnQuitApp').addEventListener('click', async () => {
    if (!window.confirm('退出桌面应用？\n\nQQ 桥接 / DSH / SnowLuma 服务会继续在后台运行，\n只是关闭这个管理窗口。\n\n（想同时停止服务，请先用上方的「停止」按钮）')) return;
    await window.desktop.quitApp();
  });

  for (const btn of document.querySelectorAll('[data-open]')) {
    btn.addEventListener('click', () => {
      const which = btn.dataset.open;
      if (which === 'openDsh') openDsh();
      else if (which === 'openConsole') {
        window.desktop.openConsole().then(() => toast('已在浏览器打开控制台', 'ok'));
      } else openPath(which);
    });
  }
}

// ── 视图切换（管理 / 聊天与出图）────────────────────────────────────────────
//
// 设计变更记录：早先用 iframe 把控制台嵌进这个视图，但它同时受
// X-Frame-Options、CSP frame-src、以及 file:// 源与 127.0.0.1 跨源三重限制，
// 实测在 Electron 里持续表现为「load 事件不触发 + 纯黑」（服务端响应头已确认正确）。
// 现改为**打开独立窗口**（控制台作为顶层页面加载）—— 上述限制全部不存在，
// 也能与管理窗口并排使用。因此这里不再需要加载 iframe 的逻辑。
function switchView(view) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  const views = { overview: 'viewOverview', monitor: 'viewMonitor', images: 'viewImages', settings: 'viewSettings' };
  for (const [name, id] of Object.entries(views)) {
    const el = $(id);
    if (el) el.hidden = name !== view;
  }
  // 进度条只在总览有意义（其他页看不到它，留着会让人以为卡住）
  if (view !== 'overview') $('progressBar').hidden = true;
  // 切到监测页时立刻刷一次，不用等下一个轮询周期
  if (view === 'monitor') refreshMonitor().catch(() => {});
  if (view === 'images') {
    refreshComfySetup().catch(() => {});
    if (!comfySetupTimer) comfySetupTimer = setInterval(() => refreshComfySetup().catch(() => {}), 1000);
  } else if (comfySetupTimer) {
    clearInterval(comfySetupTimer);
    comfySetupTimer = null;
  }
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

async function refreshComfySetup() {
  const [s, dsh] = await Promise.all([
    window.desktop.comfySetupStatus(),
    window.desktop.dshSetupStatus()
  ]);
  const job = s.job ?? {};
  $('dshSetupState').textContent = dsh.running ? '正在配置…' : (dsh.installed ? '✓ 已安装' : '尚未安装');
  $('dshSetupDetail').textContent = dsh.detail || '';
  $('btnDshSetup').textContent = dsh.installed ? '重新安装 / 修复 DSH 扩展' : '安装 DSH 兼容环境';
  $('btnDshSetup').disabled = Boolean(dsh.running);
  $('comfyVariant').value = s.variant || 'nvidia';
  if (!$('comfyInstallDir').matches(':focus')) $('comfyInstallDir').value = s.installDir || '';
  $('comfyEnvState').textContent = s.installed ? '✓ 已安装' : '尚未安装';
  $('comfyEnvDetail').textContent = s.installed ? `环境目录：${s.installDir}` : '需要约 10～20 GB 磁盘空间；实际大小取决于显卡版本。';
  const model = s.models?.sdxlBase;
  $('comfyModelState').textContent = model?.installed ? '✓ 已安装' : '尚未安装';
  $('comfyModelDetail').textContent = model?.installed ? `模型文件：${model.filename}` : `下载体积：${model?.sizeLabel ?? '约 6.9 GB'}`;
  $('btnComfyInstall').textContent = s.installed ? '重新安装 / 修复 ComfyUI' : '下载并安装 ComfyUI';
  $('btnComfyModelInstall').textContent = model?.installed ? '重新下载模型' : '下载并配置模型';
  $('btnComfyModelInstall').disabled = !s.installed || job.running;
  $('btnComfyInstall').disabled = job.running;
  $('btnComfyStart').disabled = !s.installed || job.running;
  $('btnComfyModels').disabled = !s.installed;
  $('btnComfyCancel').hidden = !job.running;
  $('comfySetupBadge').dataset.state = job.running ? 'busy' : (s.installed && model?.installed ? 'ok' : 'off');
  $('comfySetupBadge').textContent = job.running ? '安装进行中' : (s.installed && model?.installed ? '可以出图' : '需要配置');
  $('comfySetupProgress').style.width = `${Math.max(0, Math.min(100, Number(job.percent) || 0))}%`;
  $('comfySetupMessage').textContent = job.error ? `失败：${job.error}` : (job.message || '暂无任务');
  $('comfySetupBytes').textContent = job.received ? `${formatBytes(job.received)}${job.total ? ` / ${formatBytes(job.total)}` : ''}` : '';
}

function bindComfySetup() {
  $('btnDshSetup').addEventListener('click', async () => {
    if (!window.confirm('将为现有 DSH 安装或修复 QQ Bridge preset、MCP 工具与控制台扩展。\n\n完成后需要重启 DSH。Direct Runtime 用户不需要此项。\n\n继续吗？')) return;
    $('btnDshSetup').disabled = true;
    $('dshSetupState').textContent = '正在配置…';
    const r = await window.desktop.dshInstallCompatibility();
    if (r.ok) {
      toast('DSH 兼容环境已配置，请重启 DSH 使扩展生效', 'ok');
    } else {
      toast(`DSH 配置失败：${r.error}`, 'error');
    }
    refreshComfySetup();
  });
  $('btnComfyInstall').addEventListener('click', async () => {
    const installDir = $('comfyInstallDir').value.trim();
    if (!window.confirm(`将从 ComfyUI 官方 GitHub 下载 Windows Portable 环境。\n\n安装目录：${installDir}\n\n继续吗？`)) return;
    const r = await window.desktop.comfyInstall({ variant: $('comfyVariant').value, installDir });
    if (!r.ok) toast(r.error, 'error'); else toast('ComfyUI 下载已开始，可在本页查看进度', 'ok');
    refreshComfySetup();
  });
  $('btnComfyModelInstall').addEventListener('click', async () => {
    if (!$('comfyAcceptLicense').checked) { toast('请先阅读并接受模型许可证', 'warn'); return; }
    if (!window.confirm('将从 Stability AI 官方 Hugging Face 仓库下载约 6.9 GB 的 SDXL Base 1.0。\n\n继续吗？')) return;
    const r = await window.desktop.comfyInstallModel({ modelKey: $('comfyModel').value, acceptLicense: true });
    if (!r.ok) toast(r.error, 'error'); else toast('模型下载已开始', 'ok');
    refreshComfySetup();
  });
  $('btnComfyCancel').addEventListener('click', async () => {
    const r = await window.desktop.comfyCancelSetup();
    toast(r.ok ? '已请求取消下载' : r.error, r.ok ? 'warn' : 'error');
  });
  $('btnComfyStart').addEventListener('click', () => runComfy('start', '启动出图'));
  $('btnComfyStop').addEventListener('click', () => runComfy('stop', '停止出图'));
  $('btnComfyOpen').addEventListener('click', ACTION_HANDLERS.openComfy);
  $('btnComfyModels').addEventListener('click', () => openPath('models'));
  $('comfyLicenseLink').addEventListener('click', (event) => {
    event.preventDefault();
    window.desktop.openExternal('https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md');
  });
}

// ── 纯函数来自 pure.js（单独成文件是为了能被 Node 直接单测，不用起 Electron）──
const {
  parseLifecycleLines, isLifecycleSuccess, friendlyAction,
  describeTriggers, convKindLabel, relTime,
  wakeModeLabel, wakeReasonLabel, describeMessage,
  parseActivityLines, filterActivity, escapeHtml,
  buildModelOptions, MODEL_CUSTOM, describeDetection
} = window.RendererPure;

// ── 监测页 ──────────────────────────────────────────────────────────────────
// 数据全部来自桥接**已有**的 /api/* 端点，由主进程经 IPC 取回（令牌不进渲染层）。
let monitorPaused = false;
let monitorTimer = null;
let selectedConvKey = null;

function renderConversations(conversations) {
  const box = $('monList');
  box.innerHTML = '';
  if (!conversations.length) {
    box.innerHTML = '<p class="muted small">当前没有任何会话。'
      + '（会话在收到第一条消息时才建立；白名单见 config.json 的 allow）</p>';
    return;
  }
  // 按"未读多的排前面"排：让人第一眼看到最需要关注的那个
  const sorted = [...conversations].sort((a, b) => (b.unreadCount ?? 0) - (a.unreadCount ?? 0));
  for (const c of sorted) {
    const row = document.createElement('div');
    row.className = 'conv';
    row.dataset.state = c.wakeConfig?.mode === 'active' ? 'active' : 'diving';
    if (c.key === selectedConvKey) row.dataset.selected = 'true';

    const head = document.createElement('div');
    head.className = 'conv-head';
    const title = document.createElement('strong');
    title.textContent = convKindLabel(c.key);
    const mode = document.createElement('span');
    mode.className = 'conv-mode';
    mode.textContent = wakeModeLabel(c.wakeConfig?.mode);
    head.append(title, mode);

    const unread = document.createElement('span');
    unread.className = 'conv-unread';
    unread.textContent = (c.unreadCount ?? 0) > 0 ? `未读 ${c.unreadCount}` : '无未读';
    if ((c.unreadCount ?? 0) > 0) unread.dataset.hot = 'true';
    head.appendChild(unread);
    row.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'conv-meta';
    meta.innerHTML = '';
    const line = (label, value) => {
      const s = document.createElement('span');
      s.textContent = `${label}：${value}`;
      return s;
    };
    meta.append(
      line('上次唤醒', wakeReasonLabel(c.lastWakeReason)),
      line('最近 AI 回复', relTime(c.lastAiReplyAt))
    );
    row.appendChild(meta);

    const trig = document.createElement('div');
    trig.className = 'conv-triggers';
    trig.textContent = `触发：${describeTriggers(c.wakeConfig)}`;
    row.appendChild(trig);

    row.addEventListener('click', () => showConvMessages(c.key));
    box.appendChild(row);
  }
}

/* ── AI 运行时（dsh / direct）─────────────────────────────────────────────────
 * 数据来源两条：
 *   · **配置里写的** → IPC `runtime:get`（主进程读 config.json，apiKey 不回传）
 *   · **正在跑的**   → 桥接 /api/status 的 `runtime` 字段
 * 两者一比就知道"改了配置但还没重启"——这正是这个面板最需要说清的事。 */
let runtimeInfo = null;      // 配置里的（含 apiKeySet，不含明文）
let runtimeRunning = null;   // 桥接正在跑的（'dsh' | 'direct' | null=取不到）
let runtimeRunningModel = null;    // 正在跑的模型名（用于"改了模型但没重启"的判断）
let runtimeRunningBaseUrl = null;  // 正在用的接口地址

function currentRuntimeType() {
  return document.querySelector('input[name="rtType"]:checked')?.value ?? 'dsh';
}

function syncRuntimeForm() {
  const isDirect = currentRuntimeType() === 'direct';
  // 选 dsh 时把 direct 相关的字段置灰（值保留，切回来还在）
  // `images` / `temperature` 是 direct 分支才读的配置，所以同样跟着置灰 ——
  // 让它们可编辑会造成"我改了但没生效"的误解。
  for (const boxId of ['rtDirectFields', 'rtAdvanced']) {
    const box = $(boxId);
    if (box) box.style.opacity = isDirect ? '1' : '.5';
  }
  for (const id of ['rtBaseUrl', 'rtModel', 'rtModelCustom', 'rtApiKey', 'rtImages', 'rtTemperature', 'btnRuntimeSwitchModel']) {
    $(id).disabled = !isDirect;
    $(id).style.cursor = isDirect ? '' : 'not-allowed';
  }
}

/**
 * 把检测结果渲染出来。
 * 排版逻辑（三种分支 + "配置里的模型不在列表里"的警告）在 `pure.js` 的 `describeDetection`
 * 里，可单测；这里只负责把 `{text, state}` 写进 DOM。
 */
function renderDetection(res) {
  const box = $('rtDetectResult');
  const { text, state } = describeDetection(res, {
    cfgModel: runtimeInfo?.runtime?.model ?? '',
    runningModel: runtimeRunningModel ?? ''
  });
  box.textContent = text;          // ⚠️ textContent：内容含模型名（外部数据）
  box.dataset.state = state;
}

/** 跑一次模型检测：问接口 → 显示结果 → 顺手填下拉（同一份数据不问两次） */
async function runDetection() {
  const box = $('rtDetectResult');
  const baseUrl = $('rtBaseUrl').value.trim();
  if (!baseUrl) {
    box.textContent = '还没填接口地址 —— 填好会自动检测。';
    box.dataset.state = 'warn';
    return null;
  }
  box.textContent = '正在询问接口有哪些可用模型…';
  box.dataset.state = '';
  let res = null;
  try {
    res = await window.desktop.runtimeListModels({ baseUrl, apiKey: $('rtApiKey').value });
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  }
  renderDetection(res);
  fillModelSelect(res?.ok ? res.models : [], runtimeInfo?.runtime?.model ?? '', runtimeRunningModel);
  return res;
}

/** 接口地址 / key 变了就自动重测（change 在失焦或回车时触发，不会每敲一个字都发请求） */
let detectTimer = null;
function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => {
    if (currentRuntimeType() === 'direct') runDetection().catch(() => {});
  }, 500);
}

/** 下拉里当前选中的模型名（选了"自定义"就取文本框）。MODEL_CUSTOM 由 pure.js 提供。 */
function currentModel() {
  const sel = $('rtModel');
  if (sel.value === MODEL_CUSTOM) return $('rtModelCustom').value.trim();
  return sel.value.trim();
}

/**
 * 填充模型下拉。
 * 选项怎么构造（含两个边界：拉不到列表 / 当前模型不在列表里）由 `pure.js` 的
 * `buildModelOptions` 决定并单测；这里只负责把它变成 DOM。
 */
function fillModelSelect(models, cfgModel, runningModel) {
  const sel = $('rtModel');
  const built = buildModelOptions(models, cfgModel, runningModel);
  sel.innerHTML = '';
  for (const o of built.options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;          // ⚠️ 用 textContent：模型名来自外部接口
    sel.appendChild(opt);
  }
  sel.value = built.selected;
  const custom = $('rtModelCustom');
  custom.hidden = !built.needCustom;
  custom.value = built.customValue;
  const hint = $('rtModelHint');
  if (hint) hint.textContent = built.hint;
}

function renderRuntimeState() {
  const stateEl = $('rtState');
  const curEl = $('rtCurrent');
  if (!runtimeInfo) { curEl.textContent = '读取失败'; return; }

  const cfgType = runtimeInfo.runtime?.type ?? 'dsh';
  const apiKeyNote = runtimeInfo.apiKeySet
    ? '已保存 key'
    : (cfgType === 'direct' ? '未设置 key（本地接口可用）' : '（无需 key）');
  const dshNote = runtimeInfo.dsh?.hasToken
    ? 'DSH 令牌已配置'
    : (runtimeInfo.dsh?.baseUrl ? 'DSH 缺令牌' : 'DSH 未配置');

  curEl.textContent = `配置：${cfgType === 'direct' ? '直连 AI API' : '挂 DSH'}`
    + `（${cfgType === 'direct' ? `${runtimeInfo.runtime.baseUrl} · ${runtimeInfo.runtime.model} · ${apiKeyNote}` : dshNote}）`;

  // 关键提示：配置 vs 正在跑。
  // ⚠️ 要比的不只是"哪种运行时" —— **模型和接口地址改了同样要重启**，
  //    只比 type 会在"换了模型但没重启"时说"已生效"，那是错的。
  //    （模型有热切换按钮，所以这条提示还能告诉用户"热切换到底成没成"。）
  if (runtimeRunning === null) {
    stateEl.textContent = '（桥接未响应，无法确认生效状态）';
    stateEl.dataset.state = 'warn';
    return;
  }
  if (runtimeRunning !== cfgType) {
    stateEl.textContent = `⚠️ 需重启（正在跑的是 ${runtimeRunning === 'direct' ? '直连' : 'DSH'}）`;
    stateEl.dataset.state = 'warn';
    return;
  }
  const diffs = [];
  if (runtimeRunningModel && runtimeInfo.runtime.model && runtimeRunningModel !== runtimeInfo.runtime.model) {
    diffs.push(`模型（跑的是 ${runtimeRunningModel}）`);
  }
  if (runtimeRunningBaseUrl && runtimeInfo.runtime.baseUrl && runtimeRunningBaseUrl !== runtimeInfo.runtime.baseUrl) {
    diffs.push('接口地址');
  }
  if (diffs.length) {
    stateEl.textContent = `⚠️ 需重启才生效：${diffs.join('、')}`;
    stateEl.dataset.state = 'warn';
  } else {
    stateEl.textContent = '✅ 已生效';
    stateEl.dataset.state = 'ok';
  }
}

async function refreshRuntime() {
  try {
    runtimeInfo = await window.desktop.runtimeGet();
  } catch (e) {
    runtimeInfo = { ok: false, error: String(e?.message ?? e) };
  }
  if (!runtimeInfo?.ok) {
    $('rtCurrent').textContent = `读取失败：${runtimeInfo?.error ?? '未知错误'}`;
    return;
  }
  const t = runtimeInfo.runtime.type;
  $(t === 'direct' ? 'rtTypeDirect' : 'rtTypeDsh').checked = true;
  $('rtBaseUrl').value = runtimeInfo.runtime.baseUrl ?? '';
  // 密钥永远不回填 —— 留空即"不修改"
  $('rtApiKey').value = '';
  $('rtApiKey').placeholder = runtimeInfo.apiKeySet ? '（已保存，留空不修改）' : '（未填写）';

  // 两个行为开关。⚠️ `images` 的语义是"不等于 false 就开"（桥接侧 `rc.images !== false`），
  // 所以**"配置里没写"应当显示为勾上** —— 直接取 `?? true` 会让默认值看起来是关的。
  $('rtImages').checked = runtimeInfo.runtime.images !== false;
  $('rtTemperature').value = runtimeInfo.runtime.temperature ?? '';

  // "正在跑的"由主进程一并取回（桥接没起来 → null，界面显示"未知"而不假装知道）
  // ⚠️ 必须在填模型下拉**之前**赋值 —— 下拉要用 runningModel 标出"运行中"的那一项。
  runtimeRunning = runtimeInfo.running ?? null;
  runtimeRunningModel = runtimeInfo.runningModel ?? null;
  runtimeRunningBaseUrl = runtimeInfo.runningBaseUrl ?? null;

  // **自动检测模型**：问接口有哪些可用模型 → 填下拉 + 把结果显示在「模型检测」区。
  // （以前只悄悄填下拉，用户看不到检测到了什么、更看不到为什么失败。）
  // 注意上一步已经赋好 runtimeRunningModel —— 下拉要用它标出"运行中"的那个。
  runDetection().catch(() => {});

  syncRuntimeForm();
  renderRuntimeState();
}

function setRuntimeResult(text, kind = 'info') {
  const el = $('rtResult');
  el.textContent = text;
  // warn 用琥珀色：「配置已保存，但运行时没切过去」这种情况既不是成功也不是失败，
  // 但**必须一眼看见**（它意味着"你以为生效了，其实要重启"）。
  el.style.color = kind === 'error' ? '#ff9aa2' : (kind === 'ok' ? '#9ee0b0' : (kind === 'warn' ? '#e8cf9a' : ''));
}

function bindRuntime() {
  for (const id of ['rtTypeDsh', 'rtTypeDirect']) {
    $(id).addEventListener('change', () => { syncRuntimeForm(); renderRuntimeState(); });
  }

  // 选「自定义…」时露出文本框；选回列表项时收起来（值保留，来回切不丢）
  $('rtModel').addEventListener('change', () => {
    const isCustom = $('rtModel').value === MODEL_CUSTOM;
    $('rtModelCustom').hidden = !isCustom;
    if (isCustom) $('rtModelCustom').focus();
  });

  // 模型检测：手动重测 + 改了接口地址/key 自动重测
  $('btnRuntimeDetect').addEventListener('click', () => { runDetection().catch(() => {}); });
  $('rtBaseUrl').addEventListener('change', scheduleDetect);
  $('rtApiKey').addEventListener('change', scheduleDetect);

  $('btnRuntimeTest').addEventListener('click', async () => {
    const btn = $('btnRuntimeTest');
    btn.disabled = true;
    setRuntimeResult('正在测试…');
    try {
      // 测连接只对 direct 有意义；dsh 模式下直接说明，不要假装测了
      if (currentRuntimeType() !== 'direct') {
        setRuntimeResult('当前选的是 DSH —— 连接性由 DSH 那边决定，这里不测。切到"直连 AI API"再测。', 'info');
        return;
      }
      const r = await window.desktop.runtimeTest({
        baseUrl: $('rtBaseUrl').value.trim(),
        model: currentModel(),
        apiKey: $('rtApiKey').value        // 留空 = 用已保存的那把（主进程处理）
      });
      if (r.ok) {
        setRuntimeResult(`✅ 连接成功（${r.latencyMs}ms）模型回复「${r.reply}」`, 'ok');
      } else {
        setRuntimeResult(`❌ ${r.error}${r.hint ? `\n${r.hint}` : ''}`, 'error');
      }
    } catch (e) {
      setRuntimeResult(`❌ 测试失败：${e?.message ?? e}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 热切换模型：探测 → 保存 → 立即生效（不重启桥接）
  $('btnRuntimeSwitchModel').addEventListener('click', async () => {
    const btn = $('btnRuntimeSwitchModel');
    const model = currentModel();
    if (!model) { setRuntimeResult('先填模型名（或用输入框的下拉建议）', 'error'); return; }
    btn.disabled = true;
    setRuntimeResult(`正在用 ${model} 试一次请求…`);
    try {
      const r = await window.desktop.runtimeSwitchModel({
        model,
        baseUrl: $('rtBaseUrl').value.trim(),
        apiKey: $('rtApiKey').value      // 留空 = 用已保存的那把
      });
      if (r.ok) {
        const applied = r.applied
          ? '已立即生效（无需重启）'
          : `配置已保存，但**运行时没切过去**：${r.applyError ?? '桥接未响应'} —— 重启桥接后生效`;
        setRuntimeResult(`✅ 模型已切到 ${r.model}（探测 ${r.latencyMs}ms · 回复「${r.reply}」）· ${applied}`, r.applied ? 'ok' : 'warn');
        $('rtApiKey').value = '';
        await refreshRuntime();
      } else {
        setRuntimeResult(`❌ ${r.error}${r.hint ? `\n${r.hint}` : ''}`, 'error');
      }
    } catch (e) {
      setRuntimeResult(`❌ 切换失败：${e?.message ?? e}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnRuntimeSave').addEventListener('click', async () => {    const btn = $('btnRuntimeSave');
    btn.disabled = true;
    setRuntimeResult('正在保存…');
    try {
      const r = await window.desktop.runtimeSave({
        type: currentRuntimeType(),
        baseUrl: $('rtBaseUrl').value.trim(),
        model: currentModel(),
        apiKey: $('rtApiKey').value,        // 留空 = 不改
        images: $('rtImages').checked,
        // 空串 = "用模型默认"（主进程会把这一项删掉，而不是写 0 —— 0 是有意义的取值）
        temperature: $('rtTemperature').value.trim()
      });
      if (r.ok) {
        setRuntimeResult(`✅ 已保存${r.backup ? `（备份 ${r.backup.split(/[\\/]/).pop()}）` : ''} —— 重启桥接后生效`, 'ok');
        $('rtApiKey').value = '';
        await refreshRuntime();
      } else {
        setRuntimeResult(`❌ ${r.error}`, 'error');
      }
    } catch (e) {
      setRuntimeResult(`❌ 保存失败：${e?.message ?? e}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/* 活动流：原来是 `box.textContent = text` —— 把桥接日志原样塞进 <pre>，
 * 一坨等宽文字，看不出哪条是报错、哪条是发送。现在拆成结构化行 + 分类着色 + 筛选。
 * 解析与分类是纯函数，放在 pure.js（可单测）；这里只负责建 DOM。
 * 用 createElement + textContent（**不用 innerHTML**）—— 内容是群聊消息，必须防注入。 */
let activityFilter = '';
// 记住上一次拿到的活动流原文：切筛选时立刻用它重画，不必等下一个 5 秒刷新
let lastActivityText = '';

function renderActivity(text) {
  lastActivityText = text ?? '';
  const box = $('monActivity');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const all = parseActivityLines(text);
  const rows = filterActivity(all, activityFilter);

  const countEl = $('monActCount');
  if (countEl) {
    countEl.textContent = activityFilter
      ? `${rows.length} / ${all.length} 行`
      : (all.length ? `${all.length} 行` : '');
  }

  box.innerHTML = '';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = all.length
      ? '当前筛选下没有匹配的行。'
      : '（暂无活动记录 —— 群里有人说话、或机器人被唤醒时，这里会出现内容）';
    box.appendChild(p);
    return;
  }

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'act-row';
    row.dataset.kind = r.kind;

    const t = document.createElement('span');
    t.className = 'act-time';
    t.textContent = r.time || '--:--:--';

    const s = document.createElement('span');
    s.className = 'act-scope';
    s.textContent = r.scope || (r.tag ? '' : '');

    const x = document.createElement('span');
    x.className = 'act-text';
    x.textContent = r.text;
    x.title = r.text;              // 长消息被截断时，悬停看全文

    row.append(t, s, x);
    box.appendChild(row);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderModeStrip(info) {
  const box = $('ovModeStrip');
  box.innerHTML = '';
  const chip = (label, value, state) => {
    const el = document.createElement('span');
    el.className = 'chip';
    if (state) el.dataset.state = state;
    el.innerHTML = `<span class="chip-label">${label}</span><span class="chip-value">${value}</span>`;
    return el;
  };
  // 状态条里的"引擎"芯片要跟着**正在跑的**运行时走：
  // 原来无条件显示 `DSH 已就绪/未就绪` —— 而 direct 模式下桥接的 dshReady 是被
  // **硬置真**的，于是会显示"DSH 已就绪"，让人以为机器人还在走 DSH。那是假信息。
  const engineChip = info.runtime === 'direct'
    ? chip('直连', info.runtimeModel || 'AI API', 'ok')
    : chip('DSH', info.dshReady ? '已就绪' : '未就绪', info.dshReady ? 'ok' : 'warn');
  box.append(
    chip('模式', info.mode ?? '—', info.mode === 'reserved2' ? 'ok' : undefined),
    chip('角色', info.role ?? '—', info.roleMode === 'active' ? 'ok' : undefined),
    chip('管理员', info.ownerQQ ?? '（未设置）', info.ownerQQ ? 'ok' : 'warn'),
    engineChip,
    chip('仿真暂停', info.socialV2Paused ? '是' : '否', info.socialV2Paused ? 'warn' : 'ok'),
    chip('放行', `群 ${info.allowGroups?.length ?? 0} · 私聊 ${info.allowPrivate?.length ?? 0}`)
  );
}

async function refreshMonitor() {
  const status = $('monStatus');
  try {
    const [states, activity] = await Promise.all([
      window.desktop.monitorStates(),
      window.desktop.monitorActivity()
    ]);
    if (!activity.ok) {
      status.textContent = `读不到桥接数据：${activity.error ?? '未知原因'}`;
      $('monActivity').textContent = '（桥接未运行，或控制台令牌不可读）';
      return;
    }
    status.textContent = `自动刷新 ${monitorPaused ? '已暂停' : '中（5 秒）'} · ${new Date().toLocaleTimeString('zh-CN')}`;
    renderModeStrip(activity);
    if (!monitorPaused) renderActivity(activity.activity);
    if (states.ok) renderConversations(states.conversations ?? []);
    else $('monList').innerHTML = `<p class="muted small">读不到会话状态：${states.error ?? ''}</p>`;
  } catch (error) {
    status.textContent = `刷新失败：${error?.message ?? error}`;
  }
}

async function showConvMessages(key) {
  selectedConvKey = key;
  for (const el of document.querySelectorAll('.conv')) {
    el.dataset.selected = String(el.querySelector('strong')?.textContent === convKindLabel(key));
  }
  const box = $('monDetail');
  box.hidden = false;
  $('monDetailTitle').textContent = `${convKindLabel(key)} 最近消息`;
  $('monDetailBody').innerHTML = '<p class="muted small">读取中…</p>';
  try {
    const r = await window.desktop.monitorRecent(key, 30);
    if (!r.ok) { $('monDetailBody').innerHTML = `<p class="muted small">读取失败：${r.error ?? ''}</p>`; return; }
    const msgs = r.messages ?? [];
    if (!msgs.length) { $('monDetailBody').innerHTML = '<p class="muted small">该会话暂无缓存消息。</p>'; return; }

    // 消息 → 展示行的翻译规则在 pure.js 的 describeMessage()（有单测守着字段名）
    const html = [...msgs].reverse().map((m) => {
      const d = describeMessage(m);
      const time = d.time ? new Date(d.time).toLocaleTimeString('zh-CN') : '';
      return `<div class="msg"><span class="msg-who">${escapeHtml(d.who)}</span>`
        + `<span class="msg-time">${time}${d.badges ? ` · ${escapeHtml(d.badges)}` : ''}</span>`
        + `<div class="msg-text">${escapeHtml(d.text.slice(0, 500))}</div></div>`;
    }).join('');
    $('monDetailBody').innerHTML = html;
  } catch (error) {
    $('monDetailBody').innerHTML = `<p class="muted small">读取失败：${error?.message ?? error}</p>`;
  }
}

function bindMonitor() {
  $('monPauseBtn').addEventListener('click', () => {
    monitorPaused = !monitorPaused;
    $('monPauseBtn').textContent = monitorPaused ? '▶ 继续' : '⏸ 暂停';
    toast(monitorPaused ? '活动流已暂停（不再自动刷新与滚动）' : '活动流已恢复', 'info', 2200);
    if (!monitorPaused) refreshMonitor().catch(() => {});
  });
  $('monActFilter').addEventListener('change', (e) => {
    activityFilter = e.target.value;
    // 立刻重画（用上一次拿到的文本），不必等下一个 5 秒
    renderActivity(lastActivityText);
  });  $('monDetailClose').addEventListener('click', () => {
    $('monDetail').hidden = true;
    selectedConvKey = null;
  });
  // 每 5 秒刷新；即使切到别的分区也继续跑（切回来时数据是热的），但暂停时不刷新
  monitorTimer = setInterval(() => { if (!monitorPaused) refreshMonitor().catch(() => {}); }, 5000);
}

async function openConsoleWindow() {
  const status = $('embedStatus');
  status.textContent = '正在打开控制台窗口…';
  try {
    const r = await window.desktop.openConsoleWindow();
    status.textContent = r?.ok
      ? (r.reused ? '控制台窗口已在最前（复用已有窗口）' : '已打开控制台窗口')
      : `打开失败：${r?.error ?? '未知原因'}`;
  } catch (error) {
    status.textContent = `打开失败：${error?.message ?? error}`;
  }
}

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }
  $('btnOpenConsoleWindow').addEventListener('click', openConsoleWindow);
  $('btnEmbedBrowser').addEventListener('click', () => {
    window.desktop.openConsole().then(() => toast('已在浏览器打开控制台', 'ok'));
  });
}

// ── 卸载 ────────────────────────────────────────────────────────────────────
// 只在切到「管理」视图时把计划摘要显示出来（提前让用户看到"会删什么、释放多少"），
// 真正的确认与数据选择交给主进程的原生对话框（更醒目、不容易误点）。
async function refreshUninstallInfo() {
  const el = $('uninstallInfo');
  if (!el) return;
  try {
    const r = await window.desktop.uninstallPlan();
    if (!r?.ok) { el.textContent = `（无法读取卸载计划：${r?.error ?? '未知原因'}）`; return; }
    const mb = Math.round((r.plan.freeingBytes ?? 0) / 1048576);
    const deps = (r.plan.summary?.nodeModules ?? []).map((d) => `${d.label.split(' ')[0]} ${d.mb}MB`).join(' + ');
    el.textContent = `可释放约 ${mb} MB（${deps || '无依赖'}）；源码与 .git 默认保留`;
  } catch (error) {
    el.textContent = `（无法读取卸载计划：${error?.message ?? error}）`;
  }
}

function bindUninstall() {
  const btn = $('btnUninstall');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await window.desktop.startUninstall();
      if (r?.ok) {
        toast('已启动独立卸载程序，本应用即将退出…', 'warn', 3000);
      } else if (r?.cancelled) {
        toast('已取消卸载', 'info');
      } else {
        toast(`卸载未能启动：${r?.error ?? '未知原因'}`, 'error', 4000);
      }
    } catch (error) {
      toast(`卸载未能启动：${error?.message ?? error}`, 'error', 4000);
    } finally {
      btn.disabled = false;
    }
  });
  refreshUninstallInfo();
}

// ── 配置导出 / 导入 ─────────────────────────────────────────────────────────
async function doExportConfig(sanitize) {
  const btn = $(sanitize ? 'btnExportSanitized' : 'btnExportConfig');
  const label = sanitize ? '脱敏配置' : '完整配置';
  if (btn) btn.disabled = true;
  try {
    const r = await window.desktop.exportConfig({ sanitize });
    if (r?.ok) {
      toast(`已导出${label}：${r.path.split('\\').pop()}`, 'ok', 4000);
    } else {
      toast(`导出失败：${r?.error ?? '未知原因'}`, 'error', 5000);
    }
  } catch (error) {
    toast(`导出失败：${error?.message ?? error}`, 'error', 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindConfigTools() {
  $('btnExportConfig')?.addEventListener('click', () => doExportConfig(false));
  $('btnExportSanitized')?.addEventListener('click', () => doExportConfig(true));
  $('btnImportConfig')?.addEventListener('click', async () => {
    const btn = $('btnImportConfig');
    if (btn) btn.disabled = true;
    try {
      // 主进程会先弹文件选择框，再显示预览对话框，确认后才写入
      const r = await window.desktop.importConfig();
      if (r?.ok) toast('配置已导入，请重启桥接使其生效', 'ok', 5000);
      else if (r?.cancelled) toast('已取消导入', 'info');
      else toast(`导入失败：${r?.error ?? '未知原因'}`, 'error', 6000);
    } catch (error) {
      toast(`导入失败：${error?.message ?? error}`, 'error', 6000);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ── 总览：最近事件（读主进程的操作时间线）────────────────────────────────────
// 行格式与解析规则见 pure.js（那里可被 Node 直接单测）。
async function refreshOverviewEvents() {
  const box = $('ovEvents');
  try {
    const raw = await window.desktop.lifecycleLog();
    const lines = Array.isArray(raw) ? raw : (raw?.lines ?? []);
    const events = parseLifecycleLines(lines);
    if (!events.length) {
      box.innerHTML = '<li class="muted small">暂无记录。启动/重启/停止服务、看门狗自动拉起都会记在这里。</li>';
      return;
    }
    box.innerHTML = events.slice(-6).reverse().map((e) => {
      const when = new Date(e.at).toLocaleTimeString('zh-CN');
      const cls = isLifecycleSuccess(e.message) ? 'ev-ok' : 'ev-warn';
      return `<li><span class="ev-time">${when}</span>`
        + `<span class="${cls}">${escapeHtml(friendlyAction(e.action))}</span>`
        + `<span class="muted small">${escapeHtml(e.message.replace(/^结束（|）$/g, ''))}</span></li>`;
    }).join('');
  } catch (error) {
    box.innerHTML = `<li class="muted small">读取时间线失败：${error?.message ?? error}</li>`;
  }
}

// ── 初始化 ──────────────────────────────────────────────────────────────────
(async function init() {
  bindActions();
  bindSettings();
  bindTabs();
  bindUninstall();
  bindConfigTools();
  bindMonitor();
  bindRuntime();
  bindComfySetup();

  try {
    const info = await window.desktop.info();
    $('appMeta').textContent = `v${info.version} · Electron ${info.electron} · Node ${info.node}`;
    $('aboutText').textContent =
      `「总览」看服务是否正常；「监测」看 QQ 里正在发生什么；`
      + `聊天 / 出图 / 角色 / 黑话 / 记忆等完整功能在网页控制台里（「监测」页可一键打开）。`
      + `\n配置目录：${info.root}`;
  } catch {}

  try { applySettings(await window.desktop.getSettings()); } catch {}
  // AI 运行时面板：读配置 + 问桥接"正在跑的是哪个"，两者比对出"需不需要重启"
  refreshRuntime().catch(() => {});

  // 主进程推送：体检结果 / 忙碌状态 / 设置变化
  window.desktop.onHealth(renderHealth);
  // 主进程也会推 lifecycle 状态；只在它明确说"空了"且本地确实还卡着时兜底恢复，
  // 避免与 runLifecycle 的 finally 抢着改按钮状态（会闪）。
  window.desktop.onLifecycle(({ busy: b }) => {
    if (!b && busy) { setBusy(false); hideProgress(); }
  });
  window.desktop.onSettings(applySettings);

  await refresh();
  await refreshOverviewEvents();
  await refreshMonitor();
})();
