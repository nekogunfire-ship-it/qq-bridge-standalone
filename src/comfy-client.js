// ComfyUI 出图客户端 + MCP 工具注册（QQ 桥接 → ComfyUI 文生图）。
//
// 链路：
//   QQ 群友发消息 → DSH agent 调用 mcp__snowluma__qq_draw_image
//     → 本模块用 ComfyUI HTTP API 出图（/prompt → /history → /view）
//     → 图片落到 ComfyUI 的 output 目录，路径回给 agent
//   agent 再调用 mcp__snowluma__qq_send_image(key, token, path, caption)
//     → 桥接的 /api/socialV2/send-image 端点（本模块之外）做发送护栏与回发 QQ
//
// 设计约束：
// - 出图工具**只出图不发送**，发送走桥接端点，这样频率限制/白名单/静默模式/
//   agent token 校验全部复用桥接已有逻辑，不会绕过安全边界。
// - ComfyUI 仅监听 127.0.0.1，本模块也只请求回环地址；不代理任意 URL。
// - 出图是纯计算，不暴露本机文件内容；返回给 agent 的只有 output 目录内的绝对路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// 报错文本会作为工具结果进 agent 会话，截断走 safeSlice（避免孤立代理项打挂会话，
// 见 docs/incident-2026-09-25-lone-surrogate-400.md）
import { safeSlice } from './text-safety.js';

// ── 默认参数（可用 config.json 的 comfy 段覆盖）─────────────────────────────
// 这里刻意对齐 E:\comfyui 里现成的 Anima 工作流：flux 系单文件底模 +
// qwen 文本编码器 + qwen_image VAE，全部是 ComfyUI 原生节点，无需任何自定义节点。
const DEFAULT_HOST = 'http://127.0.0.1:8188';
const DEFAULT_UNET = 'anima-turbo-v1.1.safetensors';
const DEFAULT_CLIP = 'qwen_3_06b_base.safetensors';
const DEFAULT_CLIP_TYPE = 'stable_diffusion';
const DEFAULT_VAE = 'qwen_image_vae.safetensors';
const DEFAULT_LORA = 'anima-turbo-lora-v0.2.safetensors';
const DEFAULT_STEPS = 10;
const DEFAULT_CFG = 1.0;
// SDXL 系（Illustrious/NoobAI/Pony）的常规采样参数，与 turbo 加速模型差异很大。
const DEFAULT_SDXL_STEPS = 28;
const DEFAULT_SDXL_CFG = 5.5;
// 旧式扁平配置（顶层直接写 unet/vae…）会被包装成这个预设键。
const LEGACY_MODEL_KEY = 'default';
const DEFAULT_SIZE = 1024;
const MIN_SIZE = 256;
const MAX_SIZE = 1536;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 720000;
const POLL_INTERVAL_MS = 1200;
// 单张图上限：防止把超大图 base64 塞满 QQ 消息 / 模型上下文。
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// 出图尺寸必须是 8 的倍数，否则 EmptyLatentImage 会报错。
function snapSize(value, fallback = DEFAULT_SIZE) {
  const i = clampInt(value, MIN_SIZE, MAX_SIZE, fallback);
  return i - (i % 8);
}

// ── 配置读取 ────────────────────────────────────────────────────────────────
// 返回 null 表示「文件缺失或解析失败」，与「字段不存在」一样按未启用处理。
// 需要区分「没有这一段」和「有一段空配置」时用 readBridgeConfigRaw。
function loadBridgeConfig(root) {
  return readBridgeConfigRaw(root) ?? {};
}

function readBridgeConfigRaw(root) {
  try {
    let text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// 把 config.json 的 comfy 段规范化成出图默认值。
// cfgRaw 复用调用方已经读好的配置段（例如桥接 loadConfig 的结果），避免
// 「测试传 {} -> 自己重读文件 -> 通过；线上走 cfg -> 却是空」这种不一致。
// token 一律读 QQ 桥接自己的 config.json，不接受 agent 传入，避免被群友诱导改配置。
//
// 多底模：cfg 支持 models 预设表。每个预设自带整套加载链，因为不同底模族
// 的节点完全不同（不能只换文件名）：
//   family: 'unet'       Anima/Qwen 系 —— UNETLoader + CLIPLoader + VAELoader 三个文件分开
//   family: 'checkpoint' SDXL 系（Illustrious/NoobAI/Pony）—— CheckpointLoaderSimple 单文件全含
export function resolveComfyConfig(root, cfgRaw = undefined) {
  const raw = cfgRaw ?? loadBridgeConfig(root)?.comfy ?? {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  // 预设表：把内置默认预设与配置里的 models 合并（配置优先）。
  const presets = {};
  for (const [key, def] of Object.entries(BUILTIN_MODEL_PRESETS)) presets[key] = { ...def };
  for (const [key, def] of Object.entries(raw.models ?? {})) {
    if (!def || typeof def !== 'object') continue;
    presets[key] = { ...(presets[key] ?? {}), ...def, key };
  }
  for (const [key, def] of Object.entries(presets)) {
    presets[key] = normalizePreset(key, def, raw, num);
  }

  // 旧式扁平配置（没有 models 段）也要能跑：把顶层字段当作默认预设。
  const hasLegacyFlat = !raw.models || Object.keys(raw.models).length === 0;
  if (hasLegacyFlat) {
    presets[LEGACY_MODEL_KEY] = normalizePreset(LEGACY_MODEL_KEY, {
      label: '默认底模',
      family: raw.unet ? 'unet' : 'unet',
      unet: raw.unet, clip: raw.clip, clipType: raw.clipType, vae: raw.vae,
      lora: raw.lora, loraStrength: raw.loraStrength,
      steps: raw.steps, cfg: raw.cfg, samplerName: raw.samplerName, scheduler: raw.scheduler
    }, raw, num);
  }

  const defaultModel = String(raw.defaultModel || '').trim()
    || (presets[LEGACY_MODEL_KEY] ? LEGACY_MODEL_KEY : '')
    || Object.keys(presets)[0]
    || LEGACY_MODEL_KEY;

  return {
    enabled: raw.enabled !== false,
    host: String(raw.host || DEFAULT_HOST).replace(/\/+$/, ''),
    // 输出围栏目录：qq_send_image 只允许发送这个目录内的图片。
    outputDir: String(raw.outputDir || '').trim(),
    defaultModel,
    models: presets,
    // 角色 → LoRA 映射（可选）：{"arona (blue archive)": {lora, triggers, model}}
    characterLoras: raw.characterLoras && typeof raw.characterLoras === 'object' ? raw.characterLoras : {},
    // 旧字段保留在顶层，便于旧调用方/旧测试读取（取默认预设的值）。
    ...legacyMirror(presets[defaultModel]),
    autoLora: raw.autoLora !== false,
    defaultWidth: snapSize(raw.defaultWidth, DEFAULT_SIZE),
    defaultHeight: snapSize(raw.defaultHeight, DEFAULT_SIZE),
    timeoutMs: clampInt(raw.timeoutMs, 10000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    previewDefault: raw.previewDefault === true,
    outputPrefix: String(raw.outputPrefix || 'QQ_draw')
  };
}

// 把默认预设的关键字段镜像到顶层，兼容旧字段名的读取方与旧测试。
function legacyMirror(preset) {
  if (!preset) return {};
  return {
    unet: preset.unet,
    clip: preset.clip,
    clipType: preset.clipType,
    vae: preset.vae,
    lora: preset.lora,
    loraStrength: preset.loraStrength,
    steps: preset.steps,
    cfg: preset.cfg,
    samplerName: preset.samplerName,
    scheduler: preset.scheduler
  };
}

// 单个预设的规范化：补齐族相关字段与采样默认值。
function normalizePreset(key, def, raw, num) {
  const family = def.family === 'checkpoint' ? 'checkpoint' : 'unet';
  const common = {
    key,
    label: String(def.label || key),
    family,
    steps: clampInt(def.steps ?? raw.steps, 1, 60, family === 'checkpoint' ? DEFAULT_SDXL_STEPS : DEFAULT_STEPS),
    cfg: num(def.cfg ?? raw.cfg, family === 'checkpoint' ? DEFAULT_SDXL_CFG : DEFAULT_CFG),
    samplerName: String(def.samplerName || raw.samplerName || 'euler'),
    scheduler: String(def.scheduler || raw.scheduler || (family === 'checkpoint' ? 'normal' : 'simple')),
    width: snapSize(def.width, DEFAULT_SIZE),
    height: snapSize(def.height, DEFAULT_SIZE),
    lora: def.lora != null ? String(def.lora) : '',
    loraStrength: num(def.loraStrength, 1.0),
    autoLora: def.autoLora !== false
  };
  if (family === 'checkpoint') {
    return { ...common, ckpt: String(def.ckpt || def.checkpoint || ''), vae: def.vae ? String(def.vae) : '' };
  }
  return {
    ...common,
    unet: String(def.unet || DEFAULT_UNET),
    clip: String(def.clip || DEFAULT_CLIP),
    clipType: String(def.clipType || DEFAULT_CLIP_TYPE),
    vae: String(def.vae || DEFAULT_VAE)
  };
}

// 内置预设：Anima 三兄弟开箱即用；SDXL 系的预设等用户放入底模后取消注释即可。
const BUILTIN_MODEL_PRESETS = {
  'anima-turbo': {
    label: 'Anima Turbo（快，约 10 步）',
    family: 'unet',
    unet: 'anima-turbo-v1.1.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    clipType: 'stable_diffusion',
    vae: 'qwen_image_vae.safetensors',
    lora: 'anima-turbo-lora-v0.2.safetensors',
    loraStrength: 1.0,
    steps: 10,
    cfg: 1.0,
    scheduler: 'simple'
  },
  'anima-aesthetic': {
    label: 'Anima Aesthetic（画质优先，更慢）',
    family: 'unet',
    unet: 'anima-aesthetic-v1.1.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    clipType: 'stable_diffusion',
    vae: 'qwen_image_vae.safetensors',
    lora: '',
    steps: 20,
    cfg: 1.0,
    scheduler: 'simple'
  },
  'anima-base': {
    label: 'Anima Base（原版底模）',
    family: 'unet',
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    clipType: 'stable_diffusion',
    vae: 'qwen_image_vae.safetensors',
    lora: '',
    steps: 20,
    cfg: 1.0,
    scheduler: 'simple'
  }
};

// 解析本次请求实际使用的预设：
// 1) 显式传 model 就用它（未知名报错，便于发现拼写问题）
// 2) 命中角色 LoRA 且该条目指定了 model，就用那个模型
// 3) 否则用 defaultModel
export function resolveModelPreset(cfg, { model, prompt } = {}) {
  const wanted = String(model ?? '').trim();
  if (wanted) {
    const p = cfg.models?.[wanted];
    if (!p) {
      const known = Object.keys(cfg.models ?? {}).join(', ');
      throw new Error(`未知的底模预设「${wanted}」。可用：${known || '(无)'}`);
    }
    return p;
  }
  // 角色命中：提示词里出现映射条目的键或触发词时，采纳该条目指定的 model。
  const text = String(prompt ?? '').toLowerCase();
  for (const [name, entry] of Object.entries(cfg.characterLoras ?? {})) {
    if (!entry || typeof entry !== 'object' || !entry.model) continue;
    const needles = [name, ...(Array.isArray(entry.triggers) ? entry.triggers : [])]
      .map((s) => String(s).toLowerCase().trim())
      .filter(Boolean);
    if (needles.some((n) => text.includes(n)) && cfg.models?.[entry.model]) {
      return cfg.models[entry.model];
    }
  }
  return cfg.models?.[cfg.defaultModel] ?? Object.values(cfg.models ?? {})[0] ?? null;
}

// 角色命中时返回要额外挂载的 LoRA 与触发词。
export function resolveCharacterLora(cfg, prompt) {
  const text = String(prompt ?? '').toLowerCase();
  for (const [name, entry] of Object.entries(cfg.characterLoras ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const needles = [name, ...(Array.isArray(entry.triggers) ? entry.triggers : [])]
      .map((s) => String(s).toLowerCase().trim())
      .filter(Boolean);
    if (!needles.length) continue;
    if (needles.some((n) => text.includes(n))) {
      return {
        name,
        lora: entry.lora ? String(entry.lora) : '',
        strength: Number.isFinite(Number(entry.strength)) ? Number(entry.strength) : 1.0,
        triggers: Array.isArray(entry.triggers) ? entry.triggers.map(String) : []
      };
    }
  }
  return null;
}

// ── ComfyUI HTTP 客户端 ─────────────────────────────────────────────────────
async function comfyFetch(host, pathname, init = {}) {
  let res;
  try {
    res = await fetch(`${host}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20000)
    });
  } catch (error) {
    // 连不上是最常见的失败（用户没开 ComfyUI），给出可操作的中文提示。
    throw new Error(`连不上 ComfyUI（${host}）：${error?.message ?? error}。请确认 ComfyUI 已启动并监听 8188 端口`);
  }
  return res;
}

// 读取出图所需的模型清单，用于启动/自检时校验模型名是否真的存在。
export async function fetchComfyModels(host, timeoutMs = 15000) {
  const readList = async (node, field) => {
    const res = await comfyFetch(host, `/object_info/${node}`, { timeoutMs });
    if (!res.ok) throw new Error(`/object_info/${node} HTTP ${res.status}`);
    const info = await res.json();
    const spec = info?.[node]?.input?.required?.[field]?.[0];
    return Array.isArray(spec) ? spec.map(String) : [];
  };
  const [unets, clips, vaes, loras, checkpoints] = await Promise.all([
    readList('UNETLoader', 'unet_name'),
    readList('CLIPLoader', 'clip_name'),
    readList('VAELoader', 'vae_name'),
    readList('LoraLoaderModelOnly', 'lora_name'),
    // SDXL 系底模放在 checkpoints 目录，用 CheckpointLoaderSimple 加载。
    readList('CheckpointLoaderSimple', 'ckpt_name')
  ]);
  return { unets, clips, vaes, loras, checkpoints };
}

export async function comfyReachable(host, timeoutMs = 5000) {
  try {
    const res = await comfyFetch(host, '/system_stats', { timeoutMs });
    if (!res.ok) return { reachable: false, httpStatus: res.status };
    const body = await res.json();
    const device = Array.isArray(body?.devices) ? body.devices[0] : null;
    return {
      reachable: true,
      comfyuiVersion: body?.system?.comfyui_version ?? null,
      device: device?.name ?? null,
      vramTotalGb: device?.vram_total ? Number((device.vram_total / 1073741824).toFixed(1)) : null
    };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

// 构造 txt2img 工作流（API 格式）。节点 id 用字符串常量，便于测试断言。
//
// 两族加载链（由 opts.family 决定，默认 unet 以保持向后兼容）：
//   unet       —— UNETLoader(1) + CLIPLoader(2) + VAELoader(3)，三文件分开
//   checkpoint —— CheckpointLoaderSimple(1)，一个文件同时提供 MODEL/CLIP/VAE
// CLIPTextEncode 固定用节点 4/5，KSampler 固定节点 7，VAEDecode 固定 8，SaveImage 固定 9。
export function buildTxt2ImgWorkflow(opts) {
  const {
    family = 'unet', ckpt, unet, clip, clipType, vae, positive, negative,
    width, height, steps, cfg, seed, samplerName, scheduler,
    loras = []
  } = opts;

  const wf = {};
  let clipRef;
  let vaeRef;
  let modelRef;

  if (family === 'checkpoint') {
    if (!ckpt) throw new Error('checkpoint 系预设缺少 ckpt 文件名');
    // CheckpointLoaderSimple 输出：0=MODEL, 1=CLIP, 2=VAE
    wf[1] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } };
    modelRef = ['1', 0];
    clipRef = ['1', 1];
    vaeRef = ['1', 2];
  } else {
    wf[1] = { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } };
    wf[2] = { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType, device: 'default' } };
    wf[3] = { class_type: 'VAELoader', inputs: { vae_name: vae } };
    modelRef = ['1', 0];
    clipRef = ['2', 0];
    vaeRef = ['3', 0];
  }

  wf[4] = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: clipRef } };
  wf[5] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: clipRef } };
  wf[6] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  wf[8] = { class_type: 'VAEDecode', inputs: { vae: vaeRef } };
  wf[9] = { class_type: 'SaveImage', inputs: { filename_prefix: opts.outputPrefix, images: ['8', 0] } };

  // LoRA 链：接到 KSampler.model。checkpoint 系用 LoraLoader（同时改 CLIP），
  // unet 系用 LoraLoaderModelOnly（只有底模可改）。
  let nextId = 100;
  for (const lora of loras) {
    if (!lora?.name) continue;
    const id = String(nextId++);
    if (family === 'checkpoint') {
      wf[id] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strength,
          strength_clip: lora.strength,
          model: modelRef,
          clip: clipRef
        }
      };
      modelRef = [id, 0];
      clipRef = [id, 1];
      // LoRA 改动了 CLIP 后，文本编码必须接在它后面（但文本节点在 LoRA 之前创建，
      // 这里回填引用；ComfyUI 按依赖顺序执行，与字面顺序无关）。
      wf[4].inputs.clip = clipRef;
      wf[5].inputs.clip = clipRef;
    } else {
      wf[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: lora.name, strength_model: lora.strength, model: modelRef }
      };
      modelRef = [id, 0];
    }
  }

  wf[7] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: samplerName,
      scheduler,
      denoise: 1.0,
      model: modelRef,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0]
    }
  };
  // VAEDecode 接 KSampler 的输出
  wf[8].inputs.samples = ['7', 0];
  return wf;
}

// 提交工作流并等待执行结果，返回 { promptId, images:[{filename,subfolder,type}], elapsedMs }。
export async function runComfyWorkflow(host, workflow, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const clientId = `qq-bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const submitRes = await comfyFetch(host, '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    timeoutMs: 30000
  });
  const submitBody = await submitRes.json().catch(() => ({}));
  if (!submitRes.ok) {
    // ComfyUI 的校验失败信息在 error.message / node_errors 里，尽量原样带出去便于排查。
    const detail = submitBody?.error?.message
      ? `${submitBody.error.message}${submitBody?.node_errors ? ` ${safeSlice(JSON.stringify(submitBody.node_errors), 500)}` : ''}`
      : `HTTP ${submitRes.status}`;
    throw new Error(`ComfyUI 拒绝工作流：${detail}`);
  }
  const promptId = submitBody?.prompt_id;
  if (!promptId) throw new Error('ComfyUI 未返回 prompt_id，工作流可能未入队');

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const histRes = await comfyFetch(host, `/history/${encodeURIComponent(promptId)}`, { timeoutMs: 20000 });
    if (histRes.ok) {
      const hist = await histRes.json().catch(() => ({}));
      const entry = hist?.[promptId];
      if (entry) {
        const status = entry.status ?? {};
        lastStatus = status;
        if (status.status_str === 'success') {
          const images = [];
          for (const nodeOutput of Object.values(entry.outputs ?? {})) {
            for (const img of nodeOutput?.images ?? []) {
              if (img?.filename) {
                images.push({
                  filename: String(img.filename),
                  subfolder: String(img.subfolder ?? ''),
                  type: String(img.type ?? 'output')
                });
              }
            }
          }
          if (!images.length) throw new Error('ComfyUI 执行成功但没有产出图片');
          return { promptId, images, elapsedMs: Date.now() - startedAt };
        }
        if (status.status_str === 'error') {
          throw new Error(`ComfyUI 执行失败：${safeSlice(JSON.stringify(status), 600)}`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`ComfyUI 出图超时（${Math.round(timeoutMs / 1000)} 秒未完成）${lastStatus ? ` 最后状态：${safeSlice(JSON.stringify(lastStatus), 300)}` : ''}`);
}

// 取出图字节。ComfyUI 的 /view 只按 filename/subfolder/type 查自己的输出目录，不读任意路径。
export async function fetchComfyImage(host, { filename, subfolder = '', type = 'output' }, timeoutMs = 60000) {
  const q = new URLSearchParams({ filename, subfolder, type });
  const res = await comfyFetch(host, `/view?${q.toString()}`, { timeoutMs });
  if (!res.ok) throw new Error(`取图失败 /view HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('取图失败：ComfyUI 返回空内容');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB > ${MAX_IMAGE_BYTES / 1048576}MB）`);
  const mimeType = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return { buffer: buf, mimeType };
}

// 默认负面提示词：Anima 系推荐的去劣化标签。
const DEFAULT_NEGATIVE = 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration, watermark, signature, text';
// SDXL 系（Illustrious/NoobAI/Pony）通用的去劣化标签，用较短的通用集。
const DEFAULT_NEGATIVE_SDXL = 'worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, watermark, signature, text, username, jpeg artifacts';

// 出图参数规范化：把 MCP 入参 + 预设 + 角色 LoRA 合成为可直接提交的工作流参数。
//
// 预设解析优先级见 resolveModelPreset；角色 LoRA 命中时会追加对应 LoRA 与触发词。
export function normalizeDrawOptions(input, cfg) {
  const preset = resolveModelPreset(cfg, { model: input.model, prompt: input.prompt });
  if (!preset) throw new Error('没有可用的底模预设，请检查 config.json 的 comfy.models');

  const family = preset.family === 'checkpoint' ? 'checkpoint' : 'unet';
  const baseNegative = input.negativePrompt
    ?? (family === 'checkpoint' ? DEFAULT_NEGATIVE_SDXL : DEFAULT_NEGATIVE);

  // 角色 LoRA：命中则把触发词补进正向提示词（角色 LoRA 通常靠触发词生效）。
  const character = resolveCharacterLora(cfg, input.prompt);
  let positive = String(input.prompt ?? '').trim();
  if (character?.triggers?.length) {
    const missing = character.triggers.filter((t) => t && !positive.toLowerCase().includes(String(t).toLowerCase()));
    if (missing.length) positive = `${missing.join(', ')}, ${positive}`;
  }

  const loras = [];
  const pushLora = (name, strength) => {
    if (!name) return;
    if (loras.some((l) => l.name === name)) return; // 去重，避免同一 LoRA 挂两次
    loras.push({ name: String(name), strength: Number.isFinite(Number(strength)) ? Number(strength) : 1.0 });
  };

  if (Array.isArray(input.loras)) {
    // 显式传入的 loras 完全接管（传 [] 表示什么都不挂）。
    for (const l of input.loras) pushLora(l?.name, l?.strength);
  } else {
    if (character?.lora) pushLora(character.lora, character.strength);
    // 预设自带的 LoRA（如 turbo 加速）按 autoLora 决定是否挂。
    const presetAutoLora = preset.autoLora !== false && cfg.autoLora !== false;
    if (presetAutoLora && preset.lora) pushLora(preset.lora, preset.loraStrength);
  }

  const seed = Number.isFinite(Number(input.seed))
    ? Math.max(0, Math.floor(Number(input.seed)))
    : Math.floor(Math.random() * 2147483647);

  return {
    family,
    modelKey: preset.key,
    modelLabel: preset.label,
    // unet 系字段
    unet: preset.unet,
    clip: preset.clip,
    clipType: preset.clipType,
    // checkpoint 系字段
    ckpt: preset.ckpt,
    vae: preset.vae,
    positive,
    negative: String(baseNegative).trim(),
    width: snapSize(input.width, preset.width || cfg.defaultWidth),
    height: snapSize(input.height, preset.height || cfg.defaultHeight),
    steps: clampInt(input.steps, 1, 60, preset.steps),
    cfg: Number.isFinite(Number(input.cfg)) ? Number(input.cfg) : preset.cfg,
    seed,
    samplerName: preset.samplerName,
    scheduler: preset.scheduler,
    loras,
    characterLora: character ? { name: character.name, lora: character.lora, triggers: character.triggers } : null,
    outputPrefix: cfg.outputPrefix
  };
}

// 把 ComfyUI 输出定位成磁盘路径（仅用于「路径是否在 output 目录内」的展示与校验，
// 真正读文件的是桥接端点，且它会重新做一次围栏校验）。
export function resolveOutputPath(outputRoot, { filename, subfolder = '' }) {
  const root = path.resolve(outputRoot);
  const target = path.resolve(root, subfolder, filename);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

// 「出图」的一次完整调用：规范化参数 → 提交 → 等待 → 取图。
// 返回 { options, promptId, elapsedMs, image:{buffer,mimeType}, localPath }。
export async function generateImage(root, input, cfg) {
  const options = normalizeDrawOptions(input, cfg);
  if (!options.positive) throw new Error('prompt 不能为空');
  const workflow = buildTxt2ImgWorkflow({ ...options, outputPrefix: cfg.outputPrefix });
  const run = await runComfyWorkflow(cfg.host, workflow, { timeoutMs: cfg.timeoutMs });
  const first = run.images[0];
  const image = await fetchComfyImage(cfg.host, first);
  const localPath = cfg.outputDir ? resolveOutputPath(cfg.outputDir, first) : null;
  return {
    options,
    promptId: run.promptId,
    elapsedMs: run.elapsedMs,
    imageCount: run.images.length,
    image,
    comfyImage: first,
    localPath
  };
}

// ── MCP 工具注册 ────────────────────────────────────────────────────────────
// 挂在 mcp__snowluma__ 命名空间下：QQ agent preset 的工具白名单是按前缀放行的，
// 新开一个 MCP server 反而要改白名单 + 重启 DSH 才能生效。
export function registerComfyTools(server, { root, cfg, agentApi }) {
  // 优先用调用方（MCP server 的 loadConfig）已读好的 comfy 段；它没给才自行读盘。
  // 这样"配置是否真的被读进来"在测试里也能暴露，不会被静默重读掩盖。
  const comfy = resolveComfyConfig(root, cfg?.comfy);
  if (!comfy.enabled) return { registered: false, reason: 'config.json 的 comfy.enabled=false' };

  server.tool(
    'qq_draw_image',
    '用本地 ComfyUI 画一张图（文生图），返回图片在服务器上的路径。这是"画图"动作本身，不会发到 QQ；画完想发出去，再调用 qq_send_image 并附一句配文。'
      + '提示词用英文 Danbooru 风格标签串效果最好（例如 "masterpiece, best quality, 1girl, solo, blue hair, looking at viewer"）；'
      + '如果群友用中文描述，请先自己翻译成标签再传。出图是本地 GPU 计算，和上网/聊天无关。'
      + '【画指定角色】用 Danbooru 的角色标签格式 `角色名 (作品名), 作品名`，例如 `arona (blue archive), blue archive`、'
      + '`kiana kaslana, honkai impact 3rd`、`hatsune miku, vocaloid`；中文名先翻成官方英文名，拿不准可用 web 搜索查"角色英文名 + danbooru"。'
      + '这个底模对 ACG 角色知识很扎实，请不要断言"模型认不出某角色"或"只能画原创版"——那通常只是提示词写法问题。',
    {
      prompt: z.string().describe('正向提示词：英文 Danbooru 风格标签，用逗号分隔；指定角色时用「角色名 (作品名), 作品名」格式'),
      negativePrompt: z.string().optional().describe('负面提示词，不传则用默认去劣化标签'),
      width: z.number().optional().describe('宽，默认取配置值（通常 1024）；会被规整到 8 的倍数，范围 256~1536'),
      height: z.number().optional().describe('高，默认取配置值（通常 1024）；会被规整到 8 的倍数，范围 256~1536'),
      steps: z.number().optional().describe('采样步数，默认取配置值（turbo 底模通常 10 步，越多越慢）'),
      cfg: z.number().optional().describe('CFG 强度，默认取配置值（turbo 底模通常是 1.0）'),
      seed: z.number().optional().describe('随机种子；同一个 prompt + 同 seed 可复现同一张图'),
      preview: z.boolean().optional().describe('是否把生成结果作为图片返回，让你自己看一眼。默认 false 省上下文；画指定角色/复杂构图/不确定效果时设 true，你能亲眼确认再决定发不发'),
      model: z.string().optional().describe('用哪个底模预设（见 qq_comfy_status 的「可用预设」）。不传则用默认预设；指定角色且该角色配了 LoRA 时会自动切到对应底模'),
      loras: z.array(z.object({ name: z.string(), strength: z.number().optional() })).optional().describe('可选 LoRA 列表；传 [] 表示不挂任何 LoRA。不传则用预设自带 LoRA + 角色 LoRA')
    },
    async ({ prompt, negativePrompt, width, height, steps, cfg: cfgOverride, seed, preview, model, loras }) => {
      try {
        const wantPreview = preview === true || (preview === undefined && comfy.previewDefault);
        const result = await generateImage(root, {
          prompt, negativePrompt, width, height, steps, cfg: cfgOverride, seed, model, loras
        }, comfy);
        const meta = {
          ok: true,
          promptId: result.promptId,
          elapsedSeconds: Number((result.elapsedMs / 1000).toFixed(1)),
          底模: result.options.modelLabel ?? result.options.modelKey,
          族: result.options.family,
          尺寸: `${result.options.width}x${result.options.height}`,
          seed: result.options.seed,
          steps: result.options.steps,
          cfg: result.options.cfg,
          loras: result.options.loras.map((l) => l.name),
          ...(result.options.characterLora ? { 命中角色: result.options.characterLora.name } : {}),
          path: result.localPath,
          comfyFile: result.comfyImage,
          note: result.localPath
            ? '图片已生成。要发到当前 QQ 会话，请调用 qq_send_image 并把上面的 path 原样传入；不要自己拼路径。'
            : '图片已生成，但 config.json 未配置 comfy.outputDir，无法给出本地路径；请让管理员配置后再试。'
        };
        const content = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];
        if (wantPreview) {
          content.push({ type: 'image', mimeType: result.image.mimeType, data: result.image.buffer.toString('base64') });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `画图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_comfy_status',
    '检查本地 ComfyUI 是否可用：是否在线、显卡、可用底模预设与 LoRA 清单、以及每个预设的模型文件是否真的存在。画图失败、想确认模型名、或想知道「有哪些底模可以切换」时用它。',
    {},
    async () => {
      try {
        const info = await comfyReachable(comfy.host);
        const payload = { host: comfy.host, ...info };
        // 预设清单不依赖 ComfyUI 在线，先给出来。
        payload.默认预设 = comfy.defaultModel;
        payload.可用预设 = Object.values(comfy.models ?? {}).map((p) => ({
          名称: p.key,
          说明: p.label,
          族: p.family,
          底模: p.family === 'checkpoint' ? p.ckpt : p.unet,
          步数: p.steps,
          CFG: p.cfg,
          自带LoRA: p.lora || null
        }));
        const charLoras = Object.entries(comfy.characterLoras ?? {});
        if (charLoras.length) {
          payload.角色LoRA映射 = charLoras.map(([name, e]) => ({
            角色: name,
            LoRA: e?.lora ?? null,
            触发词: Array.isArray(e?.triggers) ? e.triggers : [],
            指定底模: e?.model ?? null
          }));
        }
        if (info.reachable) {
          try {
            const models = await fetchComfyModels(comfy.host);
            payload.ComfyUI可用文件 = {
              checkpoints: models.checkpoints,
              diffusion_models: models.unets,
              text_encoders: models.clips,
              vae: models.vaes,
              loras: models.loras
            };
            // 逐个预设校验文件是否真的在，免得画图时才发现缺文件。
            const problems = [];
            for (const p of Object.values(comfy.models ?? {})) {
              if (p.family === 'checkpoint') {
                if (!p.ckpt) problems.push(`预设 ${p.key} 未配置 ckpt`);
                else if (!models.checkpoints.includes(p.ckpt)) problems.push(`预设 ${p.key} 的底模 ${p.ckpt} 不在 checkpoints 目录里（需下载后放进 E:\\comfyui\\ComfyUI\\models\\checkpoints）`);
              } else {
                if (p.unet && !models.unets.includes(p.unet)) problems.push(`预设 ${p.key} 的底模 ${p.unet} 不在 diffusion_models 里`);
                if (p.clip && !models.clips.includes(p.clip)) problems.push(`预设 ${p.key} 的文本编码器 ${p.clip} 不在 text_encoders 里`);
                if (p.vae && !models.vaes.includes(p.vae)) problems.push(`预设 ${p.key} 的 VAE ${p.vae} 不在 vae 目录里`);
              }
              if (p.lora && !models.loras.includes(p.lora)) problems.push(`预设 ${p.key} 的 LoRA ${p.lora} 不在 loras 目录里`);
            }
            for (const [name, e] of charLoras) {
              if (e?.lora && !models.loras.includes(e.lora)) problems.push(`角色「${name}」的 LoRA ${e.lora} 不在 loras 目录里`);
            }
            if (problems.length) payload.配置问题 = problems;
          } catch (error) {
            payload.模型清单读取失败 = String(error?.message ?? error);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `检查 ComfyUI 失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_send_image',
    '把一张已经画好的本地图片发到当前 QQ 会话，可附一句话作为同一条消息的配文。只能发送 qq_draw_image 刚生成的图片（路径必须在 ComfyUI 输出目录内），不能发送服务器上任意文件。'
      + '配文要求同 qq_send_message：简短、不要用空格断句。需要引用/点名时可用 replyToMessageId / atUserId。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      path: z.string().describe('图片路径，原样传 qq_draw_image 返回的 path'),
      caption: z.string().optional().describe('随图一起发的一句话（可选）。会显示成"图片 + 文字"的同一条消息'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, path: imagePath, caption, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({
            key,
            path: String(imagePath ?? ''),
            message: caption ?? '',
            replyToMessageId,
            atUserId: atUserId ?? null
          }),
          headers: { 'x-agent-token': token },
          // 图片要先读盘再 base64 上传，给足超时；ComfyUI 侧已出图，这里只是发送。
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  return { registered: true, tools: ['qq_draw_image', 'qq_comfy_status', 'qq_send_image'] };
}

// ── 命令行自检 ──────────────────────────────────────────────────────────────
// 用法：node src/comfy-client.js --prompt "..." [--width N] [--height N] [--out 文件路径]
// 不依赖 DSH / QQ，用于单独验证 ComfyUI 链路。
async function cliMain() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const cfg = resolveComfyConfig(root);
  console.log(`[comfy] host=${cfg.host} unet=${cfg.unet} lora=${cfg.autoLora ? cfg.lora : '(关闭)'}`);
  const status = await comfyReachable(cfg.host);
  console.log('[comfy] 状态:', JSON.stringify(status));
  if (!status.reachable) process.exit(1);

  const prompt = arg('prompt', 'masterpiece, best quality, 1girl, solo, blue hair, ahoge, whale tail, smile, looking at viewer, detailed background');
  console.log(`[comfy] 出图中… prompt=${prompt}`);
  const result = await generateImage(root, {
    prompt,
    width: Number(arg('width', cfg.defaultWidth)),
    height: Number(arg('height', cfg.defaultHeight)),
    steps: Number(arg('steps', cfg.steps)),
    seed: arg('seed') !== null ? Number(arg('seed')) : undefined
  }, cfg);
  console.log(`[comfy] 完成：${(result.elapsedMs / 1000).toFixed(1)}s | ${result.options.width}x${result.options.height} | seed=${result.options.seed} | ${(result.image.buffer.length / 1024).toFixed(0)}KB`);
  console.log(`[comfy] ComfyUI 文件：${JSON.stringify(result.comfyImage)}`);
  console.log(`[comfy] 本地路径：${result.localPath ?? '(未配置 comfy.outputDir)'}`);
  const out = arg('out');
  if (out) {
    fs.writeFileSync(out, result.image.buffer);
    console.log(`[comfy] 已写出：${out}`);
  }
}

// 只有直接执行本文件时才跑 CLI（被 MCP server import 时不跑）。
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  cliMain().catch((error) => {
    console.error('[comfy] 失败:', error?.message ?? error);
    process.exit(1);
  });
}
