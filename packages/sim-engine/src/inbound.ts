import { createRng } from '@storewright/domain';
import { aisleFor, backroomLayout, backroomRoute, floorSpotFor, type BackroomLayout, type StoreModel } from '@storewright/store-config';
import { Simulation } from './kernel';

/**
 * 到货、收货、上架与补货（后仓库存仓库）。
 *
 * 一天中的到货：
 * - 早上一辆配送中心的冷藏半挂车（冷藏、冷冻货），由早班收货员用叉车卸货；
 * - 上午几辆供应商直送的厢式货车（面包、饮料等），用手动液压搬运车卸货，直接送上货架；
 * - 关门后一辆配送中心的长途半挂车（常温货为主），由夜班叉车司机卸货。
 * 每托货卸到收货区点数贴标后，约 45% 直接上货架（当晚补货），其余用叉车放进托盘货架（库存）。
 * 夜班补货员从收货区或货架上的托盘取货（约 40 箱一车），推到对应货架通道逐箱上架；
 * 需要的托盘在高层时，先由叉车放到地面。开门时没上架的箱数即开店缺货风险。
 *
 * 后仓内的移动按叉车通道走直角路线；进入售货区后沿店内行走网络。全部为假设参数，按种子可复现。
 */

export interface InboundParams {
  open: number;
  close: number;
  nextOpen: number;
  nightCrew: number;
  receivers: number;
  totalCases: number;
  /** 夜间常温半挂车、早上冷藏半挂车的托盘数，供应商直送车数 */
  dcPallets: number;
  reeferPallets: number;
  vendorTrucks: number;
  /** 开门时货架库存的初始占用率 */
  initialFill: number;
  directShare: number;
  casesPerLoad: number;
  secPerCase: [number, number];
}

export const DEFAULT_INBOUND = {
  receivers: 2,
  initialFill: 0.55,
  directShare: 0.45,
  casesPerLoad: 40,
  secPerCase: [28, 45] as [number, number],
};

export interface Pt3 {
  x: number;
  z: number;
  y: number;
}

/** 带折线的作业片段（坐标为配置平面坐标：x、z 为平面位置，y 为楼层高度） */
export interface PolySegment {
  t0: number;
  t1: number;
  pts: Pt3[];
  activity: string;
  /** 正在搬运的托盘 id（叉车、搬运车）或「cases」（补货车装着纸箱） */
  carry?: string;
  /** 叉车在货位前举升：目标层高度（米）、托盘、放上去（up）还是取下来（down） */
  lift?: { y: number; pallet: string; mode: 'up' | 'down' };
}

export type WorkerKind = 'forklift' | 'jack' | 'receiver' | 'stocker';

export interface WorkerTrace {
  id: string;
  role: 'receiver' | 'night';
  shifts: Array<[number, number]>;
  segments: PolySegment[];
}

export interface EquipmentTrace {
  id: string;
  kind: 'forklift' | 'jack';
  segments: PolySegment[];
}

export interface PalletRecord {
  id: string;
  runId: string;
  /** 仿真结束时剩余箱数 */
  cases: number;
  /** 进入后仓时的箱数 */
  initialCases: number;
  /** 夜班取货记录：时刻与取走箱数（用于按时刻显示剩余高度） */
  draws: Array<[number, number]>;
  /** 到达收货区的时刻与位置（初始库存为空） */
  receivedAt?: number;
  spot?: { x: number; z: number };
  /** 放进货架的时刻与货位 */
  storedAt?: number;
  location?: string;
  /** 高层放到地面（取货前） */
  letdownAt?: number;
  /** 取完的时刻 */
  emptiedAt?: number;
  direct: boolean;
  truck?: string;
}

export interface Truck {
  id: string;
  kind: 'SEMI' | 'REEFER' | 'BOX';
  label: string;
  arrive: number;
  unloadStart: number;
  leave: number;
  door: number;
  pallets: number;
}

export interface InboundMetrics {
  trucks: number;
  palletsReceived: number;
  avgTurnaroundMin: number;
  /** 从卸货到放进货架或送上货架的平均时间 */
  dockToStockMin: number;
  totalCases: number;
  stockedCases: number;
  backlogCases: number;
  finishAt?: number;
  readyAtOpen: number;
  rackCapacity: number;
  rackUsedStart: number;
  rackUsedEnd: number;
  receivingHours: number;
  nightHours: number;
}

export interface InboundResult {
  trucks: Truck[];
  pallets: PalletRecord[];
  workers: WorkerTrace[];
  equipment: EquipmentTrace[];
  metrics: InboundMetrics;
  /** 上架完成记录 [时刻, 箱数] */
  progress: Array<[number, number]>;
}

const SPEED = 1.5;
const LIFT_SEC = 10;
const SCAN_SEC = 40;

export function simulateInbound(model: StoreModel, runWeights: Record<string, number>, p: InboundParams, seed: number): InboundResult {
  const rng = createRng(seed * 9157 + 31);
  const b: BackroomLayout = backroomLayout(model.config);
  const cfg = model.config;
  const forklifts = cfg.backroom.forklifts;
  const jacks = cfg.backroom.palletJacks;
  const floorY = (id: string) => (cfg.layout.floors.find((f) => f.id === id)?.level ?? 0) * 7;
  const node = (id: number): Pt3 => {
    const n = model.nodes[id];
    return n ? { x: n.x, z: n.y, y: floorY(n.floorId) } : { x: 0, z: 0, y: 0 };
  };
  const flat = (pts: Array<{ x: number; z: number }>): Pt3[] => pts.map((q) => ({ x: q.x, z: q.z, y: 0 }));
  const len3 = (pts: Pt3[]) => {
    let n = 0;
    for (let i = 1; i < pts.length; i++) n += Math.hypot((pts[i] as Pt3).x - (pts[i - 1] as Pt3).x, (pts[i] as Pt3).z - (pts[i - 1] as Pt3).z) + Math.abs((pts[i] as Pt3).y - (pts[i - 1] as Pt3).y) * 0.5;
    return n;
  };

  // ---------- 货架通道的销售权重（决定托盘品类与补货去向） ----------
  const runs = cfg.layout.runs.filter((r) => (model.locationsByRun.get(r.id)?.length ?? 0) > 0);
  const weights = runs.map((r) => Math.max(0.05, runWeights[r.id] ?? 1));
  const wsum = weights.reduce((a, c) => a + c, 0) || 1;
  const pickRun = () => {
    let u = rng.next() * wsum;
    for (let i = 0; i < runs.length; i++) {
      u -= weights[i] as number;
      if (u <= 0) return (runs[i] as (typeof runs)[number]).id;
    }
    return (runs[runs.length - 1] as (typeof runs)[number]).id;
  };

  // ---------- 货位状态 ----------
  const locFree = new Map<string, boolean>(b.locations.map((l) => [l.id, true]));
  const locById = new Map(b.locations.map((l) => [l.id, l]));
  const pallets: PalletRecord[] = [];
  let palletSeq = 0;
  const newPallet = (runId: string, cases: number, direct: boolean, truck?: string): PalletRecord => {
    const pr: PalletRecord = { id: `P${String(++palletSeq).padStart(4, '0')}`, runId, cases, initialCases: cases, draws: [], direct, truck };
    pallets.push(pr);
    return pr;
  };
  // 开门前已在货架上的库存（离主通道近、低层优先）
  const order = [...b.locations].sort((a, c) => a.level - c.level || a.row - c.row || c.x - a.x);
  const initial = Math.round(order.length * p.initialFill);
  // 每个通道至少有一托库存（容量允许时），其余按销售比例随机
  const byWeight = runs.map((r, i) => ({ id: r.id, w: weights[i] as number })).sort((a, c) => c.w - a.w || a.id.localeCompare(c.id));
  for (let i = 0; i < initial; i++) {
    const l = order[i] as (typeof order)[number];
    const runId = i < byWeight.length ? (byWeight[i] as { id: string }).id : pickRun();
    const pr = newPallet(runId, rng.int(30, 60), false);
    pr.location = l.id;
    pr.storedAt = p.open - 3 * 3600;
    locFree.set(l.id, false);
  }
  const rackUsedStart = initial;

  // ---------- 到货车辆 ----------
  const trucks: Truck[] = [];
  const reeferAt = p.open - 90 * 60;
  trucks.push({ id: 'TRUCK-REEFER', kind: 'REEFER', label: '配送中心冷藏半挂车', arrive: reeferAt, unloadStart: reeferAt + 6 * 60, leave: 0, door: 0, pallets: p.reeferPallets });
  for (let k = 0; k < p.vendorTrucks; k++) {
    const at = p.open - 3600 + rng.uniform(0, 5 * 3600);
    trucks.push({ id: `VENDOR-${k + 1}`, kind: 'BOX', label: rng.pick(['面包直送', '饮料直送', '乳品直送', '零食直送', '鲜花直送']), arrive: at, unloadStart: at + 4 * 60, leave: 0, door: Math.min(b.docks.length - 1, 1 + (k % 2)), pallets: rng.int(2, 5) });
  }
  const nightAt = p.close + 20 * 60;
  trucks.push({ id: 'TRUCK-NIGHT', kind: 'SEMI', label: '配送中心长途半挂车', arrive: nightAt, unloadStart: nightAt + 6 * 60, leave: 0, door: Math.min(1, b.docks.length - 1), pallets: p.dcPallets });
  trucks.sort((a, c) => a.arrive - c.arrive);

  // ---------- 人员与设备 ----------
  const workers: WorkerTrace[] = [];
  const recvShift: [number, number] = [p.open - 2 * 3600, p.open + 6.5 * 3600];
  for (let i = 0; i < p.receivers; i++) workers.push({ id: `recv-${i + 1}`, role: 'receiver', shifts: [recvShift], segments: [] });
  for (let i = 0; i < p.nightCrew; i++) workers.push({ id: `night-${i + 1}`, role: 'night', shifts: [[p.close, p.nextOpen]], segments: [] });
  const equipment: EquipmentTrace[] = [
    ...Array.from({ length: forklifts }, (_, i) => ({ id: `FL-${i + 1}`, kind: 'forklift' as const, segments: [] as PolySegment[] })),
    ...Array.from({ length: jacks }, (_, i) => ({ id: `PJ-${i + 1}`, kind: 'jack' as const, segments: [] as PolySegment[] })),
  ];
  const eqFree = new Map(equipment.map((e) => [e.id, true]));
  const pos = new Map<string, Pt3>();
  const home: Pt3 = { x: b.receiving.x1 - 1.5, z: b.receiving.z0 + 1, y: 0 };
  for (const w of workers) pos.set(w.id, { ...home });
  for (const e of equipment) pos.set(e.id, { x: b.receiving.x0 + 1 + equipment.indexOf(e) * 1.6, z: b.receiving.z0 + 0.8, y: 0 });

  // 收货区的落地位置（网格）
  const spots: Array<{ x: number; z: number; taken: boolean }> = [];
  for (let x = b.receiving.x0 + 1.2; x < b.receiving.x1 - 1; x += 1.6) for (let z = b.receiving.z0 + 2.4; z < b.receiving.z1 - 1.5; z += 1.6) spots.push({ x, z, taken: false });

  const sim = new Simulation(Math.min(recvShift[0], reeferAt));
  const docked: Array<{ truck: Truck; remaining: number }> = [];
  const waitingPutaway: PalletRecord[] = [];
  const letdownQueue: PalletRecord[] = [];
  /** 已排队或叉车正在去取的高层托盘（避免重复取下） */
  const letdownPending = new Set<string>();
  const progress: Array<[number, number]> = [];
  let stocked = 0;

  // 补货任务：按通道权重分配需补箱数，每车约 40 箱
  interface RestockTask {
    runId: string;
    cases: number;
    node: number;
  }
  const restock: RestockTask[] = [];
  runs.forEach((r, i) => {
    let cases = Math.round((p.totalCases * (weights[i] as number)) / wsum);
    const locs = model.locationsByRun.get(r.id) ?? [];
    const loads = Math.max(1, Math.ceil(cases / p.casesPerLoad));
    for (let k = 0; cases > 0; k++) {
      const n = Math.min(p.casesPerLoad, cases);
      cases -= n;
      const loc = locs[Math.min(locs.length - 1, Math.floor(((k + 0.5) / loads) * locs.length))];
      restock.push({ runId: r.id, cases: n, node: loc?.nodeId ?? model.backroomNode });
    }
  });
  const totalCases = restock.reduce((n, t) => n + t.cases, 0);
  // 夜间半挂车的配货：托盘数按各通道需补箱数的比例分配（最大余数法），每托箱数 = 该通道需补箱数 ÷ 托盘数
  const demandByRun = new Map<string, number>();
  for (const t of restock) demandByRun.set(t.runId, (demandByRun.get(t.runId) ?? 0) + t.cases);
  const shares = [...demandByRun.entries()].map(([runId, c]) => ({ runId, c, exact: (c / Math.max(1, totalCases)) * p.dcPallets }));
  const counts = new Map(shares.map((x) => [x.runId, Math.floor(x.exact)]));
  let left = p.dcPallets - [...counts.values()].reduce((a, c) => a + c, 0);
  for (const x of [...shares].sort((a, c) => c.exact - Math.floor(c.exact) - (a.exact - Math.floor(a.exact)) || a.runId.localeCompare(c.runId))) {
    if (left <= 0) break;
    counts.set(x.runId, (counts.get(x.runId) ?? 0) + 1);
    left--;
  }
  const nightMix: string[] = [];
  const nightCases = new Map<string, number>();
  for (const [runId, n] of counts) {
    for (let k = 0; k < n; k++) nightMix.push(runId);
    if (n > 0) nightCases.set(runId, Math.min(120, Math.max(20, Math.ceil((demandByRun.get(runId) ?? 0) / n))));
  }
  rng.shuffle(nightMix);
  // 每个通道的货源：先用当晚到的直送托盘，再用货架上的库存
  const sourceFor = (runId: string, t: number): PalletRecord | undefined => {
    const direct = pallets.find((q) => q.runId === runId && q.direct && q.receivedAt !== undefined && q.receivedAt <= t && q.emptiedAt === undefined && q.cases > 0 && q.receivedAt >= p.close - 3600);
    if (direct) return direct;
    return pallets.find((q) => q.runId === runId && q.location !== undefined && q.emptiedAt === undefined && q.cases > 0 && (locById.get(q.location)?.level === 0 || q.letdownAt !== undefined));
  };
  const needsLetdown = (runId: string): PalletRecord | undefined =>
    pallets.find((q) => q.runId === runId && q.location !== undefined && q.emptiedAt === undefined && q.cases > 0 && q.letdownAt === undefined && (locById.get(q.location)?.level ?? 0) > 0);

  const seg = (list: PolySegment[], s: PolySegment) => {
    if (s.t1 > s.t0) list.push(s);
  };
  const onShift = (w: WorkerTrace, t: number) => w.shifts.some(([a, c]) => t >= a && t < c);

  /** 取一台空闲设备（叉车优先，搬运车也可） */
  const takeEquip = (kinds: Array<'forklift' | 'jack'>) => {
    for (const k of kinds) {
      const e = equipment.find((q) => q.kind === k && eqFree.get(q.id));
      if (e) return e;
    }
    return undefined;
  };

  function drive(w: WorkerTrace, e: EquipmentTrace | undefined, pts: Pt3[], activity: string, carry?: string, speed = SPEED): number {
    const t0 = sim.now;
    const dur = len3(pts) / speed;
    seg(w.segments, { t0, t1: t0 + dur, pts, activity, carry });
    if (e) seg(e.segments, { t0, t1: t0 + dur, pts, activity, carry });
    const last = pts[pts.length - 1] as Pt3;
    pos.set(w.id, { ...last });
    if (e) pos.set(e.id, { ...last });
    return dur;
  }

  function next(w: WorkerTrace): void {
    const t = sim.now;
    if (!onShift(w, t)) {
      const nextOn = w.shifts.find(([a]) => a > t)?.[0];
      if (nextOn !== undefined) sim.at(nextOn, () => next(w));
      return;
    }
    const shiftEnd = w.shifts.find(([a, c]) => t >= a && t < c)?.[1] ?? t;
    const here = pos.get(w.id) ?? home;
    // 1. 卸货
    const dockTask = docked.find((d) => d.remaining > 0);
    const eqUnload = dockTask ? takeEquip(dockTask.truck.kind === 'BOX' ? ['jack', 'forklift'] : ['forklift', 'jack']) : undefined;
    if (dockTask && eqUnload) {
      const spot = spots.find((s) => !s.taken);
      if (spot) {
        dockTask.remaining--;
        spot.taken = true;
        eqFree.set(eqUnload.id, false);
        const door = b.docks[dockTask.truck.door] ?? b.docks[0] ?? { x: b.receiving.x1, z: b.receiving.z1 };
        const ePos = pos.get(eqUnload.id) ?? here;
        const isFork = eqUnload.kind === 'forklift';
        // 夜间半挂车按各通道的补货需要配货（配送中心按门店销售补货）；其他车按销售比例随机
        const runId = dockTask.truck.kind === 'SEMI' ? (nightMix.shift() ?? pickRun()) : pickRun();
        const pr = newPallet(runId, dockTask.truck.kind === 'SEMI' ? (nightCases.get(runId) ?? 45) : rng.int(30, 60), dockTask.truck.kind === 'BOX' ? true : rng.chance(p.directShare), dockTask.truck.id);
        // 走到设备旁 → 开到卸货门 → 进车厢叉起托盘 → 开回收货区放下 → 扫码
        let tt = 0;
        if (Math.hypot(here.x - ePos.x, here.z - ePos.z) > 0.5) tt += drive(w, undefined, [here, ePos], isFork ? '去取叉车' : '去取搬运车', undefined, 1.2);
        const toDock = flat([ePos, { x: door.x, z: door.z - 2 }, { x: door.x, z: door.z + 4 }]);
        sim.after(tt, () => {
          let u = drive(w, eqUnload, toDock, isFork ? '叉车进车厢' : '搬运车进车厢');
          const back = flat([{ x: door.x, z: door.z + 4 }, { x: door.x, z: door.z - 2 }, { x: spot.x, z: spot.z }]);
          sim.after(u + LIFT_SEC, () => {
            u = drive(w, eqUnload, back, isFork ? '叉车卸货' : '搬运车卸货', pr.id, isFork ? SPEED : 1.1);
            sim.after(u + LIFT_SEC, () => {
              pr.receivedAt = sim.now;
              pr.spot = { x: spot.x, z: spot.z };
              const t1 = sim.now + SCAN_SEC;
              seg(w.segments, { t0: sim.now, t1, pts: [{ x: spot.x + 0.8, z: spot.z, y: 0 }], activity: '点数贴标' });
              seg(eqUnload.segments, { t0: sim.now, t1, pts: [{ x: spot.x, z: spot.z - 1.2, y: 0 }], activity: '停放' });
              pos.set(eqUnload.id, { x: spot.x, z: spot.z - 1.2, y: 0 });
              pos.set(w.id, { x: spot.x + 0.8, z: spot.z, y: 0 });
              sim.at(t1, () => {
                eqFree.set(eqUnload.id, true);
                if (pr.direct && sim.now < p.close - 3600) {
                  // 白天到的直送货：由白班理货员或供应商人员送上货架（不计入夜班补货）
                  pr.emptiedAt = sim.now + rng.uniform(dockTask.truck.kind === 'BOX' ? 15 : 30, dockTask.truck.kind === 'BOX' ? 40 : 120) * 60;
                  sim.at(pr.emptiedAt, () => {
                    spot.taken = false;
                  });
                } else if (!pr.direct) waitingPutaway.push(pr);
                if (dockTask.remaining === 0 && !docked.some((d) => d !== dockTask && d.remaining > 0)) {
                  dockTask.truck.leave = sim.now + 8 * 60;
                }
                next(w);
              });
            });
          });
        });
        return;
      }
    }
    // 2. 放进货架（只有叉车能放高层）
    const pr = waitingPutaway[0];
    const fork = pr ? takeEquip(['forklift']) : undefined;
    if (pr && fork) {
      const loc = b.locations.filter((l) => locFree.get(l.id)).sort((a, c) => a.level - c.level || Math.abs(a.x - b.mainAisleX) - Math.abs(c.x - b.mainAisleX))[0];
      if (loc) {
        waitingPutaway.shift();
        locFree.set(loc.id, false);
        eqFree.set(fork.id, false);
        const ePos = pos.get(fork.id) ?? here;
        let tt = 0;
        if (Math.hypot(here.x - ePos.x, here.z - ePos.z) > 0.5) tt += drive(w, undefined, [here, ePos], '去取叉车', undefined, 1.2);
        sim.after(tt, () => {
          const spot = pr.spot ?? { x: ePos.x, z: ePos.z };
          let u = drive(w, fork, flat([ePos, spot]), '叉车去叉托盘');
          sim.after(u + LIFT_SEC, () => {
            const sp = spots.find((s) => Math.abs(s.x - spot.x) < 0.01 && Math.abs(s.z - spot.z) < 0.01);
            if (sp) sp.taken = false;
            u = drive(w, fork, flat(backroomRoute(b, spot, loc, aisleFor(loc))), '叉车放进货架', pr.id);
            const lift = LIFT_SEC + loc.level * 8;
            const at: Pt3 = { x: loc.x, z: loc.z, y: 0 };
            const ls: PolySegment = { t0: sim.now + u, t1: sim.now + u + lift, pts: [at], activity: '叉车举升放货', carry: pr.id, lift: { y: loc.y, pallet: pr.id, mode: 'up' } };
            seg(w.segments, ls);
            seg(fork.segments, ls);
            sim.after(u + lift, () => {
              pr.storedAt = sim.now;
              pr.location = loc.id;
              eqFree.set(fork.id, true);
              next(w);
            });
          });
        });
        return;
      }
    }
    // 3. 高层放到地面
    const ld = letdownQueue[0];
    const fork2 = ld ? takeEquip(['forklift']) : undefined;
    if (ld && fork2 && ld.location) {
      letdownQueue.shift();
      const loc = locById.get(ld.location);
      if (loc) {
        eqFree.set(fork2.id, false);
        const ePos = pos.get(fork2.id) ?? here;
        let tt = 0;
        if (Math.hypot(here.x - ePos.x, here.z - ePos.z) > 0.5) tt += drive(w, undefined, [here, ePos], '去取叉车', undefined, 1.2);
        sim.after(tt, () => {
          const u = drive(w, fork2, flat(backroomRoute(b, ePos, loc, aisleFor(loc))), '叉车去高层货位');
          const lift = LIFT_SEC + loc.level * 8;
          const ls: PolySegment = { t0: sim.now + u, t1: sim.now + u + lift, pts: [{ x: loc.x, z: loc.z, y: 0 }], activity: '叉车把高层托盘放到地面', lift: { y: loc.y, pallet: ld.id, mode: 'down' } };
          seg(w.segments, ls);
          seg(fork2.segments, ls);
          sim.after(u + lift, () => {
            ld.letdownAt = sim.now;
            pos.set(fork2.id, { ...floorSpotFor(loc), y: 0 });
            eqFree.set(fork2.id, true);
            next(w);
          });
        });
        return;
      }
    }
    // 4. 补货（夜班）
    if (w.role === 'night' && restock.length) {
      for (let k = 0; k < restock.length; k++) {
        const task = restock[k] as RestockTask;
        const src = sourceFor(task.runId, t);
        if (!src) {
          const up = needsLetdown(task.runId);
          if (up && !letdownPending.has(up.id)) {
            letdownPending.add(up.id);
            letdownQueue.push(up);
          }
          continue;
        }
        restock.splice(k, 1);
        const take = Math.min(task.cases, src.cases);
        src.cases -= take;
        if (task.cases > take) restock.push({ ...task, cases: task.cases - take });
        const loc = src.location ? locById.get(src.location) : undefined;
        // 站在托盘前：货架底层托盘在通道边取，取下的高层托盘在地面上（再往外一点）
        const at: { x: number; z: number } = loc ? floorSpotFor(loc, src.letdownAt !== undefined ? 2.9 : 1.4) : { x: (src.spot ?? home).x, z: (src.spot ?? home).z - 1 };
        // 后仓内走到托盘 → 装车 → 走到后仓出口 → 沿店内网络到货架 → 逐箱上架 → 推空车回来
        const toPallet = flat(backroomRoute(b, here, at, loc ? aisleFor(loc) : undefined));
        const toEntry = flat(backroomRoute(b, at, b.entry));
        const ids = model.path(model.backroomNode, task.node);
        const inStore = (ids.length ? ids : [task.node]).map(node);
        const work = take * rng.uniform(p.secPerCase[0], p.secPerCase[1]);
        const t1 = drive(w, undefined, toPallet, '去托盘取货', undefined, 1.2);
        const load = take * 4;
        if (sim.now + t1 + load + (len3(toEntry) + len3(inStore)) / 0.8 + work > shiftEnd) {
          // 收工前做不完：放回去
          src.cases += take;
          restock.unshift(task);
          w.segments.pop();
          pos.set(w.id, { ...here });
          break;
        }
        seg(w.segments, { t0: sim.now + t1, t1: sim.now + t1 + load, pts: [{ x: at.x, z: at.z, y: 0 }], activity: `装车 ${take} 箱` });
        sim.after(t1 + load, () => {
          src.draws.push([sim.now, take]);
          if (src.cases <= 0) {
            src.emptiedAt = sim.now;
            if (src.location) locFree.set(src.location, true);
            if (src.spot) {
              const sp = spots.find((s) => Math.abs(s.x - (src.spot as { x: number }).x) < 0.01 && Math.abs(s.z - (src.spot as { z: number }).z) < 0.01);
              if (sp) sp.taken = false;
            }
          }
          const go = [...toEntry, ...inStore];
          const u = drive(w, undefined, go, '推货去货架', 'cases', 0.8);
          const end = inStore[inStore.length - 1] as Pt3;
          sim.after(u, () => {
            seg(w.segments, { t0: sim.now, t1: sim.now + work, pts: [end], activity: `上架 ${take} 箱`, carry: 'cases' });
            sim.after(work, () => {
              stocked += take;
              progress.push([sim.now, take]);
              const back = [...[...inStore].reverse(), ...flat(backroomRoute(b, b.entry, home))];
              const v = drive(w, undefined, back, '推空车回后仓', undefined, 0.9);
              sim.after(v, () => next(w));
            });
          });
        });
        return;
      }
    }
    // 没事做：稍后再看
    const idleUntil = Math.min(shiftEnd, t + 120);
    if (idleUntil > t) {
      seg(w.segments, { t0: t, t1: idleUntil, pts: [here], activity: '待命' });
      sim.at(idleUntil, () => next(w));
    }
  }

  // 车辆靠台后开始卸货
  for (const tr of trucks) {
    sim.at(tr.unloadStart, () => {
      docked.push({ truck: tr, remaining: tr.pallets });
    });
  }
  for (const w of workers) sim.at(w.shifts[0]?.[0] ?? sim.now, () => next(w));
  sim.run(p.nextOpen);
  for (const tr of trucks) if (!tr.leave) tr.leave = Math.min(p.nextOpen, tr.unloadStart + tr.pallets * 4 * 60 + 10 * 60);

  progress.sort((a, c) => a[0] - c[0]);
  const received = pallets.filter((q) => q.receivedAt !== undefined);
  const dts = received.map((q) => (((q.storedAt ?? q.emptiedAt ?? q.receivedAt) as number) - (q.receivedAt as number)) / 60).filter((x) => x >= 0);
  const finishAt = restock.length === 0 && progress.length ? (progress[progress.length - 1] as [number, number])[0] : undefined;
  return {
    trucks,
    pallets,
    workers,
    equipment,
    progress,
    metrics: {
      trucks: trucks.length,
      palletsReceived: received.length,
      avgTurnaroundMin: trucks.reduce((n, tr) => n + (tr.leave - tr.arrive), 0) / Math.max(1, trucks.length) / 60,
      dockToStockMin: dts.length ? dts.reduce((a, c) => a + c, 0) / dts.length : 0,
      totalCases,
      stockedCases: stocked,
      backlogCases: totalCases - stocked,
      finishAt,
      readyAtOpen: totalCases > 0 ? stocked / totalCases : 1,
      rackCapacity: b.capacity,
      rackUsedStart,
      rackUsedEnd: [...locFree.values()].filter((f) => !f).length,
      receivingHours: (p.receivers * (recvShift[1] - recvShift[0])) / 3600,
      nightHours: (p.nightCrew * (p.nextOpen - p.close)) / 3600,
    },
  };
}

/** 托盘数的默认值：按门店规模（中型店夜间半挂车约 22 托、早上冷藏车约 8 托） */
export function defaultInboundVolume(staffScale: number): { dcPallets: number; reeferPallets: number; vendorTrucks: number } {
  const k = Math.max(0.3, staffScale);
  return { dcPallets: Math.max(6, Math.round(22 * k)), reeferPallets: Math.max(2, Math.round(8 * k)), vendorTrucks: Math.max(2, Math.min(6, Math.round(4 * Math.sqrt(k)))) };
}

/**
 * 按当天售出估算今晚需要补的箱数：线上订单件数 ÷ 线上占比 → 全店售出件数，
 * 每箱约 12 件，其中约 65% 需要当晚补上（其余货架上还有余量）。
 */
export function estimateRestockCases(onlineUnits: number, onlineShare = 0.15, unitsPerCase = 12, restockShare = 0.65): number {
  return Math.round((onlineUnits / Math.max(0.01, onlineShare) / unitsPerCase) * restockShare);
}

/** 夜班人数的默认值：中型店 6 人，按规模缩放 */
export function defaultNightCrew(staffScale: number): number {
  return Math.max(2, Math.round(6 * staffScale));
}
