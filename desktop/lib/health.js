// 自动检查：对桥接 / DSH / SnowLuma / ComfyUI 四项做体检，返回结构化结果。
//
// 设计原则：
//   - 每项都给出 status（ok/warn/error/off）+ 一句话说明 + **可操作的建议**（能点的按钮 id），
//     不做只报错不给办法的检查。
//   - 检查本身绝不抛异常：任何一项失败都降级为该项的 error，不影响其它项。
//   - 只读：不修改任何东西、不启动任何进程（启动是 UI 上单独的按钮）。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { observeDshEndpoint } from './dsh-watch.js';

export function readConfig(root) {
  try {
    let text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readConsoleToken(root) {
  const cfg = readConfig(root);
  if (cfg?.consoleToken) return cfg.consoleToken;
  try {
    return fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// 端口探测：能连上即视为在监听（用于 DSH / SnowLuma / ComfyUI 这类外部服务）
export function probePort(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function fetchJson(url, { headers = {}, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) };
  }
}

function item(key, label, status, detail, actions = [], extra = {}) {
  return { key, label, status, detail, actions, ...extra };
}

function maskAccount(value) {
  const text = String(value ?? '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(4, text.length - 4))}${text.slice(-2)}`;
}

/**
 * 四项体检。返回 { checkedAt, overall, items }。
 * overall: ok（全通）/ degraded（有警告）/ error（有关键项失败）
 */
export async function healthCheck(root, options = {}) {
  const { dshManagerPort = 3780 } = options;
  const cfg = readConfig(root);
  const portFromUrl = (value, fallback) => {
    try { return Number(new URL(String(value)).port) || fallback; } catch { return fallback; }
  };
  // 跟配置探测端口，避免用户改端口后把健康服务误报为离线。
  const consolePort = Number(options.consolePort ?? cfg?.consolePort) || 3100;
  const snowlumaPort = Number(options.snowlumaPort) || portFromUrl(cfg?.snowluma?.httpUrl, 3000);
  const snowlumaWsPort = Number(options.snowlumaWsPort) || portFromUrl(cfg?.snowluma?.wsUrl, 3001);
  // ComfyUI 地址优先用桥接配置里的 comfy.host（出图用的就是它），拿不到再退回默认
  const comfyHost = options.comfyHost ?? cfg?.comfy?.host ?? 'http://127.0.0.1:8188';
  const token = readConsoleToken(root);
  const items = [];
  // 用户可以在 config.json 里二选一：挂 DSH，或直连标准 OpenAI 兼容 API（direct）。
  // ⚠️ 这个开关决定"DSH 算不算关键项" —— 在 direct 下把 DSH 缺失报成 error 是**错的**
  //   （机器人根本不经过它），而那正是"界面在说假话"的来源：
  //   底层早就脱钩了，界面却还在报红说"没有 DSH，AI 不会回复任何消息"。
  const runtimeType = cfg?.runtime?.type === 'direct' ? 'direct' : 'dsh';
  let bridgeLive = null;   // 桥接 /api/status 的原始响应，用来比对"配置说的"与"实跑的"

  // ── 1. 配置文件 ──────────────────────────────────────────────────────────
  if (!cfg) {
    items.push(item('config', '配置文件', 'error',
      'config.json 不存在或不是合法 JSON —— 没有它桥接无法启动',
      [{ id: 'openFolder', label: '打开目录' }, { id: 'createConfig', label: '从模板创建' }]));
  } else {
    const missing = [];
    if (!cfg.ownerQQ) missing.push('ownerQQ');
    if (!cfg.snowluma?.wsUrl) missing.push('snowluma.wsUrl');
    if (missing.length) {
      items.push(item('config', '配置文件', 'warn',
        `config.json 可读，但缺少关键项：${missing.join('、')}`,
        [{ id: 'openConfig', label: '打开配置' }]));
    } else {
      items.push(item('config', '配置文件', 'ok', `config.json 正常（ownerQQ ${maskAccount(cfg.ownerQQ)}）`));
    }
  }

  // ── 2. 桥接（关键项）─────────────────────────────────────────────────────
  const bridgeRes = await fetchJson(`http://127.0.0.1:${consolePort}/api/status`, {
    headers: token ? { 'x-console-token': token } : {}
  });
  if (bridgeRes.ok && bridgeRes.json) {
    const st = bridgeRes.json;
    bridgeLive = st;
    // 摘要里报的是**桥接实际在跑的**引擎（不是配置里写的）——
    // 两者不一致正是"改了配置但还没重启"的信号。
    const engine = st.runtime === 'direct'
      ? `直连${st.runtimeModel ? ` ${st.runtimeModel}` : ' AI API'}`
      : (st.dshReady ? 'DSH 就绪' : 'DSH 未就绪');
    items.push(item('bridge', 'QQ 桥接', st.runtimeReady === false ? 'warn' : 'ok',
      `在线（模式 ${st.mode ?? '?'}，角色 ${st.role ?? '无'}，${engine}）`,
      [], { live: { mode: st.mode, role: st.role, runtime: st.runtime ?? null, runtimeModel: st.runtimeModel ?? null, dshReady: st.dshReady, allowGroups: st.allowGroups ?? [] } }));
    // 只在"配置说挂 DSH"时才把 dshReady=false 当成问题。
    // （direct 下 dshReady 是被硬置真的，这条本来也不会触发；真不一致会在下面「AI 运行时」项里点名。）
    if (runtimeType === 'dsh' && st.dshReady === false) {
      items.push(item('dsh-link', '桥接 ↔ DSH', 'warn',
        '桥接在线但报告 DSH 未就绪 —— AI 回复会失败',
        [{ id: 'restartAll', label: '一键重启' }, { id: 'openDsh', label: '打开 DSH' }]));
    }
  } else if (bridgeRes.status === 401) {
    items.push(item('bridge', 'QQ 桥接', 'warn',
      '在线但控制台令牌不匹配（state/console-token 与 config.json 不一致）',
      [{ id: 'openConfig', label: '打开配置' }]));
  } else {
    items.push(item('bridge', 'QQ 桥接', 'error',
      `无法访问 127.0.0.1:${consolePort}（${bridgeRes.error ?? `HTTP ${bridgeRes.status}`}）`,
      [{ id: 'startAll', label: '一键启动' }, { id: 'openLog', label: '看日志' }]));
  }

  // ── 3. AI 运行时（关键项）＋ DSH（**只在挂 DSH 时才是关键项**）────────────
  const dshUp = await probePort('127.0.0.1', dshManagerPort);

  if (runtimeType === 'direct') {
    // 直连模式：DSH **不是**关键项 —— 机器人不经过它，缺了也不该报错。
    // 这一项只如实报告"配置里写的"与"桥接实际在跑的"，并给出下一步。
    const rt = cfg?.runtime ?? {};
    const model = rt.model || '';
    const baseUrl = rt.baseUrl || '';
    const running = bridgeLive?.runtime ?? null;
    let status = 'ok';
    let detail = `直连 AI API：${model || '（没填 model）'} @ ${baseUrl || '（没填 baseUrl）'}`;
    if (!model || !baseUrl) {
      status = 'warn';
      detail = `直连 AI API 配置不全：缺 ${[!model && 'model', !baseUrl && 'baseUrl'].filter(Boolean).join('、')} —— 桥接起不来`;
    } else if (running && running !== 'direct') {
      // 不是错误，是"还没重启"：桥接只在启动时读一次配置。
      status = 'warn';
      detail += ` —— 但桥接现在跑的是 ${running}，重启桥接后才生效`;
    } else if (bridgeLive?.runtime === 'direct' && bridgeLive.runtimeReady === false) {
      status = 'error';
      detail += ' —— 桥接在线，但 AI 运行时未就绪';
    } else if (bridgeLive?.runtimeModel && model && bridgeLive.runtimeModel !== model) {
      status = 'warn';
      detail += ` —— 当前仍在运行 ${bridgeLive.runtimeModel}，保存后需重启或热切换`;
    }
    items.push(item('runtime', 'AI 运行时', status, detail,
      [{ id: 'openConfig', label: '打开配置' }],
      { live: { type: 'direct', model, baseUrl, running, apiKeySet: Boolean(rt.apiKey) } }));

    // DSH 在直连模式下是**可选的**：用户可能还在用它的网页端（做别的活）。
    // 在就如实显示，不在就**完全不提** —— "不提"才叫不绑定。
    if (dshUp) {
      const mgr = await fetchJson(`http://127.0.0.1:${dshManagerPort}/api/state`, { timeoutMs: 4000 });
      const dshRun = mgr.json?.versions?.find?.((v) => v.status === 'running') ?? null;
      const dshUrl = dshRun?.url ? dshRun.url.replace(/\?.*$/, '') : null;
      items.push(item('dsh', 'DSH（可选）', 'ok',
        `在线${dshUrl ? `（${dshUrl}）` : ''} —— 机器人不经过它，这只是你自己在用的界面`,
        [{ id: 'openDsh', label: '打开界面' }], { optional: true }));
    }
  } else if (dshUp) {
    const mgr = await fetchJson(`http://127.0.0.1:${dshManagerPort}/api/state`, { timeoutMs: 4000 });
    let detail = '管理器在线';
    let dshUrl = null;
    if (mgr.ok && mgr.json) {
      const running = mgr.json.versions?.find?.((v) => v.status === 'running') ?? null;
      if (running?.url) { dshUrl = running.url.replace(/\?.*$/, ''); detail = `运行中（${dshUrl}）`; }
    }
    // 监测 DSH 是否刚重启过（端点会变）。用户抱怨过两次"掉线"，这样就能看到时间与时长。
    let watch = null;
    try {
      watch = observeDshEndpoint(dshUrl);
    } catch {}
    const extra = [];
    if (watch?.changed) {
      extra.push({ id: 'openDshRestartLog', label: '看重启记录' });
      detail += ' —— 检测到刚重启过（端口变了）';
    }
    items.push(item('dsh', 'DSH', watch?.changed ? 'warn' : 'ok', detail,
      [{ id: 'openDsh', label: '打开界面' }, ...extra]));
  } else {
    let watch = null;
    try {
      watch = observeDshEndpoint(null);
    } catch {}
    const downFor = watch?.downSince ? Math.round((Date.now() - watch.downSince) / 1000) : null;
    items.push(item('dsh', 'DSH', 'error',
      `127.0.0.1:${dshManagerPort} 无监听 —— 没有 DSH，AI 不会回复任何消息`
      + `${downFor != null ? `（已中断约 ${downFor}s）` : ''}`,
      [{ id: 'openDshRestartLog', label: '看重启记录' }, { id: 'openDshDocs', label: '查看说明' }]));
  }

  // ── 4. SnowLuma（关键项：QQ 网关）────────────────────────────────────────
  const slWs = await probePort('127.0.0.1', snowlumaWsPort, 1200);
  const slHttp = await probePort('127.0.0.1', snowlumaPort, 1200);
  if (slWs || slHttp) {
    items.push(item('snowluma', 'SnowLuma 网关', 'ok',
      `在线（${[slWs && `WS ${snowlumaWsPort}`, slHttp && `HTTP ${snowlumaPort}`].filter(Boolean).join(' + ')}）`));
  } else {
    items.push(item('snowluma', 'SnowLuma 网关', 'error',
      `WS ${snowlumaWsPort} / HTTP ${snowlumaPort} 均无监听 —— 收不到 QQ 消息`,
      [{ id: 'startAll', label: '一键启动' }]));
  }

  // ── 5. ComfyUI（可选：只为出图）──────────────────────────────────────────
  const comfyPort = Number(new URL(comfyHost).port || 8188);
  const comfyUp = await probePort('127.0.0.1', comfyPort);
  // 一冷一热两种状态给的动作不一样：没起来时只能"启动"（打开界面会白页），
  // 起来了才给"打开界面"。
  const comfyStartAction = { id: 'comfyStart', label: '启动出图' };
  const comfyOpenAction = { id: 'openComfy', label: '打开界面' };
  const comfyStopAction = { id: 'comfyStop', label: '停止' };
  if (comfyUp) {
    const stats = await fetchJson(`${comfyHost}/system_stats`, { timeoutMs: 4000 });
    const dev = stats.json?.devices?.[0];
    items.push(item('comfyui', 'ComfyUI（出图）', 'ok',
      `在线${dev?.name ? `（${dev.name.split(':').slice(-1)[0].trim()}）` : ''}`,
      [comfyOpenAction, comfyStopAction], {
        optional: true,
        live: { vramTotalGb: dev?.vram_total ? Number((dev.vram_total / 1073741824).toFixed(1)) : null }
      }));
  } else {
    items.push(item('comfyui', 'ComfyUI（出图）', 'off',
      '未运行 —— 聊天与回复不受影响；点「启动出图」会拉起它（冷启动要 30~60 秒加载底模）',
      [comfyStartAction, { id: 'openModels', label: '打开模型目录' }], { optional: true }));
  }

  // ── 6. 出图模型就绪度（可选）─────────────────────────────────────────────
  if (comfyUp && cfg?.comfy?.models) {
    const models = await fetchJson(`${comfyHost}/object_info/UNETLoader`, { timeoutMs: 5000 });
    const avail = models.json?.UNETLoader?.input?.required?.unet_name?.[0];
    if (Array.isArray(avail)) {
      const presets = Object.values(cfg.comfy.models);
      const missing = presets
        .filter((p) => p.family !== 'checkpoint' && p.unet && !avail.includes(p.unet))
        .map((p) => p.unet);
      if (missing.length) {
        items.push(item('models', '出图底模', 'warn',
          `有预设的底模文件缺失：${missing.join('、')}`,
          [{ id: 'openModels', label: '打开模型目录' }], { optional: true }));
      } else {
        items.push(item('models', '出图底模', 'ok', `${presets.length} 个预设的底模文件都在`, [], { optional: true }));
      }
    }
  }

  const critical = items.filter((i) => !i.optional);
  const overall = critical.some((i) => i.status === 'error') ? 'error'
    : items.some((i) => i.status === 'warn' || i.status === 'error') ? 'degraded'
      : 'ok';

  return { checkedAt: new Date().toISOString(), overall, items };
}
