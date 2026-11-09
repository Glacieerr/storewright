import type { AgentTrace } from '../../../StoreX/src/ops/trace';

/**
 * 门店停车场一天的来车：顾客到店购物的车、到店取货的车（即时取货车位 / 自提柜 / 免下车取货）、员工的车、房车和拖车。
 *
 * - 到店取货、到店购物的车按第二部分 StoreX 门店仿真的轨迹：取货车停到取货位的时刻、交付完的时刻照轨迹；
 *   购物的车按顾客进门、出门的时刻倒推（下车走到店门、出门走回车上、把购物车推进回收栏）；
 * - 百货日用馆的顾客（店里没有仿真）：按 StoreX 顾客车辆每小时的量的一个比例，逛的时间长一些；
 * - 员工：StoreX 排班员工的在岗时段，加上百货馆的两班员工；约六成开车，提前十来分钟到；
 * - 房车和拖车：前一晚停着、早上开走的一辆房车，关门前到、停到第二天早上的一辆，白天来去的几辆长车。
 * 同一天、同一个编号每次一样。纯函数。
 */
export type CarKind = 'pickup' | 'locker' | 'drive' | 'shopper' | 'dept' | 'staff' | 'rv' | 'camper' | 'boat' | 'utility';

export interface CarVisit {
  id: string;
  kind: CarKind;
  label: string;
  /** 停进车位（取货位）的时刻、开始开走的时刻 */
  arrive: number;
  leave: number;
  /** 顾客进门、出门的时刻（购物的车） */
  enter?: number;
  exit?: number;
  /** 取货：交付完的时刻；StoreX 轨迹里的取货位（栅格坐标） */
  handoff?: number;
  bay?: { x: number; y: number };
  /** StoreX 轨迹里的车辆、顾客编号 */
  ref?: number;
  shopper?: number;
  /** 车型、颜色用的随机数（0–1） */
  seed: number;
  /** 电动车（优先停充电车位）、持无障碍证 */
  ev?: boolean;
  accessible?: boolean;
}

export function rng(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash01 = (n: number, k: number) => rng(n * 7919 + k * 104729 + 17)();

/** 栅格坐标的取货位 → 取货方式：西墙外 x = 2、y 44 以南是免下车取货车道；x = 5 是自提柜外侧；x = 2、y 44 以北是车边交付车位（上一代） */
export function pickupMode(bay: { x: number; y: number }): 'drive' | 'locker' | 'pickup' {
  if (bay.x >= 4) return 'locker';
  return bay.y >= 44 ? 'drive' : 'pickup';
}

const lastPt = (pts: readonly number[]) => ({ x: pts[pts.length - 2] as number, y: pts[pts.length - 1] as number });

export interface VisitOptions {
  /** 当天的编号（百货馆顾客、员工、长车按它排） */
  seed: number;
  /** 上一代 / StoreX */
  generation: 'gen1' | 'storex';
  /** 百货馆顾客占 StoreX 顾客车辆的比例 */
  deptShare?: number;
  /** 员工开车的比例 */
  staffDrive?: number;
}

/** 从 StoreX 的门店轨迹（所有人和车）排出当天停车场的来车 */
export function deriveVisits(agents: readonly AgentTrace[], o: VisitOptions): CarVisit[] {
  const out: CarVisit[] = [];
  const shoppers = new Map<number, AgentTrace>();
  for (const a of agents) {
    if (a.kind !== 'shopper') continue;
    const m = /顾客 (\d+)/.exec(a.label);
    if (m) shoppers.set(Number(m[1]), a);
  }
  const hourly = new Array<number>(26).fill(0);
  for (const a of agents) {
    if (a.kind !== 'car' || a.segs.length < 2) continue;
    const first = a.segs[0] as AgentTrace['segs'][number];
    const last = a.segs[a.segs.length - 1] as AgentTrace['segs'][number];
    const order = /订单 (\d+)/.exec(a.label);
    if (order) {
      const bay = lastPt(first.pts);
      const mode = pickupMode(bay);
      const wait = a.segs[1] as AgentTrace['segs'][number];
      out.push({ id: `P${order[1]}`, kind: mode, label: `取货 · 订单 ${order[1]}`, arrive: first.t1, leave: last.t0, handoff: wait.t1, bay, ref: a.id, seed: hash01(a.id, 1) });
      continue;
    }
    const sh = /顾客 (\d+)/.exec(a.label);
    if (!sh) continue;
    const n = Number(sh[1]);
    const agent = shoppers.get(n);
    const enter = agent?.segs[0]?.t0 ?? first.t1 + 20;
    const exit = agent ? (agent.segs[agent.segs.length - 1] as AgentTrace['segs'][number]).t1 : last.t0 + 10;
    const r = hash01(n, 2);
    out.push({ id: `C${n}`, kind: 'shopper', label: `顾客 ${n} 的车`, arrive: first.t1, leave: last.t0, enter, exit, ref: a.id, shopper: n, seed: hash01(n, 3), ev: r < 0.09, accessible: r > 0.975 });
    const hk = Math.max(0, Math.min(25, Math.floor(enter / 3600)));
    hourly[hk] = (hourly[hk] as number) + 1;
  }

  // 百货日用馆的顾客：每小时按 StoreX 顾客车辆的量的一个比例，逛 15–45 分钟
  const share = o.deptShare ?? 0.55;
  const rd = rng(o.seed * 31 + 7);
  let k = 0;
  for (let h = 7; h < 22; h++) {
    const n = Math.round((hourly[h] as number) * share + (rd() - 0.5) * 2);
    for (let j = 0; j < n; j++) {
      const enter = h * 3600 + rd() * 3600;
      const dwell = (15 + rd() * 30) * 60;
      const exit = Math.min(22.4 * 3600, enter + dwell);
      const r = rd();
      out.push({ id: `B${++k}`, kind: 'dept', label: `百货馆顾客 ${k} 的车`, arrive: enter - 90, leave: exit + 120, enter, exit, seed: rd(), ev: r < 0.09, accessible: r > 0.98 });
    }
  }

  // 员工：StoreX 排班员工的在岗时段，加上百货馆的两班；约六成开车
  const drive = o.staffDrive ?? 0.6;
  const shifts: { id: string; label: string; on: number; off: number }[] = [];
  for (const a of agents) {
    if (!a.on || a.on.length < 2) continue;
    const start = a.on[0] as number;
    const endRaw = a.on[a.on.length - 1] as number;
    const end = Number.isFinite(endRaw) ? endRaw : 22.5 * 3600;
    if (hash01(a.id, 4) > drive) continue;
    shifts.push({ id: `E${a.id}`, label: `${a.label}（员工）的车`, on: start, off: end });
  }
  const rs = rng(o.seed * 17 + 3);
  for (let j = 0; j < 14; j++) {
    const early = j < 8;
    if (rs() > drive + 0.1) continue;
    const on = (early ? 8.25 : 13) * 3600 + Math.floor(rs() * 4) * 900;
    shifts.push({ id: `EB${j}`, label: `百货馆员工 ${j + 1} 的车`, on, off: on + 8.5 * 3600 });
  }
  for (const s of shifts) {
    const r = hash01(s.id.length * 977 + s.on, 5);
    out.push({ id: s.id, kind: 'staff', label: s.label, arrive: s.on - (8 + r * 9) * 60, leave: s.off + (4 + r * 8) * 60, seed: r });
  }

  // 房车和拖车：前一晚停着、早上开走；关门前到、停到第二天；白天来去几辆
  const rl = rng(o.seed * 13 + 11);
  out.push({ id: 'RV0', kind: 'rv', label: '房车（前一晚停着）', arrive: -3 * 3600, leave: (8.3 + rl() * 0.8) * 3600, seed: rl() });
  out.push({ id: 'RV1', kind: 'rv', label: '房车（停到明天早上）', arrive: (21.2 + rl() * 0.6) * 3600, leave: 26.5 * 3600, seed: rl() });
  const day: CarKind[] = ['camper', 'boat', 'utility', 'rv', 'utility'];
  const nDay = 3 + Math.floor(rl() * 3);
  for (let j = 0; j < nDay; j++) {
    const kind = day[j % day.length] as CarKind;
    const arrive = (9.5 + rl() * 8) * 3600;
    out.push({ id: `L${j}`, kind, label: kind === 'rv' ? '房车' : kind === 'camper' ? '拖着房车的车' : kind === 'boat' ? '拖着小艇的车' : '拖着小平板拖车的车', arrive, leave: arrive + (20 + rl() * 50) * 60, seed: rl() });
  }
  return out.sort((a, b) => a.arrive - b.arrive || (a.id < b.id ? -1 : 1));
}

export const KIND_LABEL: Record<CarKind, string> = {
  pickup: '车边交付',
  locker: '自提柜取货',
  drive: '免下车取货',
  shopper: '购物',
  dept: '百货馆购物',
  staff: '员工',
  rv: '房车',
  camper: '拖挂房车',
  boat: '船拖车',
  utility: '平板拖车',
};
export const isLong = (k: CarKind): k is 'rv' | 'camper' | 'boat' | 'utility' => k === 'rv' || k === 'camper' || k === 'boat' || k === 'utility';
export const isPickup = (k: CarKind): k is 'pickup' | 'locker' | 'drive' => k === 'pickup' || k === 'locker' || k === 'drive';
