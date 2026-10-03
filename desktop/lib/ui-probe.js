// UI 探针：让 AI（或任何无法看屏幕的人）能**验证界面真的渲染成什么样**。
//
// 由来：本机 Electron 必须提权才能跑，而 AI 的工具通道拿不到交互式桌面，
// 所以"改完界面看不到效果"一直是这个项目的痛点 —— 只能靠用户当眼睛。
// 这个探针把三件东西落盘，就足以判断布局对不对：
//   ① 每个分区的**截图**（capturePage → PNG）—— 能直接看图
//   ② **几何与可见性**：分区/关键元素的 boundingRect、hidden、滚动高度
//   ③ **溢出检测**：有没有元素被挤出视口、或宽度为 0（"看不见但没报错"的典型）
//
// 启用方式：环境变量 QB_UI_PROBE=1（由 scripts/probe-ui.ps1 提权调用）。
// 产物落在 state/ui-probe/<时间戳>/ 下：overview.png / monitor.png / settings.png
//   与 report.json、report.txt。
import fs from 'node:fs';
import path from 'node:path';

export function probeDir(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(root, 'state', 'ui-probe', stamp);
}

/** 在渲染层里跑的采集脚本：返回纯数据，逻辑都在这里，便于审查 */
export const COLLECT_SCRIPT = `(() => {
  const out = { views: {}, elements: [], overflow: [], texts: {} };

  // 1) 三个分区的可见性与尺寸（隐藏的也临时量一次真实高度）
  const VIEWS = ['viewOverview', 'viewMonitor', 'viewGenerate', 'viewImages', 'viewSettings'];
  for (const id of VIEWS) {
    const el = document.getElementById(id);
    if (!el) { out.views[id] = { missing: true }; continue; }
    const original = el.hidden;
    el.hidden = false;                       // 临时显示以便量到真实高度
    const cs = getComputedStyle(el);
    out.views[id] = {
      hidden: original,
      measuredWhileHidden: original,
      display: cs.display,
      offsetHeight: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      childCount: el.children.length
    };
    el.hidden = original;                    // 立刻还原（同步块内，用户看不到）
  }

  // 2) 关键元素的几何（用来判断"有没有渲染出来、有没有被挤没"）
  //    同样：若元素所在分区是隐藏的，先在同步块里让它可见再量。
  // **静态**选择器：必须能在 index.html 里找到（改名就会静默少数据）
  const KEYS_STATIC = [
    '#overallPill', '#btnStart', '#btnCheck', '#btnRestartBridge', '#btnRestart', '#btnStop',
    '#healthGrid', '#ovModeStrip', '#ovEvents', '#diagnoseOut',
    '#monList', '#monActivity', '#monDetail', '#btnOpenConsoleWindow', '#monPauseBtn',
    // 活动流改版后新增的（步骤 B）
    '#monActFilter', '#monActCount',
    // AI 运行时面板（设置页首家）：切换 dsh/direct、字段、测试与保存
    '#rtState', '#rtCurrent', '#rtTypeDsh', '#rtTypeDirect',
    '#rtBaseUrl', '#rtModel', '#rtApiKey', '#rtDirectFields',
    '#btnRuntimeTest', '#btnRuntimeSave', '#rtResult',
    // 行为开关（看图 / 温度）
    '#rtAdvanced', '#rtImages', '#rtTemperature',
    // 热切换模型（需求：direct 下在应用里直接换模型，不必重启）
    '#btnRuntimeSwitchModel', '#rtModelCustom', '#rtModelHint',
    // 模型检测区：主动问接口有哪些可用模型，并把结果**显示出来**（以前只悄悄填下拉）
    '#btnRuntimeDetect', '#rtDetectResult',
    '.titlebar', '.tabs', '#viewOverview > .panel', '.settings-grid', '#btnUninstall', '.panel-danger'
  ];
  // **动态**选择器：由 JS 在运行时创建，静态 HTML 里没有 —— 所以要去 app.js 里找它有没有被创建。
  // （我第一版把它们混在一起，检查工具于是"正确地"报了 .act-row 缺失，但那是误报：
  //   它只是没区分"静态存在"与"运行时生成"这两种情况。）
  const KEYS_DYNAMIC = [
    '.act-row', '.act-row .act-time', '.act-row .act-text'
  ];
  const KEYS = [...KEYS_STATIC, ...KEYS_DYNAMIC];
  const shownForMeasure = [];
  for (const id of VIEWS) {
    const v = document.getElementById(id);
    if (v && v.hidden) { v.hidden = false; shownForMeasure.push(v); }
  }
  for (const sel of KEYS) {
    const el = document.querySelector(sel);
    if (!el) { out.elements.push({ sel, missing: true }); continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.elements.push({
      sel,
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
    });
  }

  // 3) 溢出/零尺寸检测：这两类是"界面看着不对"最常见的形态
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const el of document.querySelectorAll('.view *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 2 || r.left < -2) {
      out.overflow.push({ kind: 'horizontal', tag: el.tagName.toLowerCase(),
        cls: el.className?.toString?.().slice(0, 60), left: Math.round(r.left), right: Math.round(r.right), vw });
    }
  }
  out.viewport = { w: vw, h: vh, dpr: window.devicePixelRatio };

  // 4) 各分区正文（读一遍就知道内容对不对）
  for (const id of ['ovModeStrip', 'ovEvents', 'monList', 'monActivity', 'healthGrid']) {
    const el = document.getElementById(id);
    out.texts[id] = el ? (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 1200) : null;
  }

  // 还原：把为测量临时显示的分区藏回去（顺序无关，都在同步块里）
  for (const v of shownForMeasure) v.hidden = true;

  // 5) 页面级的装配线索
  out.doctitle = document.title;
  out.hasRendererPure = typeof window.RendererPure === 'object';
  out.hasDesktopApi = typeof window.desktop === 'object';
  out.desktopMethods = out.hasDesktopApi ? Object.keys(window.desktop).length : 0;
  // 顺带数一下动态生成的元素到底渲染出来没有（活动流改版后最需要确认的就是这个）
  out.dynamicCounts = {
    actRows: document.querySelectorAll('.act-row').length,
    convRows: document.querySelectorAll('.conv').length,
    msgRows: document.querySelectorAll('.msg, .msg-row').length
  };
  // 运行时面板的**实际取值**（只有值能让 AI 确认"表单填对了没有"，光看尺寸看不出）
  out.runtimeForm = (() => {
    const q = (id) => document.getElementById(id);
    const checked = document.querySelector('input[name="rtType"]:checked');
    return {
      selected: checked ? checked.value : null,
      currentText: q('rtCurrent')?.textContent ?? null,
      stateText: q('rtState')?.textContent ?? null,
      stateFlag: q('rtState')?.dataset?.state ?? null,
      baseUrl: q('rtBaseUrl')?.value ?? null,
      model: q('rtModel')?.value ?? null,
      // 模型下拉：光看"选中值"不足以确认它填对了 —— 还要看**有几个选项**、
      // 有没有"自定义"那一项、文本框是不是按预期显示/隐藏。
      modelOptions: q('rtModel') ? [...q('rtModel').options].map((o) => o.value) : null,
      modelOptionLabels: q('rtModel') ? [...q('rtModel').options].map((o) => o.textContent) : null,
      modelCustomVisible: q('rtModelCustom') ? !q('rtModelCustom').hidden : null,
      modelCustomValue: q('rtModelCustom')?.value ?? null,
      modelHint: q('rtModelHint')?.textContent ?? null,
      // 检测结果区的**实际文本与状态**：这一条最能验证"检测功能真的把结果显示出来了"。
      // （只看出元素宽度不够 —— 我要读到"检测到 2 个可用模型"这类内容才算验过。）
      detectText: q('rtDetectResult')?.textContent ?? null,
      detectState: q('rtDetectResult')?.dataset?.state ?? null,
      apiKeyValue: (q('rtApiKey')?.value ?? '').length,      // 只报长度：永远不回传密钥内容
      apiKeyPlaceholder: q('rtApiKey')?.placeholder ?? null,
      directFieldsDisabled: q('rtBaseUrl')?.disabled ?? null,
      // 行为开关：这两个是"用户能看见什么/说话像不像人"的直接反映
      imagesChecked: q('rtImages')?.checked ?? null,
      temperatureValue: q('rtTemperature')?.value ?? null,
      advancedDisabled: q('rtImages')?.disabled ?? null
    };
  })();
  return out;
})()`;

/**
 * 轻量版采集：**不需要提权、不需要额外脚本** —— 直接并进应用既有的启动诊断。
 *
 * 存在的理由：完整探针（上面的 runUiProbe）要跑一个独立 Electron 实例，
 * 而本机 electron.exe 必须提权 → 每次都得弹 UAC 让用户点。
 * 但用户**本来就会启动应用**，所以把采集挂到启动流程上，等于零成本拿数据：
 * 用户重启一次应用，AI 就能从 state/ui-report.json 读到布局是否正常。
 */
export async function collectOnce(win) {
  try {
    return await win.webContents.executeJavaScript(COLLECT_SCRIPT, true);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** 把采集结果压成一行日志（desktop.log 里看得懂的那种） */
export function summarize(data) {
  if (!data || data.error) return `采集失败：${data?.error ?? '无数据'}`;
  const views = Object.entries(data.views ?? {})
    .map(([id, v]) => `${id.replace('view', '')}=${v.hidden ? '隐' : '显'}/${v.offsetHeight}px`)
    .join(' ');
  const zero = (data.elements ?? []).filter((e) => !e.missing && (e.w === 0 || e.h === 0)).map((e) => e.sel);
  return [
    `视口 ${data.viewport?.w}x${data.viewport?.h}`,
    views,
    `溢出 ${data.overflow?.length ?? 0}`,
    zero.length ? `零尺寸元素 ${zero.join(',')}` : '无零尺寸元素',
    `RendererPure=${data.hasRendererPure} desktop=${data.hasDesktopApi}(${data.desktopMethods})`
  ].join(' | ');
}

export async function runUiProbe(win, { root, log = () => {} }) {
  const dir = probeDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const report = { at: new Date().toISOString(), dir, views: {}, shots: {}, errors: [] };

  // 渲染层控制台报错是最有诊断价值的东西 —— 必须收进来
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) report.errors.push({ level, message: String(message).slice(0, 300), source: String(sourceId).split(/[\\/]/).pop(), line });
  });

  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      const file = path.join(dir, `${name}.png`);
      fs.writeFileSync(file, png);
      const size = img.getSize();
      report.shots[name] = { file, bytes: png.length, w: size.width, h: size.height };
      log(`[ui-probe] 截图 ${name}: ${size.width}x${size.height}, ${png.length} 字节`);
    } catch (e) {
      report.errors.push({ level: 99, message: `截图失败 ${name}: ${e?.message ?? e}` });
    }
  };

  const collect = async (label) => {
    try {
      const data = await win.webContents.executeJavaScript(COLLECT_SCRIPT, true);
      report.views[label] = data;
      log(`[ui-probe] 采集 ${label}: 视口 ${data.viewport?.w}x${data.viewport?.h}, 溢出 ${data.overflow?.length ?? 0} 处`);
    } catch (e) {
      report.errors.push({ level: 99, message: `采集失败 ${label}: ${e?.message ?? e}` });
    }
  };

  // 等页面稳定：load 之后再留一点时间让 init() 里的异步 IPC 回来
  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(resolve, 3500));
    else setTimeout(resolve, 2500);
  });

  // 依次切到全部一级分区、各截一张并采集一次。
  // 这些图同时可直接用于项目介绍视频素材。
  for (const [view, label] of [
    ['overview', 'overview'],
    ['monitor', 'monitor'],
    ['generate', 'generate'],
    ['images', 'extensions'],
    ['settings', 'settings']
  ]) {
    try {
      await win.webContents.executeJavaScript(
        `(typeof switchView === 'function') ? switchView('${view}') : null`, true);
    } catch (e) {
      report.errors.push({ level: 99, message: `切换分区 ${view} 失败: ${e?.message ?? e}` });
    }
    await new Promise((r) => setTimeout(r, view === 'monitor' ? 1800 : 900));
    await collect(label);
    await shot(label);
  }

  // 报告：JSON 给程序看，TXT 给人（和 AI）看
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  const lines = [];
  lines.push(`UI 探针报告  ${report.at}`);
  lines.push(`产物目录：${dir}`);
  lines.push('');
  lines.push('== 截图 ==');
  for (const [k, v] of Object.entries(report.shots)) lines.push(`  ${k}.png  ${v.w}x${v.h}  ${v.bytes} 字节`);
  lines.push('');
  lines.push('== 渲染层错误 ==');
  lines.push(report.errors.length ? report.errors.map((e) => `  [${e.level}] ${e.message} (${e.source ?? ''}:${e.line ?? ''})`).join('\n') : '  ✅ 无');
  lines.push('');
  lines.push('== 依赖装配 ==');
  for (const [label, d] of Object.entries(report.views)) {
    lines.push(`  ${label}: RendererPure=${d.hasRendererPure} desktopApi=${d.hasDesktopApi}(${d.desktopMethods} 个方法) 视口=${d.viewport?.w}x${d.viewport?.h}`);
    break; // 装配信息三个分区都一样
  }
  lines.push('');
  for (const [label, d] of Object.entries(report.views)) {
    lines.push(`== 分区 ${label} ==`);
    lines.push(`  视口 ${d.viewport?.w}x${d.viewport?.h}`);
    lines.push('  分区可见性：');
    for (const [id, v] of Object.entries(d.views ?? {})) {
      lines.push(`    ${id.padEnd(14)} hidden=${String(v.hidden).padEnd(5)} display=${String(v.display).padEnd(6)} 高=${v.offsetHeight} 内容高=${v.scrollHeight} 子元素=${v.childCount}`);
    }
    lines.push('  关键元素：');
    for (const e of d.elements ?? []) {
      if (e.missing) { lines.push(`    ${e.sel.padEnd(26)} ❌ 不存在`); continue; }
      lines.push(`    ${e.sel.padEnd(26)} ${String(e.w).padStart(4)}x${String(e.h).padStart(4)} @${e.top},${e.left}  display=${e.display} 字号=${e.fontSize}`);
      if (e.text) lines.push(`        「${e.text.slice(0, 100)}」`);
    }
    if (d.overflow?.length) {
      lines.push(`  ⚠️ 横向溢出 ${d.overflow.length} 处：`);
      for (const o of d.overflow.slice(0, 8)) lines.push(`    ${o.tag}.${o.cls} left=${o.left} right=${o.right} (视口宽 ${o.vw})`);
    } else {
      lines.push('  ✅ 无横向溢出');
    }
    lines.push('');
  }
  lines.push('== 正文抽样 ==');
  for (const [k, t] of Object.entries(report.views.overview?.texts ?? {})) {
    lines.push(`--- ${k} ---`);
    lines.push(t ? t.split('\n').slice(0, 14).map((l) => `  ${l}`).join('\n') : '  (null)');
  }
  const reportTxt = path.join(dir, 'report.txt');
  fs.writeFileSync(reportTxt, lines.join('\n'), 'utf8');
  log(`[ui-probe] 报告已写入 ${reportTxt}`);
  return { dir, reportTxt };
}
