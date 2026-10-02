// 验证：桥接构造的 image 段里的 base64 是否与源文件字节完全一致。
// 大字符串拼接（'base64://' + buf.toString('base64')）在某些实现下会截断/损坏，
// 这里逐项校验：长度、前缀、解码后 MD5、以及前 16 字节的 PNG 签名。
import fs from 'node:fs';
import crypto from 'node:crypto';

const img = 'E:\\comfyui\\ComfyUI\\output\\QQ_draw_00021_.png';
const buf = fs.readFileSync(img);

// 与 bridge.js 第 4062 行完全相同的构造方式
const segment = { type: 'image', data: { file: 'base64://' + buf.toString('base64') } };
const encoded = segment.data.file;

console.log('源文件           :', img);
console.log('源文件字节       :', buf.length);
console.log('源文件 MD5       :', crypto.createHash('md5').update(buf).digest('hex'));
console.log('');
console.log('段内字符串总长   :', encoded.length, '（预期 = 9 + ceil(n/3)*4 =', 9 + Math.ceil(buf.length / 3) * 4, '）');
console.log('前缀正确         :', encoded.startsWith('base64://'));
const payload = encoded.slice('base64://'.length);
console.log('payload 长度     :', payload.length);
console.log('payload 是否合法 base64:', /^[A-Za-z0-9+/]*={0,2}$/.test(payload) && payload.length % 4 === 0);

const decoded = Buffer.from(payload, 'base64');
console.log('解码回字节       :', decoded.length, decoded.length === buf.length ? '（与源一致 ✓）' : '（不一致 ✗ 被截断/损坏）');
console.log('解码后 MD5       :', crypto.createHash('md5').update(decoded).digest('hex'));
console.log('前 8 字节         :', [...decoded.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('PNG 签名正确     :', decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47);

// 关键：检查 JSON 序列化再解析后是否仍然一致（HTTP body 走的就是 JSON.stringify）
const roundTrip = JSON.parse(JSON.stringify(segment));
const rtPayload = roundTrip.data.file.slice('base64://'.length);
const rtDecoded = Buffer.from(rtPayload, 'base64');
console.log('');
console.log('JSON 往返后长度  :', rtDecoded.length, rtDecoded.length === buf.length ? '（一致 ✓）' : '（不一致 ✗）');
console.log('JSON 往返后 MD5  :', crypto.createHash('md5').update(rtDecoded).digest('hex'));

// 检查 body 尺寸与桥接 readBody 的限制
const body = JSON.stringify({ group_id: 837315958, message: [segment] });
console.log('');
console.log('整个 HTTP body   :', (body.length / 1024 / 1024).toFixed(2), 'MB');
console.log('桥接 readBody 上限: 1.00 MB  ← 注意这是收到的请求，不是发出的');
