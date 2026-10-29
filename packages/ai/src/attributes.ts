/**
 * 商品属性补充（决策记录 0023 · 第三批 B4）：替代推荐靠口味、规格、有机、无麸质这些属性；
 * 门店的商品数据常常缺这些字段。这里先用规则从商品名里抽取（口味词表、规格的写法、名字里写着的饮食标签），
 * 本地语言模型接上后（H1）用同一个接口补得更全。evaluateAttributes 按目录里已有的属性算抽取的准确率和覆盖率，
 * 让人看到规则能补多少、哪些（例如没写在名字里的「有机」）只能靠更好的数据或语言模型。
 */

export interface ExtractedAttributes {
  flavor?: string;
  size?: string;
  organic?: boolean;
  glutenFree?: boolean;
}

/** 常见口味词（英文商品名；与合成目录无关的通用词表） */
const FLAVORS = [
  'lightly salted', 'garlic & herb', 'honey roasted', 'salt & vinegar', 'sour cream & onion', 'cookies & cream',
  'original', 'classic', 'plain', 'vanilla', 'chocolate', 'strawberry', 'blueberry', 'raspberry', 'cherry', 'banana', 'peach', 'mango', 'lemon', 'lime', 'orange', 'apple', 'grape', 'coconut',
  'honey', 'maple', 'cinnamon', 'caramel', 'mint', 'peppermint', 'coffee', 'mocha', 'spicy', 'hot', 'mild', 'bbq', 'barbecue', 'salted', 'unsalted', 'sea salt', 'garlic', 'onion', 'cheddar',
  'sour cream', 'ranch', 'jalapeno', 'teriyaki', 'smoked', 'herb', 'italian', 'tomato', 'basil', 'pesto', 'sesame', 'peanut', 'almond', 'oat', 'whole grain', 'multigrain', 'unsweetened', 'sweet',
  'dark', 'milk', 'white', 'ginger', 'berry', 'tropical', 'citrus', 'cola', 'diet', 'zero', 'light',
];

const SIZE = /\b(\d+(?:\.\d+)?)\s?(oz|fl oz|lb|lbs|g|kg|ml|l|ct|pk|pack|count)\b|\b(\d+)\s?-\s?(pack|ct)\b|\b(small|medium|large|family size|jumbo|mini)\b/i;

export function extractAttributes(name: string): ExtractedAttributes {
  const lower = ` ${name.toLowerCase()} `;
  const out: ExtractedAttributes = {};
  // 最长的词优先（sea salt 比 salt 优先）
  const flavor = [...FLAVORS].sort((a, b) => b.length - a.length).find((f) => lower.includes(` ${f} `));
  if (flavor) out.flavor = flavor;
  const m = SIZE.exec(name);
  if (m) out.size = m[0].toLowerCase().replace(/\s+/g, ' ');
  if (/\borganic\b/i.test(name)) out.organic = true;
  if (/\bgluten[- ]free\b/i.test(name)) out.glutenFree = true;
  return out;
}

/** 可插拔的补充器：默认用规则；接上本地语言模型时换成异步的实现 */
export type AttributeEnricher = (item: { name: string; categoryId: string }) => ExtractedAttributes | Promise<ExtractedAttributes>;
export const ruleEnricher: AttributeEnricher = (item) => extractAttributes(item.name);

/** 抽取效果：每个属性的准确率（抽出来的有多少是对的）和覆盖率（目录里有这个属性的商品里抽出了多少） */
export function evaluateAttributes(items: ReadonlyArray<{ name: string; attributes: Readonly<Record<string, string | number | boolean>> }>): Record<'flavor' | 'size' | 'organic' | 'glutenFree', { precision: number; recall: number; n: number }> {
  const keys = ['flavor', 'size', 'organic', 'glutenFree'] as const;
  const out = {} as Record<(typeof keys)[number], { precision: number; recall: number; n: number }>;
  for (const k of keys) {
    let has = 0;
    let found = 0;
    let right = 0;
    for (const it of items) {
      const truth = it.attributes[k];
      const present = truth !== undefined && truth !== false;
      const got = extractAttributes(it.name)[k];
      if (present) has++;
      if (got !== undefined) {
        found++;
        // 规格比较时去掉空格；口味抽到一部分（Garlic & Herb → garlic）也算对
        const norm = (v: unknown) => String(v).toLowerCase().replace(/\s+/g, '');
        const ok = typeof truth === 'boolean' ? truth === got : norm(truth) === norm(got) || norm(truth).includes(norm(got)) || norm(got).includes(norm(truth));
        if (ok) right++;
      }
    }
    out[k] = { precision: found ? Math.round((right / found) * 1000) / 1000 : 0, recall: has ? Math.round((right / has) * 1000) / 1000 : 0, n: has };
  }
  return out;
}
