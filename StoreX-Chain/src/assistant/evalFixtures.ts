import { tallyOccupancy, type HubDay, type HubFlow, type HubZone } from '../hub/types';
import { STORE } from '../region/network';
import type { Board } from '../sim/board';

/**
 * 评测和测试用的仓储中心作业计划（合成的，按固定的随机种子，每次一样）。
 *
 * 真正的计划由各设施的作业模型给（src/hub/、src/site/）；值班助手的仓储中心工具按 src/hub/types.ts 的约定写，
 * 这里按同样的约定合成四份：港口物流中心（堆场、闸口排队、拆装箱库、保税库、查验场、拆装箱月台、集卡停车场）、
 * 机场货站（ULD 立体库、拆组板区、冷库、散货库、陆侧月台和排队车道）、物流园（铁路堆场、转运仓、月台、闸口排队、甩挂区）、
 * 门店（顾客车位、线上取货车位、收货排队车道、收货口）。车按先到先服务、按门数排队，排队的时段和月台的时段对得上；
 * 本店的箱、板、车用调度台里真实的作业编号（船、航班、班列、提箱车、门店到货车），追踪本店的货时能接上后面的作业。
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const H = 3600;

/** 一串车：到达时刻、在月台作业多久 → 先到先服务排队，生成「排队 → 月台」两步 */
function trucks(r: () => number, n: number, doors: number, opts: { prefix: string; label: (i: number) => string; queue: string; dock: string; peak: number; spread: number; svc: [number, number]; cold?: (i: number) => boolean; after?: { zone: string; min: number } }): HubFlow[] {
  const arr = Array.from({ length: n }, (_, i) => {
    // 两个高峰叠一个平底：上午的峰、下午小一点的峰
    const u = r();
    const base = u < 0.6 ? opts.peak + (r() + r() + r() - 1.5) * opts.spread : u < 0.85 ? opts.peak + 6 * H + (r() + r() - 1) * opts.spread : 5 * H + r() * 15 * H;
    return { i, a: Math.round(Math.max(4 * H, Math.min(22 * H, base)) / 60) * 60, s: Math.round((opts.svc[0] + r() * (opts.svc[1] - opts.svc[0])) / 60) * 60 };
  }).sort((x, y) => x.a - y.a || x.i - y.i);
  const free = new Array<number>(doors).fill(0);
  return arr.map(({ i, a, s }) => {
    let j = 0;
    for (let k = 1; k < doors; k++) if ((free[k] as number) < (free[j] as number)) j = k;
    // 过闸登记 1 分钟，然后等空出来的门
    const start = Math.max(a + 60, free[j] as number);
    free[j] = start + s;
    const cold = opts.cold?.(i) ?? false;
    const steps: HubFlow['steps'] = [];
    steps.push({ zone: opts.queue, t0: a, t1: start, act: start > a + 60 ? '排队等月台' : '过闸、登记' });
    steps.push({ zone: opts.dock, t0: start, t1: start + s, act: '靠台装卸' });
    if (opts.after) steps.push({ zone: opts.after.zone, t0: start + s, t1: start + s + opts.after.min * 60, act: '出场' });
    return { id: `${opts.prefix}${String(i + 1).padStart(3, '0')}`, label: `${opts.label(i)}${cold ? '（冷链）' : ''}`, own: false, units: 1, unit: '车', steps };
  });
}

function day(key: HubDay['key'], label: string, zones: HubZone[], flows: HubFlow[], kpi: HubDay['kpi'], notes: string[]): HubDay {
  return { key, label, zones, flows, occupancy: tallyOccupancy(zones, flows), kpi, notes };
}

/** 四份合成的作业计划；board 给了就用里面真实的作业编号接上本店的货 */
export function fixtureHubs(board?: Board): HubDay[] {
  const op = (kind: string, k = 0) => board?.ops.filter((o) => o.kind === kind)[k];
  const vessel = op('vessel')?.id ?? 'VS1';
  const train = op('train')?.id ?? 'TR1';
  // 本店的箱：今天有提箱车就接上它（提箱车出发时离开堆场），没有就在堆场里等明天提箱（进口箱平均停 1.6 天）
  const drayOp = op('drayage');
  // 本店的集装板：落地的航班 → 空运冷藏车；冷藏车比航班早走的（前一晚的航班）就不接
  const airTruckOp = op('airTruck');
  const flightOp = board?.ops.filter((o) => o.kind === 'flight').find((o) => airTruckOp && (o.arrive ?? o.t0) < (airTruckOp.depart ?? airTruckOp.t0));
  const flight = flightOp?.id ?? op('flight')?.id ?? 'FL1';
  const land = flightOp ? (flightOp.arrive ?? flightOp.t0) : 4 * H;
  const truckGo = airTruckOp && flightOp ? (airTruckOp.depart ?? airTruckOp.t0) : 8 * H;

  // —— 港口物流中心 ——
  let r = rng(11);
  const pz: HubZone[] = [
    { key: 'cy', label: '集装箱堆场', kind: 'storage', capacity: 2400, unit: '箱' },
    { key: 'gateq', label: '闸口排队车道', kind: 'queue', capacity: 20, unit: '车' },
    { key: 'cfs', label: '拆装箱库', kind: 'storage', capacity: 900, unit: '板' },
    { key: 'bonded', label: '保税库', kind: 'bonded', capacity: 3000, unit: '板' },
    { key: 'inspect', label: '查验场', kind: 'inspection', capacity: 12, unit: '箱' },
    { key: 'cfsdock', label: '拆装箱月台', kind: 'dock', capacity: 14, unit: '樘' },
  ];
  const pf: HubFlow[] = [
    { id: 'CY-STOCK', label: '堆场里的进出口箱', own: false, units: 1500, unit: '箱', steps: [{ zone: 'cy', t0: 0, t1: 26 * H, act: '堆存' }] },
    { id: 'CY-VESSEL', label: `${vessel} 卸下的箱`, own: false, units: 420, unit: '箱', steps: [{ zone: 'cy', t0: 6 * H, t1: 26 * H, act: '卸船后堆存' }], carrierIn: vessel },
    { id: 'CY-OUT', label: '提走的进口箱', own: false, units: 300, unit: '箱', steps: [{ zone: 'cy', t0: 0, t1: 12 * H, act: '等提箱' }] },
    { id: 'CFS-LCL', label: '拼箱货（拆箱后待提）', own: false, units: 520, unit: '板', steps: [{ zone: 'cfs', t0: 0, t1: 16 * H, act: '拆箱后暂存' }] },
    { id: 'CFS-NEW', label: `${vessel} 的拼箱货`, own: false, units: 310, unit: '板', steps: [{ zone: 'cfs', t0: 9 * H, t1: 26 * H, act: '拆箱后暂存' }], carrierIn: vessel },
    { id: 'BONDED', label: '保税存货', own: false, units: 2350, unit: '板', steps: [{ zone: 'bonded', t0: 0, t1: 26 * H, act: '保税存放' }] },
    { id: 'INSP-1', label: '查验箱', own: false, units: 7, unit: '箱', steps: [{ zone: 'inspect', t0: 8 * H, t1: 13 * H, act: '海关查验' }] },
  ];
  pf.push(...trucks(r, 110, 14, { prefix: 'PT', label: (i) => `集卡 PT${String(i + 1).padStart(3, '0')}`, queue: 'gateq', dock: 'cfsdock', peak: 9.5 * H, spread: 1.6 * H, svc: [25 * 60, 45 * 60], cold: (i) => i % 9 === 0 }));
  for (let k = 0; k < 3; k++) {
    const t0 = 6 * H + k * 900;
    const insp = k === 1;
    const out = drayOp ? (drayOp.depart ?? drayOp.t0) : 26 * H;
    pf.push({ id: `OWN-BOX-${k + 1}`, label: `本店的箱 OWN-BOX-${k + 1}`, own: true, units: 1, unit: '箱', carrierIn: vessel, ...(drayOp ? { carrierOut: drayOp.id } : {}), steps: insp ? [{ zone: 'cy', t0, t1: 9 * H, act: '卸船后堆存' }, { zone: 'inspect', t0: 9 * H, t1: 10.5 * H, act: '海关查验（抽中）' }, { zone: 'cy', t0: 10.5 * H, t1: Math.max(10.5 * H + 600, out), act: drayOp ? '查验放行，等提箱' : '查验放行，等明天提箱' }] : [{ zone: 'cy', t0, t1: Math.max(t0 + 600, out), act: drayOp ? '卸船后堆存，等提箱' : '卸船后堆存，等明天提箱' }] });
  }
  const port = day('port', '港口物流中心', pz, pf, [{ key: 'turn', label: '集卡平均在港时间', value: 47, unit: '分钟', better: 'lower' }, { key: 'insp', label: '查验比例', value: 4.5, unit: '%', better: 'lower' }, { key: 'cfsDwell', label: '拆箱库平均停留', value: 2.4, unit: '天', better: 'lower' }], ['上午拆装箱月台前排队最长']);

  // —— 机场货站 ——
  r = rng(23);
  const az: HubZone[] = [
    { key: 'etv', label: 'ULD 立体库', kind: 'storage', capacity: 160, unit: 'ULD' },
    { key: 'bd', label: '拆组板区', kind: 'work', capacity: 12, unit: 'ULD' },
    { key: 'cold', label: '冷库（2–8 °C）', kind: 'cold', capacity: 120, unit: '板' },
    { key: 'bulk', label: '散货库', kind: 'storage', capacity: 600, unit: '板' },
    { key: 'lq', label: '陆侧排队车道', kind: 'queue', capacity: 8, unit: '车' },
    { key: 'ldock', label: '陆侧月台', kind: 'dock', capacity: 6, unit: '樘' },
  ];
  const af: HubFlow[] = [
    { id: 'ETV-STOCK', label: '立体库里的出口板', own: false, units: 70, unit: 'ULD', steps: [{ zone: 'etv', t0: 0, t1: 20 * H, act: '等装机' }] },
    { id: 'ETV-IN', label: `${flight} 卸下的板`, own: false, units: 48, unit: 'ULD', steps: [{ zone: 'etv', t0: 4 * H, t1: 9 * H, act: '等拆板' }], carrierIn: flight },
    { id: 'COLD-STOCK', label: '冷库里的进口生鲜', own: false, units: 74, unit: '板', steps: [{ zone: 'cold', t0: 3 * H, t1: 12 * H, act: '冷藏待提' }], carrierIn: flight },
    { id: 'BULK', label: '散货', own: false, units: 380, unit: '板', steps: [{ zone: 'bulk', t0: 0, t1: 26 * H, act: '存放' }] },
  ];
  af.push(...trucks(r, 48, 6, { prefix: 'AF', label: (i) => `货车 AF${String(i + 1).padStart(3, '0')}`, queue: 'lq', dock: 'ldock', peak: 7 * H, spread: 1.4 * H, svc: [20 * 60, 40 * 60], cold: (i) => i % 3 === 0 }));
  for (let k = 0; k < 2; k++) {
    // 落地后 20 分钟进立体库、拆板 45 分钟，进冷库，冷藏车出发前 30 分钟装车（时间不够时按比例压缩）
    const span = Math.max(1800, truckGo - land);
    const a0 = land + Math.min(1200, span * 0.15) + k * 300;
    const a1 = a0 + Math.min(2700, span * 0.3);
    const a2 = Math.max(a1 + 300, truckGo - Math.min(1800, span * 0.2));
    af.push({ id: `OWN-ULD-${k + 1}`, label: `本店的集装板 OWN-ULD-${k + 1}`, own: true, units: 1, unit: 'ULD', carrierIn: flight, ...(airTruckOp && flightOp ? { carrierOut: airTruckOp.id } : {}), steps: [{ zone: 'etv', t0: land, t1: a0, act: '卸机入库' }, { zone: 'bd', t0: a0, t1: a1, act: '拆板、核对' }, { zone: 'cold', t0: a1, t1: a2, act: '进冷库等冷藏车' }, { zone: 'ldock', t0: a2, t1: Math.max(a2 + 300, truckGo), act: '装上冷藏车' }] });
  }
  const airport = day('airport', '机场货站', az, af, [{ key: 'bdTime', label: '拆板平均用时', value: 42, unit: '分钟', better: 'lower' }, { key: 'coldUse', label: '冷库平均占用', value: 61, unit: '%', better: 'lower' }], ['清晨航班落地后冷库最满']);

  // —— 物流园 ——
  r = rng(37);
  const kz: HubZone[] = [
    { key: 'rail', label: '铁路堆场', kind: 'storage', capacity: 300, unit: '箱' },
    { key: 'trans', label: '转运仓', kind: 'storage', capacity: 2400, unit: '板' },
    { key: 'gq', label: '园区闸口排队', kind: 'queue', capacity: 20, unit: '车' },
    { key: 'dock', label: '转运仓月台', kind: 'dock', capacity: 16, unit: '樘' },
    { key: 'drop', label: '甩挂区', kind: 'parking', capacity: 60, unit: '挂' },
  ];
  const kf: HubFlow[] = [
    { id: 'RAIL-STOCK', label: '铁路堆场的箱', own: false, units: 160, unit: '箱', steps: [{ zone: 'rail', t0: 0, t1: 26 * H, act: '堆存' }] },
    { id: 'RAIL-IN', label: `${train} 卸下的箱`, own: false, units: 84, unit: '箱', steps: [{ zone: 'rail', t0: 7 * H, t1: 18 * H, act: '卸车后堆存' }], carrierIn: train },
    { id: 'TRANS', label: '转运仓存货', own: false, units: 1600, unit: '板', steps: [{ zone: 'trans', t0: 0, t1: 26 * H, act: '存放' }] },
    { id: 'DROP', label: '甩下的挂车', own: false, units: 41, unit: '挂', steps: [{ zone: 'drop', t0: 0, t1: 26 * H, act: '等装卸' }] },
  ];
  kf.push(...trucks(r, 120, 16, { prefix: 'KT', label: (i) => `货车 KT${String(i + 1).padStart(3, '0')}`, queue: 'gq', dock: 'dock', peak: 8 * H, spread: 2 * H, svc: [30 * 60, 60 * 60] }));
  kf.push({ id: 'OWN-RAIL-1', label: '本店的箱 OWN-RAIL-1', own: true, units: 1, unit: '箱', carrierIn: train, steps: [{ zone: 'rail', t0: 7 * H, t1: 9.5 * H, act: '卸车后堆存' }, { zone: 'drop', t0: 9.5 * H, t1: 10.5 * H, act: '放上底盘车，等短驳去配送中心' }] });
  const park = day('park', '物流园', kz, kf, [{ key: 'turn', label: '货车平均在园时间', value: 62, unit: '分钟', better: 'lower' }, { key: 'drop', label: '甩挂比例', value: 34, unit: '%', better: 'higher' }], ['早上园区闸口排队']);

  // —— 门店：到货车用调度台里真实的作业（到店、开始卸货、卸完） ——
  r = rng(41);
  const sz: HubZone[] = [
    { key: 'lot', label: '顾客车位', kind: 'parking', capacity: 220, unit: '车位' },
    { key: 'pickup', label: '线上取货车位', kind: 'parking', capacity: 16, unit: '车位' },
    { key: 'yq', label: '收货排队车道', kind: 'queue', capacity: 3, unit: '车' },
    { key: 'docks', label: '收货口', kind: 'dock', capacity: 4, unit: '樘' },
  ];
  const sf: HubFlow[] = [];
  for (let h = 7; h < 22; h++) sf.push({ id: `LOT-${h}`, label: `${h} 点的顾客车`, own: false, units: Math.round(60 + 110 * Math.sin(((h - 7) / 15) * Math.PI) + r() * 20), unit: '车位', steps: [{ zone: 'lot', t0: h * H, t1: (h + 1) * H, act: '停车购物' }] });
  for (let k = 0; k < 90; k++) {
    const a = Math.round((8 * H + r() * 13 * H) / 60) * 60;
    sf.push({ id: `PU-${k + 1}`, label: `取货车 PU-${k + 1}`, own: false, units: 1, unit: '车位', steps: [{ zone: 'pickup', t0: a, t1: a + Math.round((180 + r() * 360) / 60) * 60, act: '等员工送货到车' }] });
  }
  for (const o of board?.ops ?? [])
    for (const s of o.stops ?? []) {
      if (s.key !== STORE.key) continue;
      const steps: HubFlow['steps'] = [];
      if (s.start > s.arrive + 60) steps.push({ zone: 'yq', t0: s.arrive, t1: s.start, act: '排队等收货口' });
      steps.push({ zone: 'docks', t0: Math.max(s.arrive, s.start), t1: Math.max(s.end, s.start + 60), act: '卸货' });
      sf.push({ id: o.id, label: `${o.id} ${o.label.replace(/ · .*$/, '')}`, own: true, units: 1, unit: '车', carrierIn: o.id, steps });
    }
  const store = day('store', `${STORE.name}停车场和收货场`, sz, sf, [{ key: 'pickupWait', label: '取货平均等待', value: 4.6, unit: '分钟', better: 'lower' }], ['中午顾客车位最满']);
  return [port, airport, park, store];
}
