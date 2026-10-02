// ComfyUI 出图工具的注册自检（进程内，不需要 spawn 子进程）。
//
// 为什么不用 MCP client 起 stdio server 来回验证：受限环境下 Node 以管道 spawn
// 子进程会 EPERM。这里直接对 registerComfyTools 传入一个记录型假 server，
// 验证的是同一段注册代码与同一份参数 schema，且顺带覆盖工作流构造与路径围栏。
//
// 用法：node scripts/test-comfy-tools.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  registerComfyTools,
  resolveComfyConfig,
  resolveModelPreset,
  resolveCharacterLora,
  buildTxt2ImgWorkflow,
  normalizeDrawOptions,
  resolveOutputPath
} from '../src/comfy-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── 1) 注册面：工具名与必填参数 ─────────────────────────────────────────────
const registered = [];
const fakeServer = {
  tool: (name, description, schema, handler) => {
    registered.push({ name, description, schema, handler });
  }
};

const result = registerComfyTools(fakeServer, {
  root: REPO_ROOT,
  cfg: {},
  agentApi: async () => ({ ok: true })
});

const names = registered.map((t) => t.name);
check('registerComfyTools 返回 registered=true', result.registered === true, JSON.stringify(result));
check('注册了 qq_draw_image', names.includes('qq_draw_image'));
check('注册了 qq_comfy_status', names.includes('qq_comfy_status'));
check('注册了 qq_send_image', names.includes('qq_send_image'));
check('工具数恰好为 3', names.length === 3, names.join(','));

// 回归防线：桥接的 loadConfig() 是"显式挑选字段"构造 cfg 的，曾经漏掉 comfy，
// 导致 /api/socialV2/send-image 里 cfg.comfy?.outputDir 恒为空、围栏直接 403。
// 这里锁住两件事：桥接的 cfg 里必须有 comfy 段；一旦传入 cfg，就不再偷偷重读文件。
const bridgeSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridge.js'), 'utf8');
check('bridge.js 的 loadConfig 暴露了 comfy 段（否则发送端点必 403）',
  /comfy:\s*\{[\s\S]{0,400}file\.comfy/.test(bridgeSrc));
check('bridge.js 的 comfy 段带 outputDir 默认值',
  /comfy:\s*\{[\s\S]{0,300}outputDir/.test(bridgeSrc));

const withEmptyCfg = [];
registerComfyTools({ tool: (n, d, s, h) => withEmptyCfg.push({ name: n, handler: h }) }, {
  root: REPO_ROOT,
  cfg: { comfy: {} },   // 显式给了空的 comfy 段 -> 必须尊重它，不许回读文件
  agentApi: async () => ({ ok: true })
});
check('传入空 comfy 段时仍注册出三个工具', withEmptyCfg.length === 3, String(withEmptyCfg.length));

// 确定性检查：给一个哨兵 host，若实现偷偷回读 config.json，拿到的会是文件里的
// 127.0.0.1:8188 而不是哨兵。这样就不依赖"ComfyUI 此刻是否在运行"。
const sentinelHost = 'http://127.0.0.1:1';
const fromSentinel = resolveComfyConfig(REPO_ROOT, { host: sentinelHost });
check('传入的 comfy 段被直接采用（哨兵 host 生效）',
  fromSentinel.host === sentinelHost, fromSentinel.host);
const fromFile = resolveComfyConfig(REPO_ROOT);
check('不传时才会回读 config.json（拿到的不是哨兵）',
  fromFile.host !== sentinelHost, fromFile.host);
check('传入空 comfy 段时 host 落回内置默认 127.0.0.1:8188',
  resolveComfyConfig(REPO_ROOT, {}).host === 'http://127.0.0.1:8188',
  resolveComfyConfig(REPO_ROOT, {}).host);

const draw = registered.find((t) => t.name === 'qq_draw_image');
const send = registered.find((t) => t.name === 'qq_send_image');
check('qq_draw_image 暴露 prompt 参数', 'prompt' in (draw?.schema ?? {}), JSON.stringify(Object.keys(draw?.schema ?? {})));
check('qq_draw_image 暴露 preview 开关（省上下文）', 'preview' in (draw?.schema ?? {}));
// 该机制已整体移除：画图不再需要会话身份，参数里不应再出现身份校验字段。
check('qq_draw_image 不再要求身份校验字段（该机制已移除）',
  !('key' in (draw?.schema ?? {})) && !('token' in (draw?.schema ?? {})),
  JSON.stringify(Object.keys(draw?.schema ?? {})));
check('qq_send_image 必填含 key/token/path',
  ['key', 'token', 'path'].every((k) => k in (send?.schema ?? {})),
  JSON.stringify(Object.keys(send?.schema ?? {})));
check('qq_draw_image 的 description 提到 qq_send_image（引导两步流程）',
  String(draw?.description ?? '').includes('qq_send_image'));
check('qq_send_image 的 description 说明路径限制',
  String(send?.description ?? '').includes('输出目录'));

// ── 2) 工作流构造：图生图之外的核心节点与连线 ───────────────────────────────
const cfg = resolveComfyConfig(REPO_ROOT);
check('配置默认底模为 anima-turbo', cfg.unet === 'anima-turbo-v1.1.safetensors', cfg.unet);
check('输出围栏目录已配置', Boolean(cfg.outputDir), cfg.outputDir);
check('输出围栏目录与 ComfyUI 实际输出一致',
  path.resolve(cfg.outputDir) === path.resolve('E:\\comfyui\\ComfyUI\\output'),
  cfg.outputDir);

// 真实出图验证（ComfyUI 在线时）：确认 handler 能打通并回传可发送的本地路径。
const liveRes = await draw.handler({ prompt: 'masterpiece, best quality, 1girl, solo, blue hair', seed: 20260924 });
if (liveRes.isError) {
  console.log(`SKIP 真机出图（门禁未放行或 ComfyUI 不可用）：${String(liveRes.content[0].text).slice(0, 100)}`);
} else {
  const meta = JSON.parse(liveRes.content[0].text);
  check('真机出图返回 ok', meta.ok === true);
  check('真机出图耗时记录', typeof meta.elapsedSeconds === 'number', `${meta.elapsedSeconds}s`);
  check('真机出图返回本地路径', typeof meta.path === 'string' && meta.path.length > 0, meta.path);
  check('本地路径落在输出围栏目录内',
    Boolean(meta.path) && path.resolve(meta.path).startsWith(path.resolve(cfg.outputDir)),
    meta.path);
  check('本地路径真实存在', Boolean(meta.path) && fs.existsSync(meta.path));
  check('默认不返回图片内容（省上下文）',
    !liveRes.content.some((c) => c.type === 'image'));
  check('尺寸为 8 的倍数',
    Number(meta.尺寸.split('x')[0]) % 8 === 0 && Number(meta.尺寸.split('x')[1]) % 8 === 0,
    meta.尺寸);

  const previewRes = await draw.handler({ prompt: 'masterpiece, best quality, 1girl', seed: 1, preview: true });
  check('preview=true 时返回图片内容',
    previewRes.content.some((c) => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 100));
}

const opts = normalizeDrawOptions({ prompt: 'test prompt', width: 1000, height: 1023, seed: 42 }, cfg);
check('宽度规整到 8 的倍数', opts.width % 8 === 0, String(opts.width));
check('高度规整到 8 的倍数', opts.height % 8 === 0, String(opts.height));
check('seed 原样保留', opts.seed === 42, String(opts.seed));
check('默认挂上 turbo LoRA', opts.loras.length === 1 && opts.loras[0].name === cfg.lora);

const wf = buildTxt2ImgWorkflow(opts);
check('工作流含 UNETLoader', wf['1']?.class_type === 'UNETLoader');
check('工作流含 CLIPLoader', wf['2']?.class_type === 'CLIPLoader');
check('工作流含 VAELoader', wf['3']?.class_type === 'VAELoader');
check('工作流含 KSampler', wf['7']?.class_type === 'KSampler');
check('工作流含 SaveImage', wf['9']?.class_type === 'SaveImage');
check('KSampler.model 接到 LoRA 链尾', Array.isArray(wf['7']?.inputs?.model) && wf[wf['7'].inputs.model[0]]?.class_type === 'LoraLoaderModelOnly',
  JSON.stringify(wf['7']?.inputs?.model));
check('LoRA 再接回 UNETLoader',
  wf[wf['7'].inputs.model[0]]?.inputs?.model?.[0] === '1',
  JSON.stringify(wf[wf['7'].inputs.model[0]]?.inputs?.model));
check('VAEDecode.samples 接到 KSampler', JSON.stringify(wf['8']?.inputs?.samples) === '["7",0]');
check('SaveImage.images 接到 VAEDecode', JSON.stringify(wf['9']?.inputs?.images) === '["8",0]');
check('正向提示词进入 CLIPTextEncode', wf['4']?.inputs?.text === 'test prompt');

// 不挂 LoRA 时不应产生多余节点
const noLora = buildTxt2ImgWorkflow(normalizeDrawOptions({ prompt: 'x', loras: [] }, cfg));
check('loras=[] 时不生成 LoRA 节点', !Object.values(noLora).some((n) => n.class_type === 'LoraLoaderModelOnly'));
check('loras=[] 时 KSampler 直连 UNETLoader', JSON.stringify(noLora['7']?.inputs?.model) === '["1",0]');

// ── 2b) 多底模：预设解析 + 两族节点链 ──────────────────────────────────────
check('配置暴露多个预设', Object.keys(cfg.models ?? {}).length >= 3, Object.keys(cfg.models ?? {}).join(','));
check('默认预设可解析', Boolean(resolveModelPreset(cfg, {})?.key), resolveModelPreset(cfg, {})?.key);
check('默认预设族为 unet', resolveModelPreset(cfg, {})?.family === 'unet');
check('显式指定预设生效',
  resolveModelPreset(cfg, { model: 'anima-aesthetic' })?.unet === 'anima-aesthetic-v1.1.safetensors',
  resolveModelPreset(cfg, { model: 'anima-aesthetic' })?.unet);
let unknownThrew = false;
try { resolveModelPreset(cfg, { model: '__nope__' }); } catch { unknownThrew = true; }
check('未知预设报错（便于发现拼写错误）', unknownThrew);
check('顶层镜像字段保留（向后兼容旧读取方）', typeof cfg.unet === 'string' && cfg.unet.length > 0, cfg.unet);

// 角色 LoRA 解析（用构造的配置，不依赖真实文件）
const cfgWithChar = {
  ...cfg,
  models: {
    ...cfg.models,
    sdxl: { key: 'sdxl', label: 'SDXL 测试', family: 'checkpoint', ckpt: 'wai.safetensors', steps: 28, cfg: 5.5, scheduler: 'normal', width: 1024, height: 1024, samplerName: 'euler', lora: '', loraStrength: 1, autoLora: true }
  },
  characterLoras: {
    'arona (blue archive)': { lora: 'arona.safetensors', triggers: ['arona'], model: 'sdxl' }
  }
};
const hit = resolveCharacterLora(cfgWithChar, 'masterpiece, arona (blue archive), halo');
check('角色 LoRA 命中', hit?.lora === 'arona.safetensors', JSON.stringify(hit));
check('未命中角色返回 null', resolveCharacterLora(cfgWithChar, 'a random landscape') === null);
check('角色映射指定的底模被自动选中',
  resolveModelPreset(cfgWithChar, { prompt: 'arona (blue archive)' })?.key === 'sdxl',
  resolveModelPreset(cfgWithChar, { prompt: 'arona (blue archive)' })?.key);

// 触发词注入 + 角色 LoRA 挂载
// 注意：若提示词里已经含该触发词，代码会跳过注入（避免 "arona, ..., arona (blue archive)" 重复），
// 所以用「键命中、但触发词尚未出现」的场景来验证注入确实会补进去。
const optsChar = normalizeDrawOptions({ prompt: 'masterpiece, arona (blue archive)' }, cfgWithChar);
check('触发词已在提示词里时不会重复注入',
  !optsChar.positive.startsWith('arona,'), optsChar.positive.slice(0, 60));
check('角色 LoRA 被挂载', optsChar.loras.some((l) => l.name === 'arona.safetensors'), JSON.stringify(optsChar.loras));
check('命中角色时走了 SDXL 预设', optsChar.modelKey === 'sdxl', optsChar.modelKey);
check('SDXL 预设使用自己的步数/CFG', optsChar.steps === 28 && optsChar.cfg === 5.5, `${optsChar.steps}/${optsChar.cfg}`);

const cfgWithCnChar = {
  ...cfgWithChar,
  characterLoras: { '阿罗娜': { lora: 'arona.safetensors', triggers: ['arona (blue archive)', 'blue archive'], model: 'sdxl' } }
};
const optsCn = normalizeDrawOptions({ prompt: 'masterpiece, 1girl, 阿罗娜' }, cfgWithCnChar);
check('触发词缺失时被注入正向提示词',
  optsCn.positive.startsWith('arona (blue archive), blue archive,'),
  optsCn.positive.slice(0, 80));
check('中文角色名也能命中映射',
  optsCn.characterLora?.name === '阿罗娜', JSON.stringify(optsCn.characterLora));

// checkpoint 族工作流结构：CheckpointLoaderSimple 单节点提供 MODEL/CLIP/VAE
const cfgSdxlOnly = { ...cfg, defaultModel: 'sdxl', models: { sdxl: cfgWithChar.models.sdxl }, characterLoras: {} };
const optsSdxl = normalizeDrawOptions({ prompt: 'test' }, cfgSdxlOnly);
const wfSdxl = buildTxt2ImgWorkflow(optsSdxl);
check('checkpoint 族用 CheckpointLoaderSimple', wfSdxl['1']?.class_type === 'CheckpointLoaderSimple');
check('checkpoint 族不再出现 UNETLoader/CLIPLoader/VAELoader',
  !Object.values(wfSdxl).some((n) => ['UNETLoader', 'CLIPLoader', 'VAELoader'].includes(n.class_type)));
check('文本编码器接到 CheckpointLoaderSimple 的 CLIP 输出', JSON.stringify(wfSdxl['4']?.inputs?.clip) === '["1",1]', JSON.stringify(wfSdxl['4']?.inputs?.clip));
check('VAEDecode 接到 CheckpointLoaderSimple 的 VAE 输出', JSON.stringify(wfSdxl['8']?.inputs?.vae) === '["1",2]', JSON.stringify(wfSdxl['8']?.inputs?.vae));
check('KSampler 接到 CheckpointLoaderSimple 的 MODEL 输出', JSON.stringify(wfSdxl['7']?.inputs?.model) === '["1",0]', JSON.stringify(wfSdxl['7']?.inputs?.model));
check('SDXL 预设无自带 LoRA 时不生成 LoRA 节点',
  !Object.values(wfSdxl).some((n) => n.class_type === 'LoraLoader' || n.class_type === 'LoraLoaderModelOnly'));

// checkpoint 族挂 LoRA：必须用 LoraLoader（同时改 model 与 clip），且文本编码接在 LoRA 之后
const cfgSdxlLora = {
  ...cfg,
  defaultModel: 'sdxl',
  models: { sdxl: { ...cfgWithChar.models.sdxl, lora: 'style.safetensors', loraStrength: 0.8 } },
  characterLoras: {}
};
const wfSdxlLora = buildTxt2ImgWorkflow(normalizeDrawOptions({ prompt: 'test' }, cfgSdxlLora));
const loraNode = Object.values(wfSdxlLora).find((n) => n.class_type === 'LoraLoader');
check('checkpoint 族挂 LoRA 用 LoraLoader（能改 CLIP）', Boolean(loraNode), JSON.stringify(Object.values(wfSdxlLora).map((n) => n.class_type)));
check('checkpoint 族的 LoRA 同时接收 model 与 clip',
  JSON.stringify(loraNode?.inputs?.model) === '["1",0]' && JSON.stringify(loraNode?.inputs?.clip) === '["1",1]',
  JSON.stringify(loraNode?.inputs));
check('checkpoint 族文本编码接在 LoRA 的 CLIP 输出之后',
  JSON.stringify(wfSdxlLora['4']?.inputs?.clip) === JSON.stringify([String(loraNode ? Object.keys(wfSdxlLora).find((k) => wfSdxlLora[k] === loraNode) : ''), 1]),
  JSON.stringify(wfSdxlLora['4']?.inputs?.clip));

// unet 族仍用 LoraLoaderModelOnly
const wfUnetLora = buildTxt2ImgWorkflow(normalizeDrawOptions({ prompt: 'test' }, resolveComfyConfig(REPO_ROOT)));
check('unet 族挂 LoRA 仍用 LoraLoaderModelOnly',
  Object.values(wfUnetLora).some((n) => n.class_type === 'LoraLoaderModelOnly'));

// ── 3) 路径围栏：与桥接 /api/socialV2/send-image 同一套判定语义 ─────────────
const root = path.join(os.tmpdir(), 'comfy-fence-test');
check('output 目录内图片被接受',
  resolveOutputPath(root, { filename: 'a.png' }) !== null);
check('带子目录的输出被接受',
  resolveOutputPath(root, { filename: 'a.png', subfolder: 'sub' }) !== null);
check('向上穿越被拒绝',
  resolveOutputPath(root, { filename: '..\\..\\config.json' }) === null);
check('绝对路径逃逸被拒绝',
  resolveOutputPath(root, { filename: path.join(os.tmpdir(), 'evil.png') }) === null);

// ── 4) 出图工具 handler 的错误路径：ComfyUI 不可达时应报错而不是抛异常 ──────
const badCfgRoot = path.join(os.tmpdir(), 'comfy-badcfg-test');
fs.mkdirSync(badCfgRoot, { recursive: true });
fs.writeFileSync(path.join(badCfgRoot, 'config.json'), JSON.stringify({
  comfy: { host: 'http://127.0.0.1:1', timeoutMs: 12000 }
}), 'utf8');

const badTools = [];
registerComfyTools({ tool: (name, d, s, h) => badTools.push({ name, handler: h }) }, {
  root: badCfgRoot,
  cfg: {}
});
const badStatus = badTools.find((t) => t.name === 'qq_comfy_status');
const statusRes = await badStatus.handler({});
check('ComfyUI 不可达时 qq_comfy_status 正常返回（不抛异常）', Array.isArray(statusRes?.content));
check('不可达时仍能解析出 reachable=false',
  String(statusRes.content[0].text).includes('"reachable": false'),
  String(statusRes.content[0].text).slice(0, 120));

const badDraw = badTools.find((t) => t.name === 'qq_draw_image');
const drawRes = await badDraw.handler({ prompt: 'x' });
check('ComfyUI 不可达时 qq_draw_image 返回 isError', drawRes.isError === true, String(drawRes.content[0].text).slice(0, 80));
check('错误信息提示启动 ComfyUI',
  String(drawRes.content[0].text).includes('ComfyUI'),
  String(drawRes.content[0].text).slice(0, 160));

fs.rmSync(badCfgRoot, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '=== 全部通过 ===' : `=== ${failures} 项失败 ===`}`);
process.exit(failures === 0 ? 0 : 1);
