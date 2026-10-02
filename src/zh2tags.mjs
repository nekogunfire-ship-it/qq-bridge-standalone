// 中文（含口语）→ Danbooru 标签的直通出图翻译层。
//
// 为什么需要它：底模（anima / Qwen 文本编码器）对**英文标签**很准，对整句中文基本是噪音——
// 实测同一意图："completely nude, lying on bed" 出裸体躺床；"一个少女不穿衣服躺在床上"
// 出了一张衣着整齐、构图跑偏的图。所以中文描述必须先落到标签上。
//
// 设计取舍：只做「词典 + 兜底标签」，不引入第二个模型（离线、可解释、可随时改表）。
// 词典按**长词优先**匹配，英文原文原样保留（混合写法也能用）。

const GROUPS = {
  // 人物与人数
  people: {
    '一个少女': '1girl',
    '一个女孩': '1girl',
    '一个男孩': '1boy',
    '一个男生': '1boy',
    '少女': '1girl',
    '女孩': '1girl',
    '女生': '1girl',
    '女人': '1girl',
    '御姐': 'mature female, 1girl',
    '男孩': '1boy',
    '男生': '1boy',
    '男人': '1boy',
    '两个人': '2girls',
    '两个人一起': '2girls',
    '双人': '2girls',
    '猫娘': 'cat girl, cat ears, animal ears',
    '狐娘': 'fox girl, fox ears',
    '鲸鱼娘': 'whale girl, whale tail',
    '兽耳': 'animal ears',
    '罗莉': 'loli',
    '正太': 'shota'
  },
  // 裸露 / 成人向
  nsfw: {
    '不穿衣服': 'completely nude, no clothes',
    '没穿衣服': 'completely nude, no clothes',
    '没穿': 'completely nude',
    '全裸': 'completely nude',
    '裸体': 'completely nude',
    '裸着': 'completely nude',
    '光着身子': 'completely nude',
    '一丝不挂': 'completely nude',
    '赤裸': 'completely nude',
    '露胸': 'nipples, large breasts, exposed breasts',
    '露点': 'nipples',
    '露乳': 'nipples, exposed breasts',
    '露臀': 'ass, exposed buttocks',
    '走光': 'wardrobe malfunction',
    '内衣': 'underwear, lingerie',
    '胸罩': 'bra, lingerie',
    '内裤': 'panties, underwear',
    '丁字裤': 'thong, underwear',
    '比基尼': 'bikini',
    '泳装': 'swimsuit',
    '泳衣': 'swimsuit',
    '丝袜': 'pantyhose, thighhighs',
    '吊带袜': 'garter belt, thighhighs',
    '色情': 'nsfw, explicit',
    '成人向': 'nsfw',
    '性感': 'sexy, seductive',
    '诱惑': 'alluring, seductive',
    '大胸': 'large breasts',
    '巨乳': 'huge breasts',
    '贫乳': 'flat chest, small breasts',
    '自慰': 'masturbation',
    '做爱': 'sex, hetero',
    '口交': 'fellatio',
    '高潮': 'orgasm, ahegao',
    '潮红': 'blush, flushed face',
    '乳头': 'nipples',
    '屁股': 'ass',
    '翘臀': 'ass focus',
    '挑逗': 'teasing, seductive smile'
  },
  // 姿势与动作
  pose: {
    '躺在床上': 'lying on bed, on back',
    '趴在床上': 'on stomach, lying on bed',
    '躺在床上侧卧': 'lying on side, on bed',
    '躺在床上侧身': 'lying on side, on bed',
    '坐在床上': 'sitting on bed',
    '坐在地上': 'sitting on floor',
    '跪着': 'kneeling',
    '蹲着': 'squatting',
    '站着': 'standing',
    '趴着': 'on stomach',
    '躺着': 'lying',
    '侧卧': 'lying on side',
    '坐着': 'sitting',
    '靠着墙': 'against wall',
    '张开腿': 'spread legs',
    '叉开腿': 'spread legs',
    '翘起腿': 'crossed legs',
    '举起手': 'arms up',
    '双手抱胸': 'arms crossed',
    '手放在胸前': 'hands on chest',
    '看着镜头': 'looking at viewer',
    '看镜头': 'looking at viewer',
    '闭眼': 'closed eyes',
    '微笑': 'smile',
    '笑着': 'smiling',
    '大笑': 'laughing, open mouth',
    '坏笑': 'smirk',
    '害羞': 'embarrassed, blush',
    '生气': 'angry',
    '哭泣': 'crying, tears',
    '流泪': 'tears',
    '睡着了': 'sleeping',
    '睡觉': 'sleeping',
    '撩头发': 'hand in hair',
    '掀衣服': 'clothes lift, shirt lift',
    '脱衣服': 'undressing, clothes pull'
  },
  // 身体与外观
  body: {
    '蓝发': 'blue hair',
    '黑发': 'black hair',
    '金发': 'blonde hair',
    '银发': 'silver hair',
    '白发': 'white hair',
    '棕发': 'brown hair',
    '灰发': 'grey hair',
    '粉发': 'pink hair',
    '红发': 'red hair',
    '紫发': 'purple hair',
    '长发': 'long hair',
    '短发': 'short hair',
    '中等长度头发': 'medium hair',
    '双马尾': 'twintails',
    '马尾': 'ponytail',
    '呆毛': 'ahoge',
    '刘海': 'bangs',
    '蓝眼': 'blue eyes',
    '红眼': 'red eyes',
    '紫眼': 'purple eyes',
    '绿眼': 'green eyes',
    '金眼': 'yellow eyes',
    '异色瞳': 'heterochromia',
    '大眼': 'large eyes',
    '细腰': 'narrow waist',
    '长腿': 'long legs',
    '白肤': 'pale skin',
    '小麦色皮肤': 'dark skin',
    '雀斑': 'freckles',
    '泪痣': 'mole under eye',
    '鲸鱼尾巴': 'whale tail'
  },
  // 服装
  outfit: {
    '校服': 'school uniform',
    '水手服': 'sailor dress, serafuku',
    '和服': 'kimono, japanese clothes',
    '浴衣': 'yukata',
    '女仆装': 'maid, maid headdress',
    '护士服': 'nurse uniform',
    '兔女郎': 'bunny girl, playboy bunny',
    '连衣裙': 'dress',
    '白衬衫': 'white shirt',
    '衬衫': 'shirt',
    '短裙': 'skirt',
    '百褶裙': 'pleated skirt',
    '迷你裙': 'miniskirt',
    '牛仔裤': 'jeans',
    '外套': 'jacket',
    '大衣': 'coat',
    '毛衣': 'sweater',
    '卫衣': 'hoodie',
    '帽子': 'hat',
    '眼镜': 'glasses',
    '眼罩': 'eyepatch',
    '面具': 'mask',
    '项圈': 'collar',
    'choker': 'choker',
    '过膝袜': 'thighhighs',
    '高跟鞋': 'high heels',
    '靴子': 'boots',
    '赤脚': 'barefoot',
    '西装': 'suit, necktie',
    '军装': 'military uniform'
  },
  // 场景与构图
  scene: {
    '在床上': 'on bed',
    '在沙发上': 'on sofa',
    '浴室': 'bathroom',
    '淋浴': 'shower, showering',
    '浴缸': 'bathtub',
    '教室': 'classroom',
    '卧室': 'bedroom',
    '海边': 'beach, ocean',
    '沙滩': 'beach',
    '泳池': 'swimming pool',
    '森林': 'forest',
    '夜晚': 'night',
    '傍晚': 'sunset, evening',
    '白天': 'day',
    '室内': 'indoors',
    '室外': 'outdoors',
    '街上': 'street',
    '窗前': 'window, indoors',
    '柔光': 'soft lighting',
    '逆光': 'backlighting',
    '顶光': 'top-down lighting',
    '氛围光': 'cinematic lighting',
    '特写': 'close-up',
    '半身': 'upper body',
    '全身': 'full body',
    '大头照': 'portrait, face focus',
    '俯视': 'from above',
    '仰视': 'from below',
    '背面': 'from behind',
    '侧脸': 'profile',
    '广角': 'wide shot'
  }
};

// 展平成一张长词优先的替换表，另外接受可选的额外词条。
export function buildLexicon(extra = {}) {
  const pairs = [];
  for (const group of Object.values(GROUPS)) {
    for (const [zh, en] of Object.entries(group)) pairs.push([zh, en]);
  }
  for (const [zh, en] of Object.entries(extra)) pairs.push([zh, en]);
  // 长词优先，避免「躺在床上」被「躺着」先吃掉。
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

const QUALITY_TAGS = 'masterpiece, best quality';
const NSFW_HINTS = ['nsfw', 'nude', 'naked', 'nipples', 'sex', 'panties', 'underwear', 'lingerie', 'breasts', 'pussy', 'penis', 'cum', 'lewd', 'hentai', 'topless', 'exposed'];
const DEFAULT_NSFW_TAIL = 'nsfw, completely nude, large breasts';
const PERSON_HINTS = ['1girl', '1boy', '2girls', '2boys', 'girl', 'boy', 'woman', 'man', 'loli', 'shota', 'female', 'male'];

// 中文 → 标签。返回 { tags, hits, notes }：
//   hits  —— 命中的词典条目（"不穿衣服 → completely nude, no clothes"），用于回报给管理员；
//   notes —— 追加兜底标签的说明，便于理解为什么加了东西。
export function zhToTags(input, options = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { tags: '', hits: [], notes: [] };

  // 全角标点先归一化，否则「，」会把标签粘成一整段。
  let text = raw
    .replace(/[\uFF0C\u3001]/g, ',')
    .replace(/[\uFF1B;]/g, ',')
    .replace(/[\u3002\uFF01\uFF1F!?]/g, ',')
    .replace(/\s+/g, ' ');
  const hits = [];
  for (const [zh, en] of buildLexicon(options.extra ?? {})) {
    if (!zh || !text.includes(zh)) continue;
    // 用逗号包住替换结果：否则 "蓝发" 会跟相邻标签粘成一片（曾经出过 1girl completely nude 这种粘连）。
    text = text.split(zh).join(`, ${en}, `);
    hits.push(`${zh} → ${en}`);
  }

  // 词典覆盖不到的中文残句直接丢掉：整句中文对底模是噪音，留着只会污染画面。
  text = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, ', ');

  const parts = [];
  for (const chunk of text.split(',')) {
    const cleaned = chunk.replace(/\s{2,}/g, ' ').trim();
    if (cleaned) parts.push(cleaned);
  }
  // 去重（保持顺序）
  const seen = new Set();
  const keep = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(p);
  }
  let tags = keep.join(', ');

  const notes = [];
  const lower = () => tags.toLowerCase();
  if (!QUALITY_TAGS.split(', ').every((q) => lower().includes(q))) {
    tags = `${QUALITY_TAGS}, ${tags}`;
    notes.push(`补了质量标签：${QUALITY_TAGS}`);
  }
  // 中文里明显是成人向、但没落到任何 nsfw 相关标签上时，补一组兜底标签。
  const looksNsfw = /不穿|没穿|裸|色情|成人向|做爱|自慰|乳头|露点|诱惑|性感|大胸|巨乳/.test(raw);
  if (looksNsfw && !NSFW_HINTS.some((h) => lower().includes(h)) && !/completely nude/.test(lower())) {
    tags = `${tags}, ${DEFAULT_NSFW_TAIL}`;
    notes.push(`补了成人向兜底标签：${DEFAULT_NSFW_TAIL}`);
  }
  if (!PERSON_HINTS.some((h) => lower().includes(h)) && options.defaultPerson) {
    tags = `${tags}, ${options.defaultPerson}`;
    notes.push(`补了人数标签：${options.defaultPerson}`);
  }
  return { tags, hits, notes };
}

// 直通用负面提示词：比默认集多压手部/肢体/文字书页等常见崩坏。
export const DIRECT_DRAW_NEGATIVE = [
  'worst quality', 'low quality', 'lowres', 'bad anatomy', 'bad hands', 'bad proportions',
  'extra fingers', 'missing fingers', 'fused fingers', 'extra limbs', 'missing limbs',
  'malformed limbs', 'long neck', 'blurry', 'jpeg artifacts', 'watermark', 'signature',
  'text', 'speech bubble', 'comic panel', 'multiple views', 'sketch', 'username'
].join(', ');
