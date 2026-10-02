// 读取 safetensors 头部的元数据，判断 LoRA 的架构与训练信息。
// safetensors 格式：前 8 字节 = 头部长度（小端 u64），随后是 JSON 头部。
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  files.push(
    'E:\\comfyui\\ComfyUI\\models\\loras\\anima-turbo-lora-v0.2.safetensors',
    'E:\\comfyui\\ComfyUI\\models\\diffusion_models\\anima-turbo-v1.1.safetensors'
  );
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`\n=== ${path.basename(f)} ===\n  文件不存在`); continue; }
  console.log(`\n=== ${path.basename(f)} （${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB）===`);
  const fd = fs.openSync(f, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (headerLen <= 0 || headerLen > 100 * 1024 * 1024) { console.log('  头部长度异常:', headerLen); continue; }
    const headBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headBuf, 0, headerLen, 8);
    const header = JSON.parse(headBuf.toString('utf8'));

    // 元数据（训练框架写入的键值）
    const meta = header.__metadata__ ?? {};
    const metaKeys = Object.keys(meta);
    if (metaKeys.length) {
      console.log('  元数据:');
      for (const k of metaKeys) {
        const v = String(meta[k]);
        console.log(`    ${k} = ${v.length > 120 ? v.slice(0, 120) + '…' : v}`);
      }
    } else {
      console.log('  元数据: （无 __metadata__）');
    }

    // 从张量名推断架构
    const names = Object.keys(header).filter((k) => k !== '__metadata__');
    console.log(`  张量数: ${names.length}`);
    const sample = names.slice(0, 6);
    console.log('  张量名样例:');
    for (const s of sample) console.log(`    ${s}  ${JSON.stringify(header[s].shape)}`);

    const joined = names.join(' ');
    const hints = [];
    if (/double_blocks|single_blocks/.test(joined)) hints.push('Flux 系（double/single blocks）');
    if (/lora_unet_input_blocks|model\.diffusion_model\.input_blocks/.test(joined)) hints.push('SD1.5 系（input_blocks）');
    if (/lora_unet_output_blocks|model\.diffusion_model\.output_blocks/.test(joined)) hints.push('SD1.5 系（output_blocks）');
    if (/transformer_blocks/.test(joined) && /joint_blocks|text_projection/.test(joined)) hints.push('可能为 SDXL/DiT 系（transformer_blocks）');
    if (/text_encoders|conditioner/.test(joined)) hints.push('含文本编码器权重');
    if (/qwen|qwen2|qwen3/i.test(joined + JSON.stringify(meta))) hints.push('含 Qwen 相关命名');
    console.log('  架构线索: ' + (hints.length ? hints.join(' | ') : '无明确特征'));
  } catch (e) {
    console.log('  读取失败:', e.message);
  } finally {
    fs.closeSync(fd);
  }
}
