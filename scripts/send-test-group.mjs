// 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。
//
// ⚠️ 这个脚本会**真的往群里发消息**，所以默认是 **dry-run**：只连网关、列出群、
// 显示将要发送的目标与内容，不发送。确认无误后再加 --yes 真发。
//
// 用法：
//   node scripts/send-test-group.mjs <群名关键词> [消息内容]            # dry-run（默认）
//   node scripts/send-test-group.mjs <群名关键词> [消息内容] --yes      # 真的发送
//   node scripts/send-test-group.mjs --list                            # 只列出所有群
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const confirmed = argv.includes('--yes');
const listOnly = argv.includes('--list');
const positional = argv.filter((a) => !a.startsWith('--'));

const keyword = positional[0] ?? '机器人测试';
const message = positional[1] ?? '【桥接测试】我是 DSH agent，通过 SnowLuma 桥接接入本群。收到请回复～';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const { wsUrl, accessToken } = cfg.snowluma;

const bot = new SnowLumaWebSocketClient({ url: wsUrl, accessToken: accessToken || undefined, reconnect: false });
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));

try {
  await Promise.race([bot.connect(), timeout]);
  console.log('✅ 已连接网关');

  const groups = await bot.raw('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  console.log(`共 ${list.length} 个群：`, list.map((g) => `${g.group_id}(${g.group_name})`).join('、'));

  if (listOnly) {
    console.log('\n（--list 模式：不发送任何消息）');
    process.exit(0);
  }

  const target = list.find((g) => String(g.group_name ?? '').includes(keyword));
  if (!target) {
    console.error(`❌ 未找到名称包含「${keyword}」的群`);
    process.exit(1);
  }

  // 目标群必须在白名单内 —— 防止手误把测试消息发到无关的群。
  // 与桥接自身的发送约束一致（allow.groups）。
  const allowGroups = (cfg.allow?.groups ?? []).map(String);
  const inAllow = allowGroups.length > 0 && allowGroups.includes(String(target.group_id));
  console.log('');
  console.log(`目标群: ${target.group_id}（${target.group_name}）`);
  console.log(`白名单: ${inAllow ? '✅ 在 allow.groups 内' : `❌ 不在 allow.groups 内（当前: ${allowGroups.join(', ') || '空'}）`}`);
  console.log(`内容  : ${message}`);
  console.log('');

  if (!inAllow) {
    console.error('❌ 拒绝发送：目标群不在 config.json 的 allow.groups 里。');
    console.error('   如果确实要发，先把该群加入白名单（这也是桥接自身的发送约束）。');
    process.exit(1);
  }

  if (!confirmed) {
    console.log('🔍 DRY-RUN：以上是**将要发送**的内容，实际没有发送。');
    console.log('   确认无误后加 --yes 真发：');
    console.log(`   node scripts/send-test-group.mjs "${keyword}" "${message}" --yes`);
    process.exit(0);
  }

  const result = await bot.sendGroupMessage(target.group_id, text(message));
  console.log(`✅ 已发送到群 ${target.group_id}（${target.group_name}）: ${message}`);
  console.log('  响应:', JSON.stringify(result));
} catch (error) {
  console.error('❌ 发送失败:', error?.message ?? error);
  process.exit(1);
} finally {
  try { bot.close(); } catch {}
}
