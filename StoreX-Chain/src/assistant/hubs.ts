import { HUB_SLOT, HUB_SLOTS, occupancyAt, type HubDay, type HubFlow, type HubKey, type HubZone } from '../hub/types';
import { HARD } from './policy';

/**
 * 仓储中心的查询（港口物流中心、机场货站、物流园、门店停车场和收货场；数据按 src/hub/types.ts 的约定）：
 * 此刻每个区占用多少、本店的货走到哪一步、哪里是瓶颈，以及预约错峰（把还没到的车的到达时段挪一挪，削平月台前的排队）。
 */
export const HUB_LABEL: Record<HubKey, string> = { port: '港口物流中心', airport: '机场货站', park: '物流园', store: '门店停车场和收货场' };
export const HUB_FAC: Record<HubKey, 'port' | 'air' | 'dc' | 'store'> = { port: 'port', airport: 'air', park: 'dc', store: 'store' };

export interface ZoneNow {
  zone: HubZone;
  now: number;
  util: number;
  /** 此刻在这个区里的件数（作业条数） */
  flows: number;
}

export function zonesNow(day: HubDay, t: number): ZoneNow[] {
  return day.zones.map((zone) => {
    const now = occupancyAt(day, zone.key, t);
    const flows = day.flows.filter((f) => f.steps.some((s) => s.zone === zone.key && s.t0 <= t && t < s.t1)).length;
    return { zone, now, util: zone.capacity > 0 ? now / zone.capacity : 0, flows };
  });
}

type Step = HubFlow['steps'][number];
export interface OwnState {
  hub: HubKey;
  hubLabel: string;
  flow: HubFlow;
  done: Step[];
  cur?: Step;
  next?: Step;
  state: 'coming' | 'in' | 'left';
}

/** 本店的货（或者按编号、载具查的那一件）此刻走到哪一步 */
export function ownStates(days: readonly HubDay[], t: number, query?: string): OwnState[] {
  const q = query?.toUpperCase();
  const out: OwnState[] = [];
  for (const d of days)
    for (const f of d.flows) {
      // 没指定编号时只看货（箱、板、托盘）；本店的车按编号查
      if (q ? ![f.id, f.label, f.carrierIn ?? '', f.carrierOut ?? ''].some((s) => s.toUpperCase().includes(q)) : !f.own || f.unit === '车' || f.unit === '车位') continue;
      if (!f.steps.length) continue;
      const first = f.steps[0] as Step;
      const last = f.steps[f.steps.length - 1] as Step;
      const done = f.steps.filter((s) => s.t1 <= t);
      const cur = f.steps.find((s) => s.t0 <= t && t < s.t1);
      const next = f.steps.find((s) => s.t0 > t);
      out.push({ hub: d.key, hubLabel: d.label, flow: f, done, ...(cur ? { cur } : {}), ...(next ? { next } : {}), state: t < first.t0 ? 'coming' : t >= last.t1 ? 'left' : 'in' });
    }
  return out;
}

export interface Bottleneck {
  zone: HubZone;
  nowUtil: number;
  peakUtil: number;
  peakAt: number;
  /** 超过 85% 的时段（整天的计划；过去的、正在的、要来的都列） */
  windows: [number, number][];
}

/** 一个仓储中心的瓶颈：占用最高的区、停留最久的货、排队最长的时候 */
export function bottlenecks(day: HubDay, t: number): { zones: Bottleneck[]; dwell: { flow: HubFlow; min: number; zone: string }[]; queues: { zone: HubZone; peak: number; at: number }[] } {
  const zones: Bottleneck[] = [];
  for (const z of day.zones) {
    const occ = day.occupancy[z.key];
    if (!occ || z.capacity <= 0) continue;
    let peak = 0;
    let at = 0;
    const windows: [number, number][] = [];
    let open: number | undefined;
    for (let k = 0; k < HUB_SLOTS; k++) {
      const u = (occ[k] as number) / z.capacity;
      if (u > peak) {
        peak = u;
        at = k * HUB_SLOT;
      }
      if (u >= 0.85 && open === undefined) open = k * HUB_SLOT;
      if (u < 0.85 && open !== undefined) {
        windows.push([open, k * HUB_SLOT]);
        open = undefined;
      }
    }
    if (open !== undefined) windows.push([open, HUB_SLOTS * HUB_SLOT]);
    zones.push({ zone: z, nowUtil: occupancyAt(day, z.key, t) / z.capacity, peakUtil: peak, peakAt: at, windows });
  }
  zones.sort((a, b) => b.peakUtil - a.peakUtil);
  const store = new Set(day.zones.filter((z) => z.kind === 'storage' || z.kind === 'cold' || z.kind === 'bonded' || z.kind === 'inspection').map((z) => z.key));
  // 停留最久的：整天都在的库存底数（从 0 点到第二天 2 点）不算
  const dwell = day.flows
    .filter((f) => f.steps.length && !((f.steps[0] as Step).t0 <= 0 && (f.steps[f.steps.length - 1] as Step).t1 >= HUB_SLOTS * HUB_SLOT))
    .map((f) => {
      const steps = f.steps.filter((s) => store.has(s.zone));
      const longest = steps.reduce<Step | undefined>((a, s) => (!a || s.t1 - s.t0 > a.t1 - a.t0 ? s : a), undefined);
      return { flow: f, min: steps.reduce((a, s) => a + (s.t1 - s.t0), 0) / 60, zone: longest?.zone ?? '' };
    })
    .filter((x) => x.min > 0)
    .sort((a, b) => b.min - a.min)
    .slice(0, 3);
  const queues = day.zones
    .filter((z) => z.kind === 'queue')
    .map((zone) => {
      const occ = day.occupancy[zone.key] ?? new Float32Array(HUB_SLOTS);
      let peak = 0;
      let at = 0;
      occ.forEach((v, k) => {
        if (v > peak) {
          peak = v;
          at = k * HUB_SLOT;
        }
      });
      return { zone, peak, at };
    });
  return { zones, dwell, queues };
}

// —— 预约错峰 ——

interface Truck {
  id: string;
  label: string;
  arrive: number;
  service: number;
  cold: boolean;
  movable: boolean;
}
export interface ApptStats {
  /** 排队最多同时几辆、合计等多少分钟、最长等多少分钟 */
  peak: number;
  waitMin: number;
  maxMin: number;
  /** 冷链车最长等多少分钟 */
  coldMaxMin: number;
}
export interface ApptPlan {
  hub: HubKey;
  label: string;
  doors: number;
  trucks: number;
  movable: number;
  before: ApptStats;
  after: ApptStats;
  moves: { id: string; label: string; from: number; to: number; cold: boolean }[];
}

const COLD = /(冷|冻)/;

/** 先到先服务、c 樘门：每辆车等多少秒；排队最多同时几辆、等了多久只数 from 以后才到的车（已经到了的改不了） */
function simulate(trucks: readonly Truck[], arrive: readonly number[], c: number, from = -Infinity): ApptStats & { waits: number[] } {
  const order = trucks.map((_, i) => i).sort((a, b) => (arrive[a] as number) - (arrive[b] as number) || a - b);
  const free = new Array<number>(Math.max(1, c)).fill(-Infinity);
  const waits = new Array<number>(trucks.length).fill(0);
  const ev: [number, number][] = [];
  for (const i of order) {
    let j = 0;
    for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[j] as number)) j = k;
    const a = arrive[i] as number;
    const start = Math.max(a, free[j] as number);
    waits[i] = start - a;
    free[j] = start + (trucks[i] as Truck).service;
    if (start > a && (trucks[i] as Truck).arrive >= from) ev.push([a, 1], [start, -1]);
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let q = 0;
  let peak = 0;
  for (const [, d] of ev) {
    q += d;
    peak = Math.max(peak, q);
  }
  const later = (i: number) => (trucks[i] as Truck).arrive >= from;
  const ws = waits.filter((_, i) => later(i));
  const coldMax = trucks.reduce((m, tr, i) => (tr.cold && later(i) ? Math.max(m, waits[i] as number) : m), 0);
  return { waits, peak, waitMin: ws.reduce((a, w) => a + w, 0) / 60, maxMin: Math.max(0, ...ws) / 60, coldMaxMin: coldMax / 60 };
}

/** a 比 b 好：排队最多同时的车更少，或一样多但合计少等半分钟以上 */
export const better = (a: ApptStats, b: ApptStats) => a.peak < b.peak || (a.peak === b.peak && a.waitMin < b.waitMin - 0.5);

/**
 * 预约错峰：只挪 HARD.apptLeadMin 分钟以后才到的车，冷链车最多 ±HARD.reeferShiftMin 分钟、普通车 ±HARD.truckShiftMin 分钟（按 15 分钟一档）；
 * 每次挑一辆挪了以后「排队最多同时几辆、合计等多少分钟」改进最大的，最多挪 8 辆，每辆最多挪一次；
 * 冷链车挪完以后等待不能超过 HARD.reeferWaitMin 分钟（原来就超过的不能更长）。没有月台、没有车的返回 undefined。
 */
export function planAppointments(day: HubDay, t: number, maxMoves = 8): ApptPlan | undefined {
  const docks = day.zones.filter((z) => z.kind === 'dock');
  const queues = new Set(day.zones.filter((z) => z.kind === 'queue').map((z) => z.key));
  if (!docks.length) return undefined;
  // 车最多的那组月台
  let best: { zone: HubZone; trucks: Truck[] } | undefined;
  for (const zone of docks) {
    const trucks: Truck[] = [];
    for (const f of day.flows) {
      const dockSteps = f.steps.filter((s) => s.zone === zone.key);
      if (!dockSteps.length || !(f.unit === '车' || f.unit === '辆' || f.steps.some((s) => queues.has(s.zone)))) continue;
      const arrive = (f.steps[0] as Step).t0;
      const service = dockSteps.reduce((a, s) => a + (s.t1 - s.t0), 0);
      const cold = COLD.test(f.label) || f.steps.some((s) => day.zones.find((z) => z.key === s.zone)?.kind === 'cold');
      trucks.push({ id: f.id, label: f.label, arrive, service, cold, movable: arrive >= t + HARD.apptLeadMin * 60 });
    }
    if (!best || trucks.length > best.trucks.length) best = { zone, trucks };
  }
  if (!best || !best.trucks.length) return undefined;
  const { zone, trucks } = best;
  const c = Math.max(1, Math.round(zone.capacity));
  const arrive = trucks.map((x) => x.arrive);
  const before = simulate(trucks, arrive, c, t);
  let cur = before;
  const moved = new Set<number>();
  const coldOk = (s: ReturnType<typeof simulate>) => trucks.every((tr, i) => !tr.cold || (s.waits[i] as number) <= Math.max(HARD.reeferWaitMin * 60, before.waits[i] as number));
  for (let step = 0; step < maxMoves; step++) {
    let pick: { i: number; a: number; s: ReturnType<typeof simulate> } | undefined;
    for (let i = 0; i < trucks.length; i++) {
      const tr = trucks[i] as Truck;
      if (!tr.movable || moved.has(i)) continue;
      const w = (tr.cold ? HARD.reeferShiftMin : HARD.truckShiftMin) * 60;
      for (let d = -w; d <= w; d += 900) {
        if (d === 0) continue;
        const a = tr.arrive + d;
        if (a < t + HARD.apptLeadMin * 60 || a >= HUB_SLOTS * HUB_SLOT) continue;
        const trial = [...arrive];
        trial[i] = a;
        const s = simulate(trucks, trial, c, t);
        if (!coldOk(s) || !better(s, pick?.s ?? cur)) continue;
        pick = { i, a, s };
      }
    }
    if (!pick) break;
    arrive[pick.i] = pick.a;
    moved.add(pick.i);
    cur = pick.s;
  }
  const strip = (s: ReturnType<typeof simulate>): ApptStats => ({ peak: s.peak, waitMin: s.waitMin, maxMin: s.maxMin, coldMaxMin: s.coldMaxMin });
  return {
    hub: day.key,
    label: day.label,
    doors: c,
    trucks: trucks.length,
    movable: trucks.filter((x) => x.movable).length,
    before: strip(before),
    after: strip(cur),
    moves: [...moved].sort((a, b) => (trucks[a] as Truck).arrive - (trucks[b] as Truck).arrive).map((i) => ({ id: (trucks[i] as Truck).id, label: (trucks[i] as Truck).label, from: (trucks[i] as Truck).arrive, to: arrive[i] as number, cold: (trucks[i] as Truck).cold })),
  };
}
