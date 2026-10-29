/**
 * 召回处理（决策记录 0024 · 第四批 C5）：店长粘贴公开的召回通知（文字），AI 抽出商品、条码、批号、日期范围和原因，
 * 和商品目录模糊匹配，由人确认后才下架、拦截、通知顾客。
 * - 抽取：规则（条码是 12–14 位数字、批号常见写法、日期范围、规格、原因关键词）；接上本地语言模型后（H1）同一个接口抽得更全；
 * - 匹配：条码完全一致直接算；否则按名字里的词（品牌、品名）重合度和规格打分。召回必须一个不漏：
 *   分数过了较低的门槛就列出来让人确认（宁可多列、多下架）；
 * - 评估：合成的召回通知（不同写法、中英文、批号格式），看抽取准确率和匹配的召回率（要求 100%）、精确率。
 */

export interface RecallParsed {
  /** 通知里的商品名（去掉批号、日期、条码之后剩下的主要部分） */
  product: string;
  size?: string;
  gtins: string[];
  /** 批号或批号开头 */
  lots: string[];
  from?: string;
  to?: string;
  reason?: string;
}

const REASONS: Array<[RegExp, string]> = [
  [/salmonella|沙门/i, 'SALMONELLA'],
  [/listeria|李斯特/i, 'LISTERIA'],
  [/e\.?\s?coli|大肠/i, 'E_COLI'],
  [/undeclared|allergen|过敏|未标注|未声明/i, 'ALLERGEN'],
  [/foreign (material|object)|metal|plastic|glass|异物|金属|塑料|玻璃/i, 'FOREIGN_MATTER'],
  [/mold|霉/i, 'MOLD'],
  [/label|标签/i, 'LABELING'],
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 各种写法的日期 → YYYY-MM-DD */
function isoDate(s: string): string | undefined {
  let m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m) return `${m[3]}-${pad2(months.indexOf((m[1] as string).toLowerCase()) + 1)}-${pad2(Number(m[2]))}`;
  return undefined;
}

export function parseRecallNotice(text: string): RecallParsed {
  const t = text.replace(/\s+/g, ' ').trim();
  const gtins = [...new Set([...t.matchAll(/\b(\d{12,14})\b/g)].map((m) => (m[1] as string).padStart(14, '0')))];
  const lots = new Set<string>();
  for (const m of t.matchAll(/(?:lot(?:s| codes?| numbers?)?|batch(?:es)?|批次|批号)\s*(?:#|no\.?|:|：|beginning with|starting with|开头为|以)?\s*([A-Z0-9][A-Z0-9-]{2,}(?:\s*(?:,|、|and|和|or|与)\s*[A-Z0-9][A-Z0-9-]{2,})*)/gi)) {
    for (const x of (m[1] as string).split(/\s*(?:,|、|\band\b|和|\bor\b|与)\s*/i)) if (/\d/.test(x) && x.length >= 3) lots.add(x.toUpperCase());
  }
  // 日期范围：「from … to …」「… 至 …」「best by …」
  const dates = [...t.matchAll(/(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}\/\d{1,2}\/\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/gi)].map((m) => isoDate(m[1] as string)).filter((x): x is string => !!x).sort();
  const size = /(\d+(?:\.\d+)?)\s?(oz|fl oz|lb|lbs|g|kg|ml|l|克|千克|毫升|升)\b/i.exec(t);
  const reason = REASONS.find(([re]) => re.test(t))?.[1];
  // 商品名：引号里的、或「recalls …」「召回 …」之后到第一个逗号 / 句号 / 规格之前
  const quoted = /[「"“]([^」"”]{3,60})[」"”]/.exec(t)?.[1];
  const after = /(?:recall(?:s|ing)?(?: of)?|召回)\s*[:：]?\s*([^,，.。;；(（]{3,80})/i.exec(t)?.[1];
  let product = (quoted ?? after ?? t.slice(0, 60)).replace(/\b\d{12,14}\b/g, '').replace(size?.[0] ?? '\u0000', '').trim();
  product = product.replace(/\s+(?:lot|batch|批次|批号).*$/i, '').replace(/\s+(?:because|due to|owing to|over|after|for possible|following)\b.*$/i, '').replace(/[，,]?\s*(?:原因|因为|由于).*$/, '').trim();
  return { product, ...(size ? { size: `${size[1]} ${(size[2] as string).toLowerCase()}` } : {}), gtins, lots: [...lots], ...(dates[0] ? { from: dates[0] } : {}), ...(dates.length > 1 ? { to: dates.at(-1) as string } : {}), ...(reason ? { reason } : {}) };
}

export interface RecallCatalogItem {
  id: string;
  name: string;
  gtin: string;
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9一-鿿 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !['oz', 'lb', 'lbs', 'ml', 'kg', 'the', 'and', 'of', 'brand'].includes(w)));

/**
 * 和商品目录匹配，分三档：
 * - 条码一致：1 分；
 * - 通知里的商品名的词全部出现在商品名里（同名的不同规格、同品名的「…酱」也会列出来让人确认）：0.85，规格也对上 +0.1；
 * - 部分重合：按稀有程度加权的重合比例 × 0.7（品牌名出现在很多商品里，权重小），规格对上 +0.1；
 * 过了门槛（默认 0.5）的都列出来，由人确认。召回宁可多列。
 */
export function matchRecall(p: RecallParsed, items: readonly RecallCatalogItem[], minScore = 0.5): Array<{ item: RecallCatalogItem; score: number; by: 'GTIN' | 'NAME' }> {
  const want = tokens(p.product);
  const out: Array<{ item: RecallCatalogItem; score: number; by: 'GTIN' | 'NAME' }> = [];
  const df = new Map<string, number>();
  for (const it of items) for (const w of tokens(it.name)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log((items.length + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const total = [...want].reduce((a, w) => a + idf(w), 0);
  for (const it of items) {
    if (p.gtins.includes(it.gtin.padStart(14, '0'))) {
      out.push({ item: it, score: 1, by: 'GTIN' });
      continue;
    }
    if (!want.size) continue;
    const have = tokens(it.name);
    const sizeOk = p.size ? it.name.toLowerCase().replace(/\s+/g, '').includes(p.size.replace(/\s+/g, '')) : false;
    let score: number;
    if ([...want].every((w) => have.has(w))) score = 0.85 + (sizeOk ? 0.1 : 0);
    else {
      let hit = 0;
      for (const w of want) if (have.has(w)) hit += idf(w);
      score = (total ? hit / total : 0) * 0.7 + (sizeOk ? 0.1 : 0);
    }
    score = Math.round(score * 1000) / 1000;
    if (score >= minScore) out.push({ item: it, score, by: 'NAME' });
  }
  return out.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
}

export interface SyntheticRecall {
  text: string;
  itemIds: string[];
  gtin?: string;
  lot?: string;
  from?: string;
  to?: string;
  reason: string;
}

/** 合成召回通知：不同写法（有的给条码、有的只给名字和规格）、中英文、批号格式、日期范围 */
export function generateRecallNotices(items: readonly RecallCatalogItem[], seed = 1, n = 24): SyntheticRecall[] {
  let x = seed * 7919 + 3;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const reasons: Array<[string, string, string]> = [
    ['SALMONELLA', 'possible Salmonella contamination', '可能受沙门氏菌污染'],
    ['ALLERGEN', 'undeclared peanut allergen', '含有未标注的花生过敏原'],
    ['FOREIGN_MATTER', 'may contain small pieces of metal', '可能混入金属异物'],
    ['LISTERIA', 'potential Listeria monocytogenes', '可能受李斯特菌污染'],
  ];
  const out: SyntheticRecall[] = [];
  for (let k = 0; k < n; k++) {
    const it = items[Math.floor(rnd() * items.length)] as RecallCatalogItem;
    const [code, en, zh] = reasons[k % reasons.length] as [string, string, string];
    const lot = `L${2300 + Math.floor(rnd() * 99)}${String.fromCharCode(65 + Math.floor(rnd() * 6))}`;
    const m = 1 + Math.floor(rnd() * 11);
    const from = `2026-${pad2(m)}-01`;
    const to = `2026-${pad2(m)}-28`;
    const showGtin = rnd() < 0.5;
    const zhGtin = showGtin ? `，条码 ${it.gtin}` : '';
    const style = k % 4;
    const text =
      style === 0
        ? `FOR IMMEDIATE RELEASE — Company recalls "${it.name}" ${showGtin ? `(UPC ${it.gtin.slice(-12)})` : ''} with lot codes beginning with ${lot}, best by ${from} through ${to}, due to ${en}.`
        : style === 1
          ? `召回通知：召回「${it.name}」${zhGtin}，批次 ${lot} 开头，保质期 ${from} 至 ${to}。原因：${zh}。`
          : style === 2
            ? `Recall: ${it.name}. Lot: ${lot}, ${lot.slice(0, -1)}Z. Sell-by ${Number(from.slice(5, 7))}/01/2026 - ${Number(to.slice(5, 7))}/28/2026. Reason: ${en}. ${showGtin ? `GTIN ${it.gtin}` : ''}`
            : `The manufacturer is recalling ${it.name} because of ${en}. Affected batches: ${lot}. Dates ${from} to ${to}.${showGtin ? ` Barcode ${it.gtin}.` : ''}`;
    out.push({ text, itemIds: [it.id], ...(showGtin ? { gtin: it.gtin.padStart(14, '0') } : {}), lot, from, to, reason: code });
  }
  return out;
}

/**
 * 评估：抽取（条码、批号、日期、原因）的准确率，匹配的召回率（应为 100%）和精确率；
 * 目录里常有同名不同规格的商品，没有条码时只能由人确认，所以另算「列出来的候选里和召回商品同名的比例」。
 */
export function evaluateRecall(notices: readonly SyntheticRecall[], items: readonly RecallCatalogItem[]): { gtin: number; lot: number; dates: number; reason: number; matchRecall: number; matchPrecision: number; sameNameShare: number; listed: number; n: number } {
  let g = 0;
  let gn = 0;
  let lot = 0;
  let dates = 0;
  let reason = 0;
  let found = 0;
  let listed = 0;
  let correct = 0;
  let sameName = 0;
  for (const nt of notices) {
    const p = parseRecallNotice(nt.text);
    if (nt.gtin) {
      gn++;
      if (p.gtins.includes(nt.gtin)) g++;
    }
    if (p.lots.some((l) => l === nt.lot)) lot++;
    if (p.from === nt.from && p.to === nt.to) dates++;
    if (p.reason === nt.reason) reason++;
    const m = matchRecall(p, items);
    listed += m.length;
    const ids = new Set(m.map((x) => x.item.id));
    if (nt.itemIds.every((id) => ids.has(id))) found++;
    correct += m.filter((x) => nt.itemIds.includes(x.item.id)).length;
    const names = new Set(nt.itemIds.map((id) => items.find((i) => i.id === id)?.name));
    sameName += m.filter((x) => names.has(x.item.name)).length;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const n = notices.length || 1;
  return { gtin: r3(gn ? g / gn : 1), lot: r3(lot / n), dates: r3(dates / n), reason: r3(reason / n), matchRecall: r3(found / n), matchPrecision: r3(listed ? correct / listed : 0), sameNameShare: r3(listed ? sameName / listed : 0), listed: r3(listed / n), n: notices.length };
}
