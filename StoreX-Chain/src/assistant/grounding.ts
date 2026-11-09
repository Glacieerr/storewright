import { clock } from '../twin/twin';
import type { Grounding } from './types';

/**
 * 数字核对：回答里的每个数字、时刻、编号，都要能在工具返回的结构化结果（或者问题本身、工具声明的规则常数）里找到出处。
 *
 * 允许的换算：四舍五入到 0–2 位小数、千位逗号、比例 ×100（百分数）、秒 → 分钟 / 小时、小时 → 天、÷1 万、÷100 万、
 * 当天的秒 → 「时:分」。列表的序号（「1. 」「第 2 张」）不算。找不到出处的数字记下来：这是缺陷，评测会数出来。
 */
export interface Evidence {
  nums: Set<string>;
  ids: Set<string>;
}

const CLOCK = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;
const ID = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g;
const NUM = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;

const pad = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`;

/** 一个数值所有允许的写法 */
function renders(v: number, out: Set<string>): void {
  if (!Number.isFinite(v)) return;
  const add = (x: number, d: number) => {
    if (Number.isFinite(x)) out.add(Math.abs(x).toFixed(d));
  };
  for (const d of [0, 1, 2]) add(v, d);
  add(Math.floor(Math.abs(v)), 0);
  add(Math.ceil(Math.abs(v)), 0);
  add(v * 100, 0);
  add(v * 100, 1);
  add(v / 60, 0);
  add(v / 60, 1);
  add(v / 3600, 0);
  add(v / 3600, 1);
  add(v / 24, 1);
  add(v / 1e4, 0);
  add(v / 1e6, 2);
  if (v > -6 * 3600 && v < 54 * 3600) out.add(clock(v));
}

/** 一段文字里的数字、时刻、编号（工具结果里的字符串、问题本身） */
function fromText(s: string, ev: Evidence): void {
  for (const m of s.matchAll(CLOCK)) ev.nums.add(pad(m[1] as string, m[2] as string));
  for (const m of s.matchAll(ID)) if (/\d/.test(m[0])) ev.ids.add(m[0].toUpperCase());
  for (const m of s.matchAll(NUM)) {
    const raw = m[0].replace(/,/g, '');
    ev.nums.add(raw);
    renders(Number(raw), ev.nums);
  }
}

/** 从工具的结构化结果里收集出处（最多走 8 层、8000 个值，跳过很大的数组） */
export function collectEvidence(values: readonly unknown[], texts: readonly string[] = []): Evidence {
  const ev: Evidence = { nums: new Set(), ids: new Set() };
  let budget = 8000;
  const walk = (x: unknown, depth: number) => {
    if (budget-- <= 0 || x === null || x === undefined) return;
    if (typeof x === 'number') renders(x, ev.nums);
    else if (typeof x === 'string') fromText(x, ev);
    else if (typeof x === 'boolean' || typeof x === 'function') return;
    else if (depth >= 8) return;
    else if (ArrayBuffer.isView(x)) return;
    else if (Array.isArray(x)) {
      for (const y of x.slice(0, 400)) walk(y, depth + 1);
    } else if (x instanceof Map) {
      for (const [k, y] of [...x.entries()].slice(0, 200)) {
        walk(k, depth + 1);
        walk(y, depth + 1);
      }
    } else if (typeof x === 'object') for (const y of Object.values(x as Record<string, unknown>)) walk(y, depth + 1);
  };
  for (const v of values) walk(v, 0);
  for (const t of texts) fromText(t, ev);
  return ev;
}

/** 核对一段回答 */
export function checkGrounding(text: string, ev: Evidence): Grounding {
  let s = text.replace(/\*\*/g, '');
  let total = 0;
  let grounded = 0;
  const missing: string[] = [];
  const hit = (tok: string, ok: boolean) => {
    total++;
    if (ok) grounded++;
    else if (!missing.includes(tok)) missing.push(tok);
  };
  // 时刻
  s = s.replace(CLOCK, (all, h: string, m: string) => {
    hit(all, ev.nums.has(pad(h, m)));
    return ' ';
  });
  // 编号（字母开头、带数字）
  s = s.replace(ID, (w) => {
    if (/\d/.test(w)) hit(w, ev.ids.has(w.toUpperCase()));
    return ' ';
  });
  // 列表序号、「第 N」不算
  s = s
    .split('\n')
    .map((line) => line.replace(/^(\s*-\s*)?\d+\.\s/, '$1'))
    .join('\n')
    .replace(/第\s*\d+/g, '第');
  for (const m of s.matchAll(NUM)) {
    const raw = m[0].replace(/,/g, '');
    hit(m[0], ev.nums.has(raw) || (raw.includes('.') && ev.nums.has(String(Number(raw)))));
  }
  return { total, grounded, missing };
}
