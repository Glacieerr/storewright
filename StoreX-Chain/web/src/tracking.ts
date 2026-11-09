import { STORE } from '../../src/region/network';
import { casesPerPallet, FAMILIES, PALLETS_PER_FEU } from '../../src/region/products';
import type { BoardOp } from '../../src/sim/board';
import type { WSeg, WVehicle } from '../../src/sim/trace';
import type { LoopResult } from '../../src/twin/loop';
import { t as tr, tx, isEn } from './i18n';

/**
 * 实时跟踪：每辆车此刻的状态、位置、速度、从哪来到哪去、出发和到达（计划 / 孪生估计 / 现场实际）、载重、货温。
 *
 * 计划视图按仿真排的计划；现场视图（闭环孪生）里车按现场的延误走，「预计到达」用孪生自己的估计
 * （它只看感知数据：定位、车载终端、门磁……），到了以后再和实际到达比。
 */
export type TrackStatus = 'pending' | 'moving' | 'working' | 'done';
export const STATUS_LABEL: Record<TrackStatus, string> = { pending: tr('未出发'), moving: tr('在途'), working: tr('作业中'), done: tr('已收车') };

export interface TrackStop {
  name: string;
  /** 计划到达、孪生估计（现场视图）、是否已经过了 */
  plan: number;
  eta?: number;
  passed: boolean;
}
export interface TrackRow {
  i: number;
  id: string;
  kind: string;
  type: string;
  status: TrackStatus;
  act: string;
  where: string;
  x?: number;
  z?: number;
  /** 公里 / 小时（这一程的平均车速，停着是 0） */
  speed: number;
  origin: string;
  dest: string;
  /** 下一个要到的地方，和计划 / 估计的到达时刻（秒） */
  next: string;
  nextPlan?: number;
  nextEta?: number;
  etaSrc: 'plan' | 'twin';
  remainKm?: number;
  /** 计划出发、实际出发（现场视图里按延误）、计划收车 */
  depart?: number;
  departActual?: number;
  end?: number;
  load: string;
  kg?: number;
  cargo: string;
  delayMin?: number;
  temp?: { value: number; limit: number };
  progress: number;
  stops: TrackStop[];
}

export interface TrackCtx {
  list: readonly WVehicle[];
  /** 哪些车要跟踪（自己的车和孪生派出来的车；背景的别家火车、过路船不跟踪） */
  tracked: (i: number) => boolean;
  opOf: (i: number) => BoardOp | undefined;
  /** 现场视图：闭环的结果和三维下标 → 现场车辆编号 */
  field?: { result: LoopResult; vidOf: (i: number) => number | undefined };
  pose: (i: number) => { x: number; y: number } | undefined;
  roadAt: (x: number, z: number) => string | undefined;
}

const PLACE: Record<string, string> = {
  DC: tr('配送中心'),
  PORT: tr('港口'),
  AIR: tr('机场货运区'),
  AIR_IN: tr('航线'),
  SEA: tr('外海航线'),
  RAIL_EAST: tr('洲际铁路（东）'),
  RAIL_DC: tr('物流园货运站'),
  NORTH: tr('北高速口（国内长途）'),
  EAST: tr('东高速口（跨境长途）'),
  BAKERY: tr('中央面包房'),
};
export const placeName = (key: string | undefined): string => (!key ? '' : key === STORE.key ? STORE.name : (PLACE[key] ?? key));

const moving = (s: WSeg) => !!s.loop || (!s.place && (!!s.route || s.pts.length > 2));
const segKm = (s: WSeg): number => {
  let d = 0;
  for (let k = 2; k + 1 < s.pts.length; k += 2) d += Math.hypot((s.pts[k] as number) - (s.pts[k - 2] as number), (s.pts[k + 1] as number) - (s.pts[k - 1] as number));
  return d / 100;
};

/** 一段行驶开往哪里：下一段停的地点，或者路线的终点，或者从动作里读 */
function destOf(v: WVehicle, k: number): string {
  const s = v.segs[k] as WSeg;
  const nx = v.segs[k + 1];
  if (s.loop) return tr('顾客家（送完回店）');
  if (nx?.place) return placeName(nx.place);
  if (s.route?.length) {
    const last = s.route[s.route.length - 1] as string;
    if (PLACE[last] || last === STORE.key) return placeName(last);
  }
  const a = s.act ?? '';
  const m = /^(?:开往|回|滑行到)(.+)$/.exec(a);
  if (m) return m[1] as string;
  if (/进港/.test(a)) return tr('港口泊位');
  if (/离港/.test(a)) return tr('外海');
  if (/班列进站|→ 物流园货运站/.test(a)) return tr('物流园货运站');
  if (/空车出站/.test(a)) return tr('洲际铁路（东）');
  if (/进近降落|减速/.test(a)) return tr('机场跑道');
  if (/起飞/.test(a)) return tr('离场航线');
  if (/进货|提箱/.test(a)) return tr('配送中心');
  return nx?.act ? nx.act.replace(/^在/, '') : '';
}

const famLabel = (key: string) => FAMILIES.find((f) => f.key === key)?.label ?? key;
/** 装的货：件数、重量（按每箱的重量折算）、商品族 */
function loadOf(v: WVehicle, op: BoardOp | undefined): { text: string; kg?: number; cargo: string } {
  const units: Record<string, number> = {};
  for (const st of op?.stops ?? []) for (const [k, u] of Object.entries(st.load ?? {})) units[k] = (units[k] ?? 0) + u;
  for (const [k, u] of Object.entries(op?.load ?? {})) units[k] = (units[k] ?? 0) + u;
  let kg = 0;
  let n = 0;
  for (const [k, u] of Object.entries(units)) {
    const f = FAMILIES.find((x) => x.key === k);
    if (!f) continue;
    kg += (u / f.unitsPerCase) * f.kg;
    n += u;
  }
  const fams = Object.entries(units).sort((a, b) => b[1] - a[1]).map(([k]) => famLabel(k).replace(/（.*）/, ''));
  const pal = op?.pallets ?? Number(/(\d+) 托/.exec(v.label)?.[1] ?? NaN);
  const boxes = /(\d+) (?:个自己的 40 尺)?箱/.exec(v.label)?.[1];
  if (v.kind === 'train') return { text: tr('本店 {boxes} 个 40 尺箱（整列另有别家的货）', { boxes: boxes ?? '?' }), cargo: tr('进口常温食品、日用品') };
  if (v.kind === 'ship') return { text: tr('本店约 {boxes} 个 40 尺箱（整船另有别家的货）', { boxes: boxes ?? '?' }), cargo: tr('进口常温、冷冻、海运冷箱果蔬') };
  if (v.kind === 'plane') return { text: tr('本店的空运果蔬、海鲜（整机另有别家的货）'), cargo: tr('进口果蔬、海鲜') };
  if (v.kind === 'drayage') {
    const fam = v.label.split(' · ')[1] ?? '';
    const f = FAMILIES.find((x) => x.label === fam);
    const boxKg = f ? PALLETS_PER_FEU * casesPerPallet(f) * f.kg : undefined;
    return { text: `${tr('1 个 40 尺箱')}${boxKg ? ` ${tr('· {boxKg} 吨', { boxKg: (boxKg / 1000).toFixed(1) })}` : ''}`, ...(boxKg ? { kg: boxKg } : {}), cargo: fam };
  }
  if (/线上配送/.test(v.label)) return { text: tr('线上订单（送到顾客家）'), cargo: tr('门店拣好的线上订单') };
  const parts = [Number.isFinite(pal) ? tr('{pal} 托', { pal }) : '', n ? tr('{n} 件', { n: Math.round(n).toLocaleString('en-US') }) : '', kg ? tr('{kg} 吨', { kg: (kg / 1000).toFixed(1) }) : ''].filter(Boolean);
  return { text: parts.join(' · ') || '—', ...(kg ? { kg } : {}), cargo: fams.slice(0, 3).map((f) => tx(f)).join(isEn() ? ', ' : '、') + (fams.length > 3 ? ` ${tr('等 {length} 类', { length: fams.length })}` : '') };
}

/** 现场视图：某一刻的值（每分钟 / 每 5 分钟的数组，NaN = 没有） */
const atMinute = (a: Float32Array | undefined, t: number) => (a && a.length ? (a[Math.max(0, Math.min(a.length - 1, Math.floor(t / 60)))] as number) : NaN);
const atSlot = (a: Float32Array | undefined, t: number) => {
  if (!a || !a.length) return NaN;
  // 最近一次估计（往前找，最多一小时）
  for (let k = Math.min(a.length - 1, Math.floor(t / 300) - 1), n = 0; k >= 0 && n < 12; k--, n++) if (Number.isFinite(a[k] as number)) return a[k] as number;
  return NaN;
};

export function trackRow(ctx: TrackCtx, i: number, t: number): TrackRow | undefined {
  const v = ctx.list[i];
  if (!v || !ctx.tracked(i) || !v.segs.length) return undefined;
  const op = ctx.opOf(i);
  const fr = ctx.field?.result;
  const vid = ctx.field?.vidOf(i);
  const k = vid !== undefined && fr ? fr.vids.indexOf(vid) : -1;
  const delays = k >= 0 ? fr?.delays[k] : undefined;
  const endAt = k >= 0 ? fr?.ends[k] : undefined;
  // 现场：车按「计划时刻 = 现在 − 延误」走；没出发的按出发那一刻的延误
  let d = atMinute(delays, t);
  if (!Number.isFinite(d) && delays) {
    let m = Math.floor(t / 60);
    while (m < delays.length && !Number.isFinite(delays[m] as number)) m++;
    d = m < delays.length ? (delays[m] as number) : 0;
  }
  const delay = Number.isFinite(d) ? d : 0;
  const pt = t - delay;
  const segs = v.segs;
  const first = segs[0] as WSeg;
  const last = segs[segs.length - 1] as WSeg;
  let status: TrackStatus = 'working';
  let ks = segs.findIndex((s) => pt >= s.t0 && pt < s.t1);
  if (pt < first.t0) {
    status = 'pending';
    ks = 0;
  } else if (pt >= last.t1 || (endAt !== undefined && Number.isFinite(endAt) && t > endAt)) {
    status = 'done';
    ks = segs.length - 1;
  } else if (ks < 0) ks = segs.findIndex((s) => s.t0 > pt);
  const seg = segs[Math.max(0, ks)] as WSeg;
  if (status === 'working' && moving(seg)) status = 'moving';
  const est = vid !== undefined ? fr?.twinEst.get(vid) : undefined;
  const twinDelay = atSlot(est?.delay, t);
  const storeEta = atSlot(est?.storeEta, t);
  // 下一个要到的地方：在途的是这一段的终点；停着的、没出发的是下一段行驶的终点
  let nk = ks;
  if (status !== 'moving') {
    nk = segs.findIndex((s, j) => j >= Math.max(0, status === 'pending' ? 0 : ks + 1) && moving(s));
  }
  const nseg = nk >= 0 ? segs[nk] : undefined;
  const next = nseg && status !== 'done' ? destOf(v, nk) : '';
  const nextPlan = nseg ? nseg.t1 : undefined;
  let nextEta: number | undefined;
  let etaSrc: TrackRow['etaSrc'] = 'plan';
  if (fr && nextPlan !== undefined && status !== 'done') {
    if (next === STORE.name && Number.isFinite(storeEta)) nextEta = storeEta;
    else if (Number.isFinite(twinDelay)) nextEta = nextPlan + twinDelay;
    if (nextEta !== undefined) etaSrc = 'twin';
  }
  const pose = ctx.pose(i);
  const f = status === 'moving' ? Math.max(0, Math.min(1, (pt - seg.t0) / Math.max(1, seg.t1 - seg.t0))) : 0;
  const km = seg.loop ? (op?.km ?? 0) : moving(seg) ? segKm(seg) : 0;
  const remainKm = status === 'moving' ? km * (1 - f) : undefined;
  const speed = status === 'moving' && seg.t1 > seg.t0 ? km / ((seg.t1 - seg.t0) / 3600) : 0;
  let where = '';
  if (status === 'pending') where = tr('还没出发（{act}）', { act: tx(seg.act ?? '') });
  else if (status === 'done') where = tr('已收车');
  else if (status === 'moving') {
    const road = pose && (v.kind === 'truck' || v.kind === 'reefer' || v.kind === 'ev' || v.kind === 'van' || v.kind === 'drayage') ? ctx.roadAt(pose.x, pose.y) : v.kind === 'train' ? tr('铁路') : v.kind === 'ship' ? tr('海上') : v.kind === 'plane' ? (/滑行/.test(seg.act ?? '') ? tr('滑行道') : /减速/.test(seg.act ?? '') ? tr('跑道') : tr('空中')) : undefined;
    where = `${road ? `${road} · ` : ''}${tr('距{next} {v2} 公里', { next: next || tr('目的地'), v2: remainKm !== undefined ? remainKm.toFixed(1) : '?' })}`;
  } else {
    where = seg.act ?? '';
    if (seg.place === 'DC' && op?.door) where += ` ${tr('· 月台门 {door}', { door: op.door })}`;
    const dk = seg.place ? op?.docks?.[seg.place] : undefined;
    if (dk !== undefined) where += ` ${tr('· 收货口 {dk}', { dk: dk + 1 })}`;
  }
  const ld = loadOf(v, op);
  const firstMove = segs.find(moving);
  const temps = vid !== undefined ? fr?.temps.get(vid) : undefined;
  const tv = temps ? atSlot(temps.truth, t + 300) : NaN;
  const stops: TrackStop[] = [];
  segs.forEach((s, j) => {
    if (!moving(s)) return;
    const name = destOf(v, j);
    if (!name) return;
    const passed = pt >= s.t1;
    const eta = fr && !passed && Number.isFinite(twinDelay) ? (name === STORE.name && Number.isFinite(storeEta) && j === nk ? storeEta : s.t1 + twinDelay) : undefined;
    stops.push({ name, plan: s.t1, ...(eta !== undefined ? { eta } : {}), passed });
  });
  const total = Math.max(1, last.t1 - first.t0);
  return {
    i,
    id: op?.id ?? v.label.split(' · ')[0]?.replace(/（.*$/, '') ?? tr('车 {i}', { i }),
    kind: v.kind,
    type: v.label.split(' · ')[0]?.replace(/（.*$/, '') ?? v.kind,
    status,
    act: status === 'pending' ? tr('计划 {t0} 出发', { t0: clock(firstMove?.t0 ?? first.t0) }) : status === 'done' ? tr('已收车') : (seg.act ?? ''),
    where,
    ...(pose ? { x: pose.x, z: pose.y } : {}),
    speed,
    origin: placeName(op?.from) || destOf(v, 0),
    dest: placeName(op?.to) || (segs.length ? destOf(v, segs.length - 1) : ''),
    next,
    ...(nextPlan !== undefined ? { nextPlan } : {}),
    ...(nextEta !== undefined ? { nextEta } : {}),
    etaSrc,
    ...(remainKm !== undefined ? { remainKm } : {}),
    ...(firstMove ? { depart: firstMove.t0 } : {}),
    ...(firstMove && fr && delays ? { departActual: firstMove.t0 + delay } : {}),
    end: last.t1,
    load: ld.text,
    ...(ld.kg ? { kg: ld.kg } : {}),
    cargo: ld.cargo,
    ...(fr && delays && status !== 'pending' ? { delayMin: Math.round(delay / 60) } : {}),
    ...(temps && Number.isFinite(tv) ? { temp: { value: tv, limit: temps.limit } } : {}),
    progress: Math.max(0, Math.min(1, (pt - first.t0) / total)),
    stops,
  };
}

export function clock(t: number): string {
  const m = Math.round(t / 60);
  const r = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}
