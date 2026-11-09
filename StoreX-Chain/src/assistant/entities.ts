import type { HubKey } from '../hub/types';
import { FAMILIES } from '../region/products';
import { STORES } from '../region/network';
import type { AssistCtx } from './types';

/**
 * 从问题里按规则认出参数：哪辆车（作业编号、车名、车牌一样的编号）、哪个商品族、哪樘门、几点、第几条建议、哪个做法。
 * 认出来的地方换成占位符（<VEH>、<FAM>……）再交给意图分类器，模型只看说法，不看具体编号。
 */
export interface Entities {
  /** 认出来的车：车辆下标和显示的编号 */
  vehicles: { vid: number; id: string }[];
  /** 调度台里的作业编号（包括没有车的） */
  ops: string[];
  fams: string[];
  doors: string[];
  stores: string[];
  /** 时刻：某个时刻，或一段时间（秒） */
  time?: { at?: number; from?: number; to?: number };
  /** 第几条（从 0 起）、「这条 / 它」 */
  card?: { index?: number; ref?: 'this' | 'prev' };
  /** 做法的线索（建议卡里的 option key） */
  option?: string;
  facility?: 'port' | 'airport' | 'dc' | 'store';
  /** 问的是哪个仓储中心（港口物流中心、机场货站、物流园、门店停车场和收货场） */
  hub?: HubKey;
  all: boolean;
  lowRisk: boolean;
  /** 写法不完全一样、但只对得上一个的编号（M2 → M02、dsbev1 → DS-BEV-1）：回答里说明按哪个理解 */
  fuzzy: string[];
  /** 对得上好几个的编号：要问清楚是哪一个 */
  ambiguous: string[];
  /** 像编号、但哪个都对不上的 */
  unknown: string[];
  /** 换成占位符以后的问题 */
  masked: string;
}

/** 编号的模糊写法：字母连在一起、数字去掉前面的零（DS-BEV-1、dsbev1 → DSBEV|1；M02、m2 → M|2；AT-1-2 → AT|1|2） */
export function idKey(id: string): string {
  const up = id.toUpperCase();
  const letters = (up.match(/[A-Z]+/g) ?? []).join('');
  const nums = (up.match(/\d+/g) ?? []).map((n) => String(Number(n)));
  return [letters, ...nums].join('|');
}

/** 仓储中心的键：问题里的说法 → 键 */
export function hubKeyOf(q: string): HubKey | undefined {
  if (/(港口|码头|物流中心|保税|查验|拆箱|装箱|拼箱|CFS|cfs|集装箱|堆场)/.test(q)) return 'port';
  if (/(机场|货站|ULD|uld|集装板|空运|航空)/.test(q)) return 'airport';
  if (/(物流园|转运仓|甩挂|园区|铁路|班列|配送中心|配送站)/.test(q)) return 'park';
  if (/(门店|综合店|停车场|取货|收货场|收货口|顾客车|店后)/.test(q)) return 'store';
  return undefined;
}

const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 「十二」「二十三」这样的中文数字（到 99） */
export function cnNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (!s) return undefined;
  if (s.length === 1) return CN_NUM[s];
  if (s[0] === '十') return 10 + (CN_NUM[s.slice(1)] ?? 0);
  const i = s.indexOf('十');
  if (i > 0) return (CN_NUM[s.slice(0, i)] ?? 0) * 10 + (CN_NUM[s.slice(i + 1)] ?? 0);
  return undefined;
}

/** 商品族的别名（顾客和店员常用的说法） */
const FAM_ALIAS: [RegExp, string[]][] = [
  [/(牛奶|奶制品|乳制品|酸奶|乳品)/, ['DAIRY']],
  [/(冻品|速冻|冷冻)/, ['FRZ_DOM', 'FRZ_IMP']],
  [/(水果|蔬菜|果蔬|生鲜蔬果)/, ['PROD_LOCAL', 'PROD_AIR', 'PROD_SEA']],
  [/(肉|猪肉|牛肉)/, ['MEAT']],
  [/(海鲜|鱼)/, ['SEAFOOD_AIR']],
  [/(面包|熟食|烘焙)/, ['BAKERY']],
  [/(饮料|饮品|矿泉水)/, ['BEV']],
  [/(日用品|日化)/, ['HH_DOM', 'HH_RAIL']],
  [/(零食|常温食品|干货)/, ['AMB_A', 'AMB_B']],
];

const OPTION_WORDS: [RegExp, string][] = [
  [/救援/, 'rescue'],
  [/等.{0,2}修/, 'wait'],
  [/(通知|顺延)/, 'notify'],
  [/(改门|换门|改到空闲|空闲的门)/, 'door'],
  [/(追加|补货)/, 'restock'],
  [/(直送|改去处)/, 'divert'],
  [/(顺序|先送)/, 'reseq'],
  [/(调低|设定温度|降温)/, 'setpoint'],
  [/(检查|密封)/, 'check'],
  [/(晚点进|路边等|晚点到)/, 'hold'],
  [/(不处理|接受|等这樘门|什么都不做)/, 'accept'],
];

/** 中文时刻：「10:30」「10点半」「下午3点」「晚上8点20」；返回当天的秒 */
function parseClock(q: string): { at: number; span: [number, number] }[] {
  const out: { at: number; span: [number, number] }[] = [];
  const re = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:[:：](\d{2})|点(?:钟)?(半|一刻|三刻|(\d{1,2})分?)?)/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    // 「慢一点」「多一点」不是时刻：中文数字的时刻要带上午、下午这样的前缀，或者后面跟着钟、半、分、刻
    if (!/^\d/.test(m[2] as string) && !m[1] && !/[钟半分刻]/.test(m[0])) continue;
    let h = cnNumber(m[2] as string);
    if (h === undefined || h > 24) continue;
    let min = 0;
    if (m[3]) min = Number(m[3]);
    else if (m[4] === '半') min = 30;
    else if (m[4] === '一刻') min = 15;
    else if (m[4] === '三刻') min = 45;
    else if (m[5]) min = Number(m[5]);
    const pre = m[1];
    if ((pre === '下午' || pre === '傍晚' || pre === '晚上') && h < 12) h += 12;
    if (pre === '中午' && h < 5) h += 12;
    out.push({ at: h * 3600 + min * 60, span: [m.index, m.index + m[0].length] });
  }
  return out;
}

export function extract(question: string, ctx: AssistCtx): Entities {
  // 「M 02」「d 05」这样字母和数字中间有空格的，先连起来
  let q = question.replace(/(^|[^A-Za-z])((?:[A-Za-z]{1,6}\s+)+)(\d{1,3})(?![\d:])/g, (_all, pre: string, letters: string, d: string) => `${pre}${letters.replace(/\s+/g, '')}${d}`);
  const e: Entities = { vehicles: [], ops: [], fams: [], doors: [], stores: [], all: /(全部|所有|都)/.test(q), lowRisk: /低风险/.test(q), fuzzy: [], ambiguous: [], unknown: [], masked: q };
  const spans: { span: [number, number]; tag: string }[] = [];

  // —— 车和作业：问题里像编号的词（字母开头带数字，可以有短横线），和跟踪行、作业、车辆编号比 ——
  const byId = new Map<string, { vid: number; id: string }>();
  for (const r of ctx.rows) byId.set(r.id.toUpperCase(), { vid: r.vid, id: r.id });
  const opIds = new Map<string, string>();
  for (const o of ctx.board.ops) {
    opIds.set(o.id.toUpperCase(), o.id);
    if (o.vehicle >= 0 && !byId.has(o.id.toUpperCase())) byId.set(o.id.toUpperCase(), { vid: o.vehicle, id: o.id });
  }
  // 车辆编号（E01、M02……）也能认：对应它当天跑的第一趟作业
  for (const u of ctx.board.units) {
    const op = ctx.board.byId.get(u.ops[0] as string);
    if (op && op.vehicle >= 0 && !byId.has(u.id.toUpperCase())) byId.set(u.id.toUpperCase(), { vid: op.vehicle, id: op.id });
  }
  // 模糊写法 → 编号（同一个写法对上好几个就记下来，要问清楚）
  const fuzzyIds = new Map<string, Set<string>>();
  for (const k of [...byId.keys(), ...opIds.keys()]) {
    const f = idKey(k);
    const set = fuzzyIds.get(f) ?? new Set<string>();
    set.add(k);
    fuzzyIds.set(f, set);
  }
  // 编号写得分开了（「ds amb b1」「vs 1」、下划线）：几段拼起来只对得上一个编号的，按那个编号认
  q = q.replace(/[A-Za-z][A-Za-z0-9]*(?:[\s_]+[A-Za-z0-9]+)+/g, (run) => {
    const cands = [...(fuzzyIds.get(idKey(run.replace(/[\s_]+/g, ''))) ?? [])];
    if (cands.length !== 1) return run;
    const id = byId.get(cands[0] as string)?.id ?? opIds.get(cands[0] as string) ?? (cands[0] as string);
    e.fuzzy.push(`${run} → ${id}`);
    return id;
  });
  const tok = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g;
  for (let m = tok.exec(q); m; m = tok.exec(q)) {
    let w = m[0].toUpperCase();
    if (!/\d/.test(w)) continue;
    if (/^[CD]\d{2}$/.test(w) && !byId.has(w)) continue;
    if (/^S\d{2}(-\d)?$/.test(w)) continue;
    if (!byId.has(w) && !opIds.has(w)) {
      let cands = [...(fuzzyIds.get(idKey(w)) ?? [])];
      // 只写了前半截（VN-S01 → VN-S01-1…VN-S01-10）：对上几个算几个
      if (!cands.length && w.length >= 2 && !/^[CD]\d$/.test(w)) cands = [...new Set([...byId.keys(), ...opIds.keys()])].filter((k) => k.startsWith(w) && /[-\d]/.test(k.charAt(w.length)));
      if (cands.length === 1) {
        e.fuzzy.push(`${m[0]} → ${byId.get(cands[0] as string)?.id ?? opIds.get(cands[0] as string) ?? cands[0]}`);
        w = cands[0] as string;
      } else if (cands.length > 1) {
        e.ambiguous.push(...cands.map((c) => byId.get(c)?.id ?? opIds.get(c) ?? c));
        spans.push({ span: [m.index, m.index + m[0].length], tag: '<VEH>' });
        continue;
      } else {
        if (!/^[CD]\d/.test(w)) e.unknown.push(m[0]);
        continue;
      }
    }
    const v = byId.get(w);
    const op = opIds.get(w);
    if (v && !e.vehicles.some((x) => x.vid === v.vid)) e.vehicles.push(v);
    if (op && !e.ops.includes(op)) e.ops.push(op);
    if (v || op) spans.push({ span: [m.index, m.index + m[0].length], tag: '<VEH>' });
  }

  // —— 月台门、门店收货口 ——
  const doorRe = /\b([CcDd]\d{2}|S\d{2}-\d)\b/g;
  for (let m = doorRe.exec(q); m; m = doorRe.exec(q)) {
    const d = (m[1] as string).toUpperCase();
    if (byId.has(d)) continue;
    e.doors.push(d);
    spans.push({ span: [m.index, m.index + m[0].length], tag: '<DOOR>' });
  }

  // —— 商品族：名称或别名 ——
  for (const f of FAMILIES) {
    const short = f.label.replace(/（.*）/, '');
    const k = q.indexOf(short);
    if (k >= 0 && short.length >= 2) {
      if (!e.fams.includes(f.key)) e.fams.push(f.key);
      spans.push({ span: [k, k + short.length], tag: '<FAM>' });
    }
  }
  if (!e.fams.length)
    for (const [re, keys] of FAM_ALIAS) {
      const m = re.exec(q);
      if (!m) continue;
      for (const k of keys) if (!e.fams.includes(k)) e.fams.push(k);
      spans.push({ span: [m.index, m.index + m[0].length], tag: '<FAM>' });
      break;
    }

  // —— 门店 ——
  for (const s of STORES) if (q.includes(s.name) || q.includes(s.key)) e.stores.push(s.key);

  // —— 时刻：具体时刻、「X 小时后 / 内」「半小时」「接下来 X 小时」 ——
  const clocks = parseClock(q);
  for (const c of clocks) spans.push({ span: c.span, tag: '<TIME>' });
  if (clocks.length >= 2) e.time = { from: Math.min((clocks[0] as { at: number }).at, (clocks[1] as { at: number }).at), to: Math.max((clocks[0] as { at: number }).at, (clocks[1] as { at: number }).at) };
  else if (clocks.length === 1) {
    const at = (clocks[0] as { at: number }).at;
    e.time = /(之后|以后|后有|起)/.test(q) ? { from: at, to: at + 4 * 3600 } : /(之前|以前|前有)/.test(q) ? { from: ctx.t, to: at } : { at };
  }
  const rel = /(接下来|未来|之后的|这)?\s*(\d+|[一二两三四五六七八九十半]+)\s*(个)?\s*(小时|钟头)/.exec(q);
  if (!e.time && rel) {
    const n = rel[2] === '半' ? 0.5 : (cnNumber(rel[2] as string) ?? 1);
    e.time = { from: ctx.t, to: ctx.t + n * 3600 };
    spans.push({ span: [rel.index, rel.index + rel[0].length], tag: '<TIME>' });
  } else if (!e.time && /半小时/.test(q)) e.time = { from: ctx.t, to: ctx.t + 1800 };
  else if (!e.time && /上午/.test(q)) e.time = { from: 6 * 3600, to: 12 * 3600 };
  else if (!e.time && /下午/.test(q)) e.time = { from: 12 * 3600, to: 18 * 3600 };
  else if (!e.time && /晚上|夜里/.test(q)) e.time = { from: 18 * 3600, to: 24 * 3600 };

  // —— 第几条、这条 ——
  const nth = /第\s*(\d+|[一二两三四五六七八九十]+)\s*(条|张|个|项)/.exec(q);
  if (nth) {
    const n = cnNumber(nth[1] as string);
    if (n !== undefined && n >= 1) e.card = { index: n - 1 };
    spans.push({ span: [nth.index, nth.index + nth[0].length], tag: '<CARD>' });
  } else if (/(上一张|上一条|前一张|前一条)/.test(q)) e.card = { ref: 'prev' };
  else if (/(这条|这张|那张|那条|这个建议|那个建议|刚才那条|刚才那张|上面那条|上面那张|这个|那个|它)/.test(q)) e.card = { ref: 'this' };

  for (const [re, key] of OPTION_WORDS)
    if (re.test(q)) {
      e.option = key;
      break;
    }

  const hub = hubKeyOf(q);
  if (hub) e.hub = hub;
  if (/(港口|码头|班轮|泊位|岸桥|锚地|集装箱|船)/.test(q)) e.facility = 'port';
  else if (/(机场|航班|货机|机坪|机位|空运)/.test(q)) e.facility = 'airport';
  else if (/(配送中心|物流园|仓库|堆垛机|班列|火车|铁路|货运站)/.test(q)) e.facility = 'dc';
  else if (/(门店|综合店|收货口|店后)/.test(q)) e.facility = 'store';

  // 换成占位符（从后往前换，位置不乱；重叠的只换第一个）
  spans.sort((a, b) => a.span[0] - b.span[0]);
  const keep: typeof spans = [];
  for (const s of spans) if (!keep.length || s.span[0] >= (keep[keep.length - 1] as (typeof spans)[number]).span[1]) keep.push(s);
  let masked = q;
  for (const s of keep.reverse()) masked = `${masked.slice(0, s.span[0])}${s.tag}${masked.slice(s.span[1])}`;
  e.masked = masked;
  return e;
}
