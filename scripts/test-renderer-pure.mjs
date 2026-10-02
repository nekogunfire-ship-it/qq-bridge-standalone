// 渲染层纯函数的单测。
//
// 为什么值得专门测：这些函数是"把桥接数据翻译成人话"的地方，也是我**实际写错过**的地方 ——
// 第一版把消息时间字段猜成 `at`（实际是 `time`）、把操作时间线当成对象数组
// （实际是字符串数组）。抽成 pure.js 后 Node 能直接 require，不用起 Electron。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ⚠️ 不能用 require()：本仓库 package.json 是 "type": "module"，`.js` 会被当成 ESM，
//    UMD 的 `module.exports` 分支根本不会走（实测 require 拿到的是空命名空间）。
// 所以这里**按浏览器的方式加载**：给一个带 self 的上下文，跑脚本，再取 self.RendererPure。
// 这样测的就是渲染层真实走的路径。
const PURE_SRC = path.join(ROOT, 'desktop', 'renderer', 'pure.js');
const sandbox = { self: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(PURE_SRC, 'utf8'), sandbox, { filename: 'pure.js' });
const pure = sandbox.self.RendererPure;

if (!pure || typeof pure.parseLifecycleLines !== 'function') {
  console.error('❌ pure.js 没有在 self 上挂出 RendererPure —— 渲染层会直接报错');
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── 1. 操作时间线的解析（真实行格式，取自 state/desktop-lifecycle.log）────────
const realLines = [
  '2026-09-26T11:10:33.891Z [watchdog:startAll] 结束（成功，总耗时 6.5s）',
  '2026-09-26T11:13:27.204Z [restartBridgeOnly] 开始',
  '2026-09-26T11:13:27.204Z [restartBridgeOnly]   +0.0s 调用 launcher',
  '2026-09-26T11:13:27.204Z [restartBridgeOnly]   +5.3s launcher 已返回',
  '2026-09-26T11:13:27.204Z [restartBridgeOnly]   +5.3s 体检完成',
  '2026-09-26T11:13:27.204Z [restartBridgeOnly] 结束（成功，总耗时 5.3s）'
];
const parsed = pure.parseLifecycleLines(realLines);
check('解析出事件（只留汇总行与开始行，丢掉逐步骤的 +X.Xs 行）',
  parsed.length === 3, `解出 ${parsed.length} 条：${parsed.map((e) => e.action).join(', ')}`);
check('解析出 ISO 时间戳', parsed[0].at === '2026-09-26T11:10:33.891Z', parsed[0]?.at);
check('解析出动作名', parsed[0].action === 'watchdog:startAll', parsed[0]?.action);
check('解析出内容', /结束（成功/.test(parsed[0].message), parsed[0]?.message);
check('能识别成功/失败', pure.isLifecycleSuccess(parsed[0].message) === true
  && pure.isLifecycleSuccess('结束（失败，总耗时 1.0s）') === false);
check('空输入不炸', pure.parseLifecycleLines([]).length === 0
  && pure.parseLifecycleLines(undefined).length === 0);
check('不认识的行被跳过（不产出垃圾条目）', pure.parseLifecycleLines(['随便一行', '', '   ']).length === 0);

// ── 2. 动作名翻人话（含看门狗前缀）───────────────────────────────────────────
check('普通动作翻中文', pure.friendlyAction('restartBridgeOnly') === '重启桥接');
check('看门狗动作带前缀说明',
  pure.friendlyAction('watchdog:startAll') === '看门狗自动启动全部服务',
  pure.friendlyAction('watchdog:startAll'));
check('未知动作原样返回（不吞掉信息）', pure.friendlyAction('someNewAction') === 'someNewAction');
check('空动作有兜底', pure.friendlyAction('') === '（未知动作）');

// ── 3. 会话 key → 人话 ──────────────────────────────────────────────────────
check('群 key 转「群 号码」', pure.convKindLabel('group:200000002') === '群 200000002');
check('私聊 key 转「私聊 号码」', pure.convKindLabel('private:1000000001') === '私聊 1000000001');
check('非标准 key 原样返回', pure.convKindLabel('weird') === 'weird');

// ── 4. 相对时间（传 now 保证可复现）─────────────────────────────────────────
const NOW = 1_700_000_000_000;
check('无时间戳时给明确文案', pure.relTime(0, NOW) === '（还没回过）');
check('秒级', pure.relTime(NOW - 30_000, NOW) === '30 秒前', pure.relTime(NOW - 30_000, NOW));
check('分钟级', pure.relTime(NOW - 5 * 60_000, NOW) === '5 分钟前');
check('小时级', pure.relTime(NOW - 3 * 3_600_000, NOW) === '3 小时前');
check('天级', pure.relTime(NOW - 2 * 86_400_000, NOW) === '2 天前');
check('未来时间不显示负数', pure.relTime(NOW + 10_000, NOW) === '刚刚');

// ── 5. 唤醒条件 → 人话 ─────────────────────────────────────────────────────
check('无触发条件时明确说明',
  /无触发条件/.test(pure.describeTriggers({})), pure.describeTriggers({}));
check('列出各类触发条件',
  (() => {
    const s = pure.describeTriggers({ triggers: { atMention: true, question: true, probability: 0.2, keywords: ['a', 'b'] } });
    return s.includes('@') && s.includes('提问') && s.includes('概率 0.2') && s.includes('关键词×2');
  })(), pure.describeTriggers({ triggers: { atMention: true, question: true, probability: 0.2, keywords: ['a', 'b'] } }));
check('概率为 0 时不列出（避免误导"会按概率开口"）',
  !pure.describeTriggers({ triggers: { probability: 0 } }).includes('概率'));
check('空唤醒配置不炸', typeof pure.describeTriggers(undefined) === 'string');

// ── 6. 唤醒模式/原因标签 ───────────────────────────────────────────────────
check('潜水/活跃有标签', pure.wakeModeLabel('diving').includes('潜水') && pure.wakeModeLabel('active').includes('活跃'));
check('未知模式原样返回', pure.wakeModeLabel('newmode') === 'newmode');
check('唤醒原因翻中文', pure.wakeReasonLabel('probability') === '概率命中');
check('未知原因原样返回', pure.wakeReasonLabel('newreason') === 'newreason');

// ── 7. 消息 → 展示行（字段名是实测出来的，这里就是防止再写错）────────────────
const realMsg = {
  seq: 2302, messageId: '38548004', sender: 'sankaku', userId: '2328727099',
  text: '@某人 你说什么？', plain: '@某人 你说什么？', isSelf: false, isOwner: false,
  media: [], hasMedia: false, hasForward: false, time: 1790423425988
};
const d = pure.describeMessage(realMsg);
check('用 sender 昵称而不是 QQ 号', d.who === 'sankaku', d.who);
check('用 time 字段（不是 at）', d.time === 1790423425988, String(d.time));
check('正文取 text', d.text.includes('你说什么'), d.text);
check('无徽章时不产出空串', d.badges === '', `「${d.badges}」`);

const selfMsg = pure.describeMessage({ isSelf: true, text: 'hi', time: 1 });
check('自己发的标成 AI', selfMsg.who.includes('AI'), selfMsg.who);

const mediaMsg = pure.describeMessage({ sender: 'x', hasMedia: true, text: '', time: 1 });
check('纯媒体消息有可读占位', mediaMsg.text.includes('图片') || mediaMsg.text.includes('非文本'), mediaMsg.text);
const fwdMsg = pure.describeMessage({ sender: 'x', hasForward: true, text: '', time: 1 });
check('合并转发有可读占位', fwdMsg.text.includes('转发'), fwdMsg.text);
const emptyMsg = pure.describeMessage({ sender: 'x', text: '', time: 1 });
check('空消息有兜底', emptyMsg.text === '（空消息）', emptyMsg.text);
check('缺 sender 且缺 userId 时兜底为"系统"',
  pure.describeMessage({ text: 'a' }).who === '系统');
check('缺 sender 但有 userId 时显示 QQ 号',
  pure.describeMessage({ userId: '123', text: 'a' }).who === 'QQ 123');
check('徽章组合正确',
  pure.describeMessage({ sender: 'x', isOwner: true, hasMedia: true, text: 'a' }).badges === '管理员 · 含媒体');
check('消息对象为空也不炸', typeof pure.describeMessage({}).text === 'string');

// ── 8. HTML 转义（渲染层用 innerHTML，必须防注入）────────────────────────────
check('转义尖括号与 &',
  pure.escapeHtml('<img src=x onerror=alert(1)> & "q"') === '&lt;img src=x onerror=alert(1)&gt; &amp; "q"',
  pure.escapeHtml('<img src=x onerror=alert(1)> & "q"'));
check('中文与 emoji 不受影响', pure.escapeHtml('小鲸鱼🐳') === '小鲸鱼🐳');

// ── 9. 渲染层文件本身的自洽（防"改了 pure.js 忘了加载"）──────────────────────
const html = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer', 'index.html'), 'utf8');
check('index.html 在 app.js 之前加载 pure.js',
  html.indexOf('src="pure.js"') !== -1 && html.indexOf('src="pure.js"') < html.indexOf('src="app.js"'));
check('pure.js 是 UMD 外壳（浏览器挂 window，CJS 环境挂 module.exports）', (() => {
  const src = fs.readFileSync(PURE_SRC, 'utf8');
  return src.includes('module.exports') && src.includes('RendererPure');
})());
// ⚠️ 但要说清：本仓库是 "type": "module"，所以 require() 走不通（`.js` 被当 ESM）。
//    测试与使用都必须按浏览器方式加载（见本文件开头的 vm 加载）。
check('已知限制：不能靠 require() 加载（本仓库是 ESM），必须走 self 挂载', (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.type === 'module';   // 若哪天改成 CJS，这条会失败并提醒更新加载方式
})(), 'package.json type=module');

// ── 活动流解析与分类（步骤 B：把原始日志变成能看的东西）──────────────────────
// 夹具用**真实活动流实测到的三种形状**（100 行归纳出来的），不是编的：
const REAL_ACTIVITY = [
  '[14:47:19] group:200000002 [reserved2] 消息已入未读：这个你问别人可能更靠谱。',
  '[14:48:04] group:200000002 [reserved2] 工具统一发送：成功 2/2 条',
  '[14:48:27] group:200000002 拍一拍事件：@某人 拍了拍 我',        // ← 这一种**没有 [模式]**
  '[14:47:33] private:1000000001 [reserved2] 消息已入未读：[引用 蓝色大肥鱼：⚠️ 消息未能送达 AI：HTTP 401: …] 怎么不把apikey发全',
  '',
  '  这是一行没有时间戳的（比如读到写入中的半行）'
].join('\n');

const rows = pure.parseActivityLines(REAL_ACTIVITY);
check('活动流：空行被跳过', rows.length === 5, `${rows.length} 行（输入 6 行，含 1 个空行）`);
check('活动流：时间被正确切出来', rows[0].time === '14:47:19', rows[0].time);
check('活动流：群号变成人话「群 NNN」', rows[0].scope === '群 200000002', rows[0].scope);
check('活动流：私聊也认', rows[3].scope === '私聊 1000000001', rows[3].scope);
check('活动流：模式标签被单独取出', rows[0].tag === 'reserved2', rows[0].tag);
check('⚠️ 活动流：**没有 [模式] 的行**也能正确解析（否则整行会变成正文）',
  rows[2].tag === '' && rows[2].text === '拍一拍事件：@某人 拍了拍 我',
  `tag=${JSON.stringify(rows[2].tag)} text=${rows[2].text.slice(0, 24)}`);
check('活动流：正文不含前导的时间/会话', !/^\[|group:/.test(rows[0].text), rows[0].text.slice(0, 30));
check('⚠️ 活动流：**解析不了的行不丢弃**（宁可显示朴素，也不让内容消失）',
  rows[4].time === '' && rows[4].text.includes('没有时间戳'), rows[4].text.slice(0, 30));

// 分类（决定着色与筛选）
check('分类：正常收消息 → inbox', rows[0].kind === 'inbox', rows[0].kind);
check('分类：发送成功 → send', rows[1].kind === 'send', rows[1].kind);
check('⚠️ 分类：含 401/未送达 → error（这条最重要：报错必须一眼看出来）',
  rows[3].kind === 'error', rows[3].kind);
check('分类：唤醒类 → wake',
  pure.activityKind('已计划唤醒 group:1，2500ms 后发送') === 'wake');
check('分类：工具调用 → tool', pure.activityKind('调用工具 qq_send_message(...)') === 'tool');
check('分类：不认识的 → plain', pure.activityKind('随便一句别的') === 'plain');
check('分类：优先判 error（同一行既像发送又含失败时，必须算 error）',
  pure.activityKind('工具统一发送：失败 0/2 条') === 'error');

// 筛选
check('筛选：空值返回全部', pure.filterActivity(rows, '').length === rows.length);
check('筛选：只看报错只留 error', pure.filterActivity(rows, 'error').every((r) => r.kind === 'error'));
check('筛选：只看发送的数量正确', pure.filterActivity(rows, 'send').length === 1);
check('筛选：筛不到东西时返回空数组（界面要能显示空状态）',
  Array.isArray(pure.filterActivity(rows, 'nope')) && pure.filterActivity(rows, 'nope').length === 0);

// 常量
check('提供了筛选器选项列表（界面不该硬编码）',
  Array.isArray(pure.ACTIVITY_FILTERS) && pure.ACTIVITY_FILTERS.some((f) => f.value === 'error'));
check('每种分类都有中文标签（用于提示）',
  ['error', 'send', 'tool', 'wake', 'inbox', 'plain'].every((k) => pure.ACTIVITY_KIND_LABEL[k]));

// ⚠️ 安全：渲染活动流**绝不能用 innerHTML** —— 内容是群聊消息，可含 <img onerror=...>
const appSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer', 'app.js'), 'utf8');
const renderFn = appSrc.slice(appSrc.indexOf('function renderActivity'), appSrc.indexOf('function renderModeStrip'));
// ⚠️ 别把 `innerHTML = ''`（清空容器）也算成危险 —— 那是安全且常见的写法。
//    我第一版就写成"只要出现 innerHTML = 就报错"，于是误报了自己。
const unsafeAssign = renderFn
  .replace(/innerHTML\s*=\s*(''|""|``)\s*;/g, '')      // 先剔除"赋空串"这种清空写法
  .match(/innerHTML\s*=/);
check('⚠️ 安全：renderActivity 不给 innerHTML 赋非空内容（群聊内容必须防注入）',
  renderFn.includes('textContent') && !unsafeAssign,
  unsafeAssign ? `发现：${unsafeAssign[0]}` : '只用 textContent（清空容器用 innerHTML="" 是安全的）');
check('⚠️ 安全：活动流解析函数本身不产出 HTML', (() => {
  const evil = pure.parseActivityLines('[00:00:01] group:1 <img src=x onerror=alert(1)>');
  return evil[0].text.includes('<img') && pure.escapeHtml(evil[0].text).includes('&lt;img');
})());

// ── 模型下拉的选项构造（两个边界会造成"一保存就把模型改掉了"）────────────────
const mo1 = pure.buildModelOptions(['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-flash', 'deepseek-flash');
check('模型下拉：列表里的模型都在选项里', mo1.options.map((o) => o.value).includes('deepseek-v4-pro'));
check('模型下拉：末尾有"自定义"那一项', mo1.options.at(-1).value === pure.MODEL_CUSTOM);
check('模型下拉：配置里的模型被选中', mo1.selected === 'deepseek-flash', mo1.selected);
check('模型下拉：不需要显示自定义文本框', mo1.needCustom === false);
check('模型下拉：运行中的那个被标出来', mo1.options[0].label.includes('运行中'), mo1.options[0].label);

// ★ 边界②：当前模型**不在**接口返回的列表里（真实例子 deepseek-chat：能用但 /models 不列它）
const mo2 = pure.buildModelOptions(['deepseek-flash'], 'deepseek-chat', 'deepseek-chat');
check('★ 模型下拉：当前模型不在列表里时，**仍然放进选项并选中**（否则一保存就换了模型）',
  mo2.options.some((o) => o.value === 'deepseek-chat') && mo2.selected === 'deepseek-chat',
  mo2.options.map((o) => o.value).join(', '));
check('★ 模型下拉：上面那种情况不该逼用户去手填', mo2.needCustom === false);

// ★ 边界①：接口拉不到列表（本地 Ollama 未必实现 /models）
// 注：**不许**因为"列表空"就把用户扔进空文本框 —— "保证当前模型在选项里"这条规则
// 已经涵盖了这种情况：下拉仍是 [当前模型, 自定义…]，从当前模型切走仍然方便。
// （我第一版测试写的是"应该落回自定义"，跑出来发现实现的行为更好，于是改的是测试。）
const mo3 = pure.buildModelOptions([], 'qwen2.5', null);
check('★ 模型下拉：拉不到列表时，当前模型仍在选项里并被选中（不把用户扔进空文本框）',
  mo3.selected === 'qwen2.5' && mo3.needCustom === false
  && mo3.options.map((o) => o.value).join(',') === 'qwen2.5,__custom__',
  JSON.stringify({ selected: mo3.selected, needCustom: mo3.needCustom }));
check('★ 模型下拉：拉不到列表时**提示文字要说实话**（按接口真正返回的数量报，不按兜底后的列表）',
  mo3.hint.includes('读不到'), mo3.hint);
check('模型下拉：拉到了列表就报真实数量',
  pure.buildModelOptions(['a', 'b'], 'a', null).hint.includes('可用 2 个'),
  pure.buildModelOptions(['a', 'b'], 'a', null).hint);
check('模型下拉：配置里根本没有模型时，才落回自定义可编辑',
  (() => { const r = pure.buildModelOptions([], '', null); return r.selected === pure.MODEL_CUSTOM && r.needCustom === true; })());
check('模型下拉：完全没有模型时也至少有"自定义"一项（下拉不能是空的）',
  pure.buildModelOptions([], '', null).options.length === 1);
check('模型下拉：列表里有重复项时去重',
  pure.buildModelOptions(['a', 'a', 'b'], 'a', null).options.filter((o) => o.value === 'a').length === 1);
check('模型下拉：非字符串项被过滤掉（接口返回的脏数据）',
  pure.buildModelOptions(['a', null, 42, { id: 'x' }], 'a', null).options.map((o) => o.value).join(',') === 'a,__custom__');
check('模型下拉：没有运行中信息时不乱标"运行中"',
  pure.buildModelOptions(['a'], 'a', null).options[0].label === 'a');

// ── 模型检测结果的排版（三种分支 + "配置里的模型不在列表里"的警告）──────────────
const dOk = pure.describeDetection(
  { ok: true, models: ['deepseek-flash', 'deepseek-v4-pro'], latencyMs: 199, source: '已保存的 key' },
  { cfgModel: 'deepseek-flash', runningModel: 'deepseek-flash' }
);
check('检测（成功）：说清检测到几个', dOk.text.includes('检测到 2 个可用模型'), dOk.text.split('\n')[0]);
check('检测（成功）：报耗时与用的哪把 key（诊断信息）',
  dOk.text.includes('199ms') && dOk.text.includes('已保存的 key'));
check('检测（成功）：逐个列出模型名', dOk.text.includes('deepseek-v4-pro'));
check('检测（成功）：标出"配置里的"与"运行中"',
  dOk.text.includes('（运行中 · 配置里的）'), dOk.text.split('\n')[1]);
check('检测（成功）：状态是 ok', dOk.state === 'ok');

// ★ 配置里的模型**不在**检测结果里（真实例子：deepseek-chat 能用但 /models 不列它）
const dMiss = pure.describeDetection(
  { ok: true, models: ['deepseek-flash'], latencyMs: 150 },
  { cfgModel: 'deepseek-chat', runningModel: 'deepseek-chat' }
);
check('★ 检测：配置里的模型不在列表里时给出警告（但明确说"不代表不能用"）',
  dMiss.text.includes('不在这个列表里') && dMiss.text.includes('不代表不能用'),
  dMiss.text.split('\n').at(-1));
check('检测：上面那种情况仍算成功（不是错误态）', dMiss.state === 'ok');

// 失败：必须带"下一步查什么"
const dFail = pure.describeDetection(
  { ok: false, error: 'HTTP 401', hint: 'key 可能不对或没权限', latencyMs: 88, source: '已保存的 key' },
  {}
);
check('★ 检测（失败）：报出错误**并带上下一步建议**（光说"检测失败"等于没说）',
  dFail.text.includes('HTTP 401') && dFail.text.includes('→') && dFail.text.includes('key 可能不对'),
  dFail.text.replace(/\n/g, ' | '));
check('检测（失败）：状态是 error', dFail.state === 'error');
check('检测（失败但没有 hint 时也不崩）',
  pure.describeDetection({ ok: false, error: '连不上' }, {}).state === 'error');

// 接口通了但没返回列表（有些服务不实现 /models）
const dEmpty = pure.describeDetection({ ok: true, models: [], latencyMs: 60 }, { cfgModel: 'qwen2.5' });
check('检测（空列表）：算警告而非错误，并说明可手填',
  dEmpty.state === 'warn' && dEmpty.text.includes('自定义'), dEmpty.text.replace(/\n/g, ' | '));

check('检测：还没有结果时的占位文案', pure.describeDetection(null).text.includes('还没检测'));
check('检测：模型列表里的远程数据不会被当成 HTML（用 textContent 渲染）', (() => {
  const evil = pure.describeDetection({ ok: true, models: ['<img src=x onerror=alert(1)>'] }, {});
  return evil.text.includes('<img');   // 原样保留 → app.js 用 textContent 就安全
})());

console.log('');
console.log(failures === 0 ? '=== 渲染层纯函数单测通过 ===' : `=== ${failures} 项失败 ===`);
process.exit(failures === 0 ? 0 : 1);
