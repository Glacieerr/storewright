import { crewOf, shiftOf } from '../facility/config';
import { currentFacilities } from '../facility/state';
import type { WVehicle } from '../sim/trace';
import { planAirTerminal, standLayout, terminalLayout, type AirTermInput, type AirTermPlan } from './airport';
import type { HubDay } from './types';

/**
 * 机场货站一天的作业（估算）：没有三维的地方（孪生服务、命令行）用。
 *
 * 网页里当天的货运航班由三维的机坪排（web/src/three/ops/airport.ts：跑道起降间隔、机位、平台车和板车一串串往返），
 * 板进出货站的时刻是按这些动作算出来的；这里不排机坪，按同样的规则估一份：
 * - 本店的货运航班：区域车辆里 kind = plane 的，接地、卸货的时段照仿真；
 * - 其他货运航班：按机位数和负荷档位定班数（平常机位约六成时间有飞机，负荷越高越密），落地时刻在全天（含前一天晚上落地的）撒开，
 *   三种机型、过站 1.6–3.6 小时；机位按先到先占排（前一架走了 15 分钟以后才能进，排不上的这一班不算）；
 * - 板的进出：靠上机位 10 分钟后开始卸，每串板车 4 块、约 12 分钟一串，进口板一块块推进货站；出口板在撤轮挡前 75 分钟开始送出；
 * - 本店的空运冷藏车：在货站装车的时段照仿真（不排陆侧卡车场，靠上、拉出的时刻按仿真的时段）。
 * 货站里面（存进板架、拆组板、冷库、陆侧收货口的车）照样由 planAirTerminal 排。所以数是估的：班次、板数的量级和网页一样，
 * 具体到某一块板的时刻和网页会差几分钟到几十分钟。同一组输入每次排出来一样。
 */
export interface AirEstimateInput {
  vehicles: readonly WVehicle[];
  seed: number;
  /** 背景流量倍数（负荷档位的 traffic：平常 1） */
  traffic?: number;
  /** 仿真车辆 → 调度台的作业编号（本店的航班、空运冷藏车按它写 carrierIn / carrierOut，值班助手按作业编号接到那一趟车上） */
  idOf?: (vid: number) => string | undefined;
}

export interface AirEstimate {
  input: AirTermInput;
  plan: AirTermPlan;
  hub: HubDay;
  /** 排不上机位、没算进来的其他航班 */
  dropped: number;
}

const H = 3600;
/** 三种机型：每班几个集装器、过站几小时（和网页的机型表一样） */
const KINDS = [
  { name: '四发重型货机', ulds: 30, ground: [2.6, 3.6] },
  { name: '双发宽体货机', ulds: 26, ground: [2.2, 3.2] },
  { name: '双发中型货机', ulds: 18, ground: [1.6, 2.5] },
] as const;
const TAXI_IN = 6 * 60;
const STAND_GAP = 15 * 60;
const UNLOAD_LEAD = 10 * 60;
const TRAIN = 4;
const TRAIN_EVERY = 12 * 60;
const TRAIN_RUN = 6 * 60;
const EXPORT_LEAD = 75 * 60;

/** 小的确定性随机数（mulberry32） */
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const hhmm = (t: number) => {
  const m = Math.round(t / 60);
  const d = (((m % 1440) + 1440) % 1440);
  return `${String(Math.floor(d / 60)).padStart(2, '0')}${String(d % 60).padStart(2, '0')}${t < 0 ? '-1' : ''}`;
};

export function estimateAirDay(input: AirEstimateInput): AirEstimate {
  const traffic = input.traffic ?? 1;
  const cfg = currentFacilities().airport;
  const { docks, x1 } = standLayout(cfg.stands ?? 2);
  const layout = terminalLayout(docks, x1);
  const stands = docks.length;
  const N = Math.max(4, Math.min(28, Math.round(cfg.uldsPerFlight)));
  type Spec = { id: string; label: string; own: boolean; vid?: number; land: number; ground: number; tOff?: number; nIn: number; nOut: number };
  const specs: Spec[] = [];
  for (const v of input.vehicles) {
    if (v.kind !== 'plane') continue;
    const seg = (a: string) => v.segs.find((sg) => sg.act === a);
    const gnd = seg('卸货');
    const land = seg('减速')?.t0 ?? seg('进近降落')?.t1 ?? (gnd ? gnd.t0 - 0.15 * H : undefined);
    if (land === undefined) continue;
    specs.push({ id: `V${v.id}`, label: v.label, own: true, vid: v.id, land, ground: 0, ...(gnd ? { tOff: gnd.t1 } : {}), nIn: N, nOut: Math.round(N * 0.7) });
  }
  const own = specs.length;
  const r = rand(input.seed * 977 + 13 + stands * 7919);
  const util = Math.min(0.9, 0.62 + 0.15 * Math.max(0, traffic - 1));
  const want = Math.max(3, Math.round((stands * 24 * util) / 2.6) - own);
  const span0 = -5 * H;
  const step = (23.7 * H - span0) / want;
  for (let k = 0; k < want; k++) {
    const land = span0 + (k + 0.2 + 0.6 * r()) * step;
    const u = r();
    const K = KINDS[u < 0.3 ? 0 : u < 0.75 ? 1 : 2];
    const ground = (K.ground[0] + r() * (K.ground[1] - K.ground[0])) * H;
    specs.push({ id: `B${hhmm(land)}`, label: `其他货运航班 · ${K.name}`, own: false, land, ground, nIn: Math.round(K.ulds * (0.55 + 0.4 * r())), nOut: Math.round(K.ulds * (0.45 + 0.4 * r())) });
  }
  // 机位：本店的航班先占，其他航班按落地先后，前一架撤轮挡 15 分钟以后才能进
  const free = new Array<number>(stands).fill(-Infinity);
  const flights: AirTermInput['flights'] = [];
  let dropped = 0;
  const order = specs.map((_, i) => i).sort((a, b) => Number((specs[b] as Spec).own) - Number((specs[a] as Spec).own) || (specs[a] as Spec).land - (specs[b] as Spec).land);
  const placed: { sp: Spec; tOn: number; tOff: number; stand: number }[] = [];
  const busy: [number, number][][] = Array.from({ length: stands }, () => []);
  for (const i of order) {
    const sp = specs[i] as Spec;
    const tOn = sp.land + TAXI_IN;
    const tOff = Math.max(tOn + 30 * 60, sp.tOff ?? tOn + sp.ground);
    let stand = -1;
    for (let j = 0; j < stands; j++) if ((busy[j] as [number, number][]).every(([a, b]) => tOn >= b + STAND_GAP || tOff + STAND_GAP <= a)) {
      stand = j;
      break;
    }
    if (stand < 0) {
      if (sp.own) stand = free.indexOf(Math.min(...free));
      else {
        dropped++;
        continue;
      }
    }
    (busy[stand] as [number, number][]).push([tOn, tOff]);
    free[stand] = Math.max(free[stand] as number, tOff);
    placed.push({ sp, tOn, tOff, stand });
  }
  placed.sort((a, b) => a.sp.land - b.sp.land);
  // 本店的空运冷藏车，以及每班本店航班上有几块是本店的板（这班落地以后、下一班落地以前装车的冷藏车装几板，约 4 板一个集装器）
  const ownTrucks: AirTermInput['ownTrucks'] = [];
  const ownPallets = new Map<string, number>();
  const ownFlights = placed.filter((p) => p.sp.own);
  for (const v of input.vehicles) {
    const sg = v.segs.find((x) => x.act === '在机场货站装车');
    if (!sg) continue;
    const pallets = Number(/(\d+) 托/.exec(v.label)?.[1] ?? 10);
    ownTrucks.push({ id: /AT-\d+/.exec(v.label)?.[0] ?? `AT-${ownTrucks.length + 1}`, label: v.label, vid: v.id, t0: sg.t0, t1: sg.t1, pallets });
    const f = [...ownFlights].reverse().find((p) => p.sp.land < sg.t0);
    if (f) ownPallets.set(f.sp.id, (ownPallets.get(f.sp.id) ?? 0) + pallets);
  }
  const arrivals: AirTermInput['arrivals'] = [];
  const departures: AirTermInput['departures'] = [];
  for (const { sp, tOn, tOff, stand } of placed) {
    flights.push({ id: sp.id, label: sp.label, own: sp.own, tOn, tOff, stand, land: sp.land });
    const mine = sp.own ? Math.max(1, Math.min(sp.nIn, Math.ceil((ownPallets.get(sp.id) ?? 0) / 4))) : 0;
    for (let u = 0; u < sp.nIn; u++) {
      const t = tOn + UNLOAD_LEAD + Math.floor(u / TRAIN) * TRAIN_EVERY + TRAIN_RUN + (u % TRAIN) * 50;
      if (t >= tOff) break;
      arrivals.push({ id: `${sp.id}-I${u + 1}`, flight: sp.id, own: u < mine, lane: stand, t });
    }
    for (let u = 0; u < sp.nOut; u++) {
      const t = Math.max(tOn, tOff - EXPORT_LEAD) + Math.floor(u / TRAIN) * TRAIN_EVERY + (u % TRAIN) * 50;
      if (t >= tOff - 10 * 60) break;
      departures.push({ id: `${sp.id}-E${u + 1}`, flight: sp.id, lane: stand, t });
    }
  }
  const hourOf = (t: number) => (((t / H) % 24) + 24) % 24;
  const staff = cfg.staff;
  const termIn: AirTermInput = { seed: input.seed, traffic, layout, flights, arrivals, departures, ownTrucks, crew: (t) => crewOf(staff, 'build', shiftOf(hourOf(t))) };
  const plan = planAirTerminal(termIn);
  return { input: termIn, plan, hub: withIds(plan, input.idOf), dropped };
}

/** 本店的航班（V + 车辆编号）和空运冷藏车改写成调度台的作业编号（和网页的 hub(idOf) 一样） */
function withIds(plan: AirTermPlan, idOf: ((vid: number) => string | undefined) | undefined): HubDay {
  const hub = plan.hub;
  if (!idOf) return hub;
  const ids = new Map<string, string>();
  for (const tr of plan.trucks)
    if (tr.own && tr.vid !== undefined) {
      const id = idOf(tr.vid);
      if (id) ids.set(tr.id, id);
    }
  for (const f of hub.flows) {
    for (const x of [f.carrierIn, f.carrierOut]) {
      const m = x !== undefined ? /^V(\d+)$/.exec(x) : null;
      const id = m ? idOf(Number(m[1])) : undefined;
      if (m && id) ids.set(x as string, id);
    }
  }
  const map = (x: string | undefined) => (x !== undefined ? (ids.get(x) ?? x) : x);
  return { ...hub, flows: hub.flows.map((fl) => (ids.has(fl.carrierIn ?? '') || ids.has(fl.carrierOut ?? '') ? { ...fl, ...(fl.carrierIn !== undefined ? { carrierIn: map(fl.carrierIn) } : {}), ...(fl.carrierOut !== undefined ? { carrierOut: map(fl.carrierOut) } : {}) } : fl)) };
}
