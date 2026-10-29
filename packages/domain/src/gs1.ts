import { gtin14 } from './inventory';

/**
 * GS1 条码数据（决策记录 0024 · 第四批 G3、C4）：送货单和商品上的二维码、GS1 数据矩阵常常带着
 * 商品条码（AI 01）、批号（10）、保质期（17）、数量（37 / 30）、序列号（21）、订单号（400）。
 * 支持三种写法：带括号的「(01)…(17)…」、扫码枪输出的原始串（变长字段之间用 GS 分隔，ASCII 29）、GS1 数字链接网址。
 * 读文字（没有条码的送货单、只印了日期的标签）需要视觉模型，见 G3 的可插拔接口。
 */

export interface Gs1Data {
  gtin?: string;
  lot?: string;
  /** 保质期（YYYY-MM-DD；GS1 的日为 00 时表示当月最后一天） */
  expiry?: string;
  count?: number;
  serial?: string;
  /** 客户订单号（AI 400），送货单用来对应到货通知 */
  order?: string;
}

const GS = String.fromCharCode(29);
/** 定长的应用标识符：标识符 → 数据长度 */
const FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 };
/** 变长的：标识符 → 最大长度 */
const VARIABLE: Record<string, number> = { '10': 20, '21': 20, '30': 8, '37': 8, '400': 30 };

/** GS1 日期 YYMMDD → YYYY-MM-DD（年份按 2000 年以后；日为 00 时取当月最后一天） */
export function gs1Date(yymmdd: string): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const y = 2000 + Number(yymmdd.slice(0, 2));
  const m = Number(yymmdd.slice(2, 4));
  let d = Number(yymmdd.slice(4, 6));
  if (m < 1 || m > 12) return undefined;
  if (d === 0) d = new Date(y, m, 0).getDate();
  if (d > new Date(y, m, 0).getDate()) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function put(out: Gs1Data, ai: string, v: string): void {
  if (ai === '01' || ai === '02') out.gtin = gtin14(v);
  else if (ai === '10') out.lot = v;
  else if (ai === '17') {
    const d = gs1Date(v);
    if (d) out.expiry = d;
  } else if (ai === '37' || ai === '30') out.count = Number(v);
  else if (ai === '21') out.serial = v;
  else if (ai === '400') out.order = v;
}

/** 解析一条 GS1 数据；认不出时返回 undefined */
export function parseGs1(raw: string): Gs1Data | undefined {
  const s = raw.trim().replace(/^\]([CdQe])\d/, '');
  const out: Gs1Data = {};
  // 1. 数字链接：https://…/01/{gtin}/10/{lot}?17=YYMMDD
  const link = /^https?:\/\/[^/]+\/(.+)$/i.exec(s);
  if (link) {
    const [path, query] = (link[1] as string).split('?') as [string, string | undefined];
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) put(out, parts[i] as string, decodeURIComponent(parts[i + 1] as string));
    for (const kv of (query ?? '').split('&')) {
      const [k, v] = kv.split('=');
      if (k && v) put(out, k, decodeURIComponent(v));
    }
    return out.gtin ? out : undefined;
  }
  // 2. 带括号的写法
  if (s.startsWith('(')) {
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) put(out, m[1] as string, (m[2] as string).trim());
    return Object.keys(out).length ? out : undefined;
  }
  // 3. 原始串：定长字段直接切，变长字段读到 GS 或末尾。单独一个商品条码（8、12、13、14 位数字）不算 GS1 数据
  if (/^\d{8}$|^\d{12,14}$/.test(s)) return undefined;
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) {
      i++;
      continue;
    }
    const ai3 = s.slice(i, i + 3);
    const ai2 = s.slice(i, i + 2);
    if (VARIABLE[ai3] !== undefined) {
      const end = s.indexOf(GS, i + 3);
      put(out, ai3, s.slice(i + 3, end < 0 ? Math.min(s.length, i + 3 + (VARIABLE[ai3] as number)) : end));
      i = end < 0 ? s.length : end + 1;
    } else if (FIXED[ai2] !== undefined) {
      if (i + 2 + (FIXED[ai2] as number) > s.length) return undefined;
      put(out, ai2, s.slice(i + 2, i + 2 + (FIXED[ai2] as number)));
      i += 2 + (FIXED[ai2] as number);
    } else if (VARIABLE[ai2] !== undefined) {
      const end = s.indexOf(GS, i + 2);
      put(out, ai2, s.slice(i + 2, end < 0 ? Math.min(s.length, i + 2 + (VARIABLE[ai2] as number)) : end));
      i = end < 0 ? s.length : end + 1;
    } else return Object.keys(out).length ? out : undefined;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 生成带括号写法的 GS1 数据（演示的送货单、保质期标签用） */
export function formatGs1(d: Gs1Data): string {
  const yymmdd = (iso: string) => `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  return [d.gtin ? `(01)${gtin14(d.gtin)}` : '', d.expiry ? `(17)${yymmdd(d.expiry)}` : '', d.lot ? `(10)${d.lot}` : '', d.count !== undefined ? `(37)${d.count}` : '', d.order ? `(400)${d.order}` : ''].join('');
}

export interface DeliveryNote {
  /** 送货单上的订单号（对应到货通知） */
  order?: string;
  lines: Array<{ gtin: string; cases: number; lot?: string; expiry?: string }>;
}

/** 送货单二维码：每行一条 GS1 数据（订单号可以单独一行，也可以写在每行里）；同一商品同一批号的行合并 */
export function parseDeliveryNote(raw: string): DeliveryNote | undefined {
  const note: DeliveryNote = { lines: [] };
  for (const row of raw.split(/\r?\n|;/)) {
    if (!row.trim()) continue;
    const d = parseGs1(row);
    if (!d) continue;
    if (d.order) note.order = d.order;
    if (!d.gtin) continue;
    const same = note.lines.find((l) => l.gtin === d.gtin && l.lot === d.lot);
    if (same) same.cases += d.count ?? 1;
    else note.lines.push({ gtin: d.gtin, cases: d.count ?? 1, ...(d.lot ? { lot: d.lot } : {}), ...(d.expiry ? { expiry: d.expiry } : {}) });
  }
  return note.lines.length ? note : undefined;
}
