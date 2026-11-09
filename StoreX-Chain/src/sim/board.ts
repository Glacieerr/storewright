import { STORES } from '../region/network';
import type { Op, OpStop } from './trace';
import { hhmm, type DayPlan } from './plan';

/**
 * 调度台：把仿真记录的当天作业排到资源上，并检查冲突。
 *
 * - 月台门：配送中心南墙 26 樘干货门（D01–D08 收货、D09–D26 发货）和 12 樘冷链门（C01–C04 收货、C05–C12 发货）。
 *   配送车出发前在门上装车，进货车、集装箱拖车到了在门上卸货；没指定的按「收货门 / 发货门、编号小的先用」自动排；
 * - 车辆：同一辆车跑完一趟、回场半小时以后可以再跑一趟；没指定的按出发先后自动派，不够就加车；
 * - 门店收货口：综合店店后 4 个，配送中心的车和长途直送车共用，先到先用；
 * - 检查：月台门重叠、车辆还没回来就派了下一趟、迟到（过了门店的收货截止）、到早了在门外等、高峰拥堵、
 *   进货赶不上分配（要多放一天）、单趟超过 11 小时。能自动修的问题附带修法（改门、改车、改出发时刻）。
 *
 * 不改变仿真结果：仿真里的时刻是定的，这里只排资源、指出问题；改出发 / 到达时刻要重新仿真。
 */
export type DoorGroup = 'cold' | 'dry';
const pad = (n: number) => String(n).padStart(2, '0');
export const DOORS: Record<DoorGroup, string[]> = {
  cold: Array.from({ length: 12 }, (_, i) => `C${pad(i + 1)}`),
  dry: Array.from({ length: 26 }, (_, i) => `D${pad(i + 1)}`),
};
/** 每组前几樘是收货门 */
export const RECEIVING_DOORS: Record<DoorGroup, number> = { cold: 4, dry: 8 };
/** 换车的间隔（秒）、车辆回场后再出车的间隔 */
const DOOR_GAP = 300;
const TURN = 1800;
/** 门店的收货口个数 */
const storeDocks = (key: string): number => STORES.find((s) => s.key === key)?.docks ?? 2;

export interface Booking {
  door: string;
  op: string;
  t0: number;
  t1: number;
  mode: 'load' | 'unload';
  /** 调度员指定的（不是自动排的） */
  fixed: boolean;
}
export type Fix =
  | { kind: 'door'; op: string; door: string; text: string }
  | { kind: 'unit'; op: string; unit: string; text: string }
  | { kind: 'depart'; key: string; hour: number; text: string }
  | { kind: 'arrive'; key: string; hour: number; text: string };
export interface Issue {
  level: 'error' | 'warn' | 'info';
  code: 'door-conflict' | 'door-full' | 'door-queue' | 'unit-busy' | 'late' | 'wait' | 'peak' | 'cutoff' | 'store-dock' | 'driver' | 'shift';
  title: string;
  text: string;
  ops: string[];
  /** 跳到哪个时刻看（秒） */
  at: number;
  fix?: Fix;
}
export interface Unit {
  id: string;
  cls: UnitClass;
  ops: string[];
  from: number;
  to: number;
}
export type UnitClass = 'ev' | 'multi' | 'reefer' | 'dry' | 'van';
export const UNIT_PREFIX: Record<UnitClass, string> = { ev: 'E', multi: 'M', reefer: 'R', dry: 'T', van: 'B' };
export const UNIT_LABEL: Record<UnitClass, string> = { ev: '电动配送车', multi: '多温区车', reefer: '冷藏冷冻车', dry: '常温车', van: '面包车' };

export interface BoardOp extends Op {
  door?: string;
  /** 实际在门上的时段（秒）：门不够时，配送车提前装好、挂车在场地等发车；进货车在场地排队等门 */
  dockAt?: [number, number];
  /** 进货车在场地排队的秒数、配送车提前装好的秒数 */
  yardWait?: number;
  preload?: number;
  /** 在门店用哪个收货口（从 0 起） */
  docks?: Record<string, number>;
  unitId?: string;
  issues: Issue[];
  /** 调度员改过（时刻、门或车） */
  moved: boolean;
}
export interface DayKpi {
  /** 全部作业、配送车次、门店到货（站） */
  ops: number;
  trips: number;
  stops: number;
  onTime: number;
  late: number;
  lateMin: number;
  waitMin: number;
  driverHours: number;
  km: number;
  units: number;
  unitsBy: Partial<Record<UnitClass, number>>;
  /** 月台门的占用率（全天）和同时在用的最多门数 */
  doorUse: Record<DoorGroup, number>;
  doorPeak: Record<DoorGroup, number>;
  errors: number;
  warns: number;
}
export interface Board {
  ops: BoardOp[];
  byId: Map<string, BoardOp>;
  doors: { id: string; group: DoorGroup; bookings: Booking[] }[];
  units: Unit[];
  issues: Issue[];
  kpi: DayKpi;
}
export interface BoardContext {
  /** 分配库存的时刻（当天的小时）：进货赶不上它就要多放一天 */
  allocation: number;
  /** 生鲜越库（全链路）：区域生鲜和空运的货要赶上当天凌晨的分配 */
  crossDock: boolean;
}

export function doorGroup(op: Op): DoorGroup | undefined {
  if (!op.dock) return undefined;
  if (op.kind === 'delivery') return op.from === 'DC' ? (op.zone === 'ambient' ? 'dry' : 'cold') : undefined;
  if (op.kind === 'supplier' || op.kind === 'drayage') return op.zone === 'ambient' ? 'dry' : 'cold';
  if (op.kind === 'farm' || op.kind === 'airTruck') return 'cold';
  return undefined;
}
export const isFleet = (op: Op): boolean => op.kind === 'delivery' || op.kind === 'bakery';
export const unitClass = (op: Op): UnitClass => (op.ev ? 'ev' : ((op.unit as UnitClass | undefined) ?? 'dry'));
const min = (s: number) => Math.round(s / 60);
const hm = (s: number) => hhmm(s / 3600);

export function buildBoard(source: readonly Op[], day: DayPlan, ctx: BoardContext): Board {
  const ops: BoardOp[] = source.map((o) => ({ ...o, issues: [], moved: isMoved(o, day) }));
  const byId = new Map(ops.map((o) => [o.id, o]));
  const issues: Issue[] = [];
  const add = (i: Issue) => {
    issues.push(i);
    for (const id of i.ops) byId.get(id)?.issues.push(i);
  };

  // —— 月台门 ——
  const book = new Map<string, Booking[]>([...DOORS.cold, ...DOORS.dry].map((d) => [d, []]));
  const free = (door: string, t0: number, t1: number) => (book.get(door) as Booking[]).every((b) => b.t1 + DOOR_GAP <= t0 || t1 + DOOR_GAP <= b.t0);
  const jobs = ops.filter((o) => doorGroup(o)).map((o) => ({ op: o, group: doorGroup(o) as DoorGroup, t0: (o.dock as [number, number])[0], t1: (o.dock as [number, number])[1], inbound: o.kind !== 'delivery' }));
  const place = (j: (typeof jobs)[number], door: string, fixed: boolean, t0: number, t1: number) => {
    (book.get(door) as Booking[]).push({ door, op: j.op.id, t0, t1, mode: j.inbound ? 'unload' : 'load', fixed });
    j.op.door = door;
    j.op.dockAt = [t0, t1];
    if (j.inbound && t0 > j.t0 + 1) j.op.yardWait = t0 - j.t0;
    if (!j.inbound && t0 < j.t0 - 1) j.op.preload = j.t0 - t0;
  };
  const order = (g: DoorGroup, inbound: boolean) => {
    const r = RECEIVING_DOORS[g];
    return inbound ? [...DOORS[g].slice(0, r), ...DOORS[g].slice(r)] : [...DOORS[g].slice(r), ...DOORS[g].slice(0, r)];
  };
  // 分配完才能装车：上一代 / StoreX 前一晚 23 点、全链路当天 2 点
  const earliestLoad = (ctx.allocation >= 12 ? ctx.allocation - 24 : ctx.allocation) * 3600;
  const auto: typeof jobs = [];
  for (const j of jobs) {
    const d = day.door[j.op.id];
    if (d && DOORS[j.group].includes(d)) place(j, d, true, j.t0, j.t1);
    else auto.push(j);
  }
  auto.sort((a, b) => a.t0 - b.t0 || a.op.id.localeCompare(b.op.id));
  for (const j of auto) {
    const list = order(j.group, j.inbound);
    const dur = j.t1 - j.t0;
    let door: string | undefined;
    let t0 = j.t0;
    // 进货车：门都占着就在场地排队，等最早空出来的门；配送车：提前装好（挂车放到场地等发车）
    for (let shift = 0; shift <= (j.inbound ? 8 : 4) * 3600 && !door; shift += 300) {
      const s0 = j.inbound ? j.t0 + shift : j.t0 - shift;
      if (!j.inbound && s0 < earliestLoad - 1) break;
      door = list.find((d) => free(d, s0, s0 + dur));
      if (door) t0 = s0;
    }
    if (!door) {
      t0 = j.t0;
      door = list.reduce((best, d) => (lastEnd(book.get(d) as Booking[], j.t0) < lastEnd(book.get(best) as Booking[], j.t0) ? d : best), list[0] as string);
    }
    place(j, door, false, t0, t0 + dur);
    if (j.inbound && t0 - j.t0 > 300) add({ level: 'warn', code: 'door-queue', title: '在场地排队等门', text: `${j.op.id} ${hm(j.t0)} 到了，${j.group === 'cold' ? '冷链' : '干货'}门都占着，在场地排队 ${min(t0 - j.t0)} 分钟（${door}）`, ops: [j.op.id], at: j.t0 });
  }
  const findFree = (g: DoorGroup, t0: number, t1: number, inbound: boolean) => order(g, inbound).find((d) => free(d, t0, t1));
  for (const [door, list] of book) {
    list.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++)
      for (let k = 0; k < i; k++) {
        const a = list[k] as Booking;
        const b = list[i] as Booking;
        const overlap = Math.min(a.t1, b.t1) - b.t0;
        if (overlap <= 60) continue;
        const g: DoorGroup = door.startsWith('C') ? 'cold' : 'dry';
        // 修法：调度员指定的那个（两个都是指定的就挪后来的）改到同组空着的门；没有空门就恢复自动排
        const mover = a.fixed && !b.fixed ? a : b;
        const target = findFree(g, mover.t0, mover.t1, mover.mode === 'unload');
        if (a.fixed || b.fixed)
          add({ level: 'error', code: 'door-conflict', title: '月台门冲突', text: `${door} 上 ${a.op}（${hm(a.t0)}–${hm(a.t1)}）和 ${b.op}（${hm(b.t0)}–${hm(b.t1)}）重叠 ${Math.max(1, min(overlap))} 分钟`, ops: [a.op, b.op], at: b.t0, fix: target ? { kind: 'door', op: mover.op, door: target, text: `把 ${mover.op} 改到 ${target}` } : { kind: 'door', op: mover.op, door: '', text: `${mover.op} 恢复自动排门` } });
        else add({ level: 'warn', code: 'door-full', title: g === 'cold' ? '冷链门不够用' : '干货门不够用', text: `${hm(b.t0)} 前后${g === 'cold' ? '冷链' : '干货'}门全满，${b.op} 和 ${a.op} 挤在 ${door}（约 ${Math.max(1, min(overlap))} 分钟）`, ops: [a.op, b.op], at: b.t0 });
      }
  }

  // —— 车辆 ——
  const units = new Map<string, Unit>();
  const fleet = ops.filter(isFleet);
  const assign = (o: BoardOp, id: string) => {
    let u = units.get(id);
    if (!u) {
      u = { id, cls: unitClass(o), ops: [], from: o.t0, to: o.t1 };
      units.set(id, u);
    }
    u.ops.push(o.id);
    u.from = Math.min(u.from, o.t0);
    u.to = Math.max(u.to, o.t1);
    o.unitId = id;
  };
  const busy = (u: Unit, t0: number, t1: number) => u.ops.some((x) => {
    const o = byId.get(x) as BoardOp;
    return !(o.t1 + TURN <= t0 || t1 + TURN <= o.t0);
  });
  const nextId = (cls: UnitClass) => {
    let n = 0;
    for (const u of units.values()) if (u.cls === cls) n = Math.max(n, Number(u.id.slice(1)));
    return `${UNIT_PREFIX[cls]}${pad(n + 1)}`;
  };
  const rest: BoardOp[] = [];
  for (const o of fleet) {
    const id = day.unit[o.id];
    if (id && id.startsWith(UNIT_PREFIX[unitClass(o)])) assign(o, id);
    else rest.push(o);
  }
  rest.sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  for (const o of rest) {
    const cls = unitClass(o);
    const list = [...units.values()].filter((u) => u.cls === cls).sort((a, b) => a.id.localeCompare(b.id));
    const u = list.find((x) => !busy(x, o.t0, o.t1));
    assign(o, u ? u.id : nextId(cls));
  }
  for (const u of units.values()) {
    const list = u.ops.map((x) => byId.get(x) as BoardOp).sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1] as BoardOp;
      const b = list[i] as BoardOp;
      if (a.t1 + TURN <= b.t0) continue;
      const mover = day.unit[b.id] && !day.unit[a.id] ? a : b;
      const others = [...units.values()].filter((x) => x.cls === u.cls && x.id !== u.id && !busy(x, mover.t0, mover.t1));
      const target = others[0]?.id ?? nextId(u.cls);
      add({ level: 'error', code: 'unit-busy', title: '车辆还没回来', text: `${u.id} 跑 ${a.id} 要到 ${hm(a.t1)} 才回场，${b.id} ${hm(b.t0)} 就要装车`, ops: [a.id, b.id], at: b.t0, fix: { kind: 'unit', op: mover.id, unit: target, text: `${mover.id} 改派 ${target}` } });
    }
    if (u.to - u.from > 14 * 3600) add({ level: 'info', code: 'shift', title: '要两班司机', text: `${u.id} 从 ${hm(u.from)} 用到 ${hm(u.to)}，超过一个班`, ops: [...u.ops], at: u.from });
  }

  // —— 配送车次：迟到、等收货、高峰、工时 ——
  for (const o of fleet) {
    if (o.t1 - o.t0 > 11 * 3600) add({ level: 'error', code: 'driver', title: '单趟超过 11 小时', text: `${o.id} 从 ${hm(o.t0)} 到 ${hm(o.t1)}，司机工时超限`, ops: [o.id], at: o.t0 });
    const stops = o.stops ?? [];
    const first = stops[0];
    stops.forEach((st, i) => {
      if (!st.onTime) {
        const late = st.start - st.close * 3600;
        const depart = (o.depart ?? o.t0) / 3600;
        const hour = Math.round((depart - late / 3600 - 5 / 60) * 12) / 12;
        const fix = o.edit?.mode === 'depart' && hour >= (o.edit.min ?? 0) ? { kind: 'depart' as const, key: o.edit.key, hour, text: `${o.id} 提前到 ${hhmm(hour)} 出发` } : undefined;
        add({ level: 'error', code: 'late', title: '迟到', text: `${o.id} 到${st.name}：收货截止 ${hhmm(st.close)}，${hm(st.start)} 才开始卸货，晚 ${Math.max(1, min(late))} 分钟`, ops: [o.id], at: st.arrive, ...(fix ? { fix } : {}) });
      }
      if (st.slow > 10) add({ level: 'warn', code: 'peak', title: '高峰拥堵', text: `${o.id} 开往${st.name}遇上高峰，路上多 ${Math.round(st.slow)} 分钟`, ops: [o.id], at: st.arrive });
      if (i === 0 && st.start - st.arrive > 600 && st === first) {
        const wait = st.start - st.arrive;
        const depart = (o.depart ?? o.t0) / 3600;
        const hour = Math.round((depart + (wait - 300) / 3600) * 12) / 12;
        add({ level: 'info', code: 'wait', title: '到早了', text: `${o.id} 到${st.name}时还没到收货时间（${hhmm(st.open)}），在门外等 ${min(wait)} 分钟`, ops: [o.id], at: st.arrive, ...(o.edit?.mode === 'depart' ? { fix: { kind: 'depart', key: o.edit.key, hour, text: `${o.id} 推迟到 ${hhmm(hour)} 出发` } } : {}) });
      }
    });
  }

  // —— 长途直送车：过了门店的直送收货时段才到 ——
  const direct = ops.filter((o) => o.kind === 'direct');
  for (const o of direct)
    for (const st of o.stops ?? []) {
      if (st.onTime) continue;
      const late = st.start - st.close * 3600;
      const hour = Math.round(((o.arrive ?? st.arrive) - late - 300) / 300) / 12;
      const fix = o.edit?.mode === 'arrive' && hour >= 0 ? { kind: 'arrive' as const, key: o.edit.key, hour, text: `${o.edit.key} 改到 ${hhmm(hour)} 到` } : undefined;
      add({ level: 'error', code: 'late', title: '直送车迟到', text: `${o.id} 到${st.name}：直送收货截止 ${hhmm(st.close)}，${hm(st.start)} 才开始卸货，晚 ${Math.max(1, min(late))} 分钟`, ops: [o.id], at: st.arrive, ...(fix ? { fix } : {}) });
    }

  // —— 门店收货口：先到先用，都占着时用先空出来的那个（下面报收货口不够） ——
  const byStore = new Map<string, { st: OpStop; op: string }[]>();
  for (const o of [...fleet, ...direct]) for (const st of o.stops ?? []) byStore.set(st.key, [...(byStore.get(st.key) ?? []), { st, op: o.id }]);
  for (const [key, list] of byStore) {
    const freeAt = new Array<number>(storeDocks(key)).fill(-Infinity);
    for (const x of [...list].sort((a, b) => a.st.arrive - b.st.arrive)) {
      let k = freeAt.findIndex((t) => t + DOOR_GAP <= x.st.arrive);
      if (k < 0) k = freeAt.indexOf(Math.min(...freeAt));
      freeAt[k] = x.st.end;
      const o = byId.get(x.op) as BoardOp;
      o.docks = { ...(o.docks ?? {}), [key]: k };
    }
  }
  for (const [key, list] of byStore) {
    const n0 = storeDocks(key);
    const ev = list.flatMap((x) => [{ t: x.st.start, d: 1, x }, { t: x.st.end, d: -1, x }]).sort((a, b) => a.t - b.t || a.d - b.d);
    let n = 0;
    let reported = -Infinity;
    const on = new Set<string>();
    for (const e of ev) {
      n += e.d;
      if (e.d > 0) on.add(e.x.op);
      else on.delete(e.x.op);
      if (n > n0 && e.t > reported + 1800) {
        reported = e.t;
        add({ level: 'warn', code: 'store-dock', title: '门店收货口不够', text: `${e.x.st.name} ${hm(e.t)} 同时有 ${n} 辆车卸货（只有 ${n0} 个收货口）`, ops: [...on], at: e.t });
      }
    }
  }

  // —— 进货赶不上分配 ——
  const cutoff = ctx.allocation * 3600;
  for (const o of ops) {
    if (!o.dock || o.kind === 'delivery') continue;
    const fresh = o.kind === 'farm' || o.kind === 'airTruck';
    if (ctx.crossDock && !fresh) continue;
    // 和仿真一致：货到了就能参加分配（越库边卸边分）
    const at = o.dock[0];
    if (ctx.crossDock ? at <= cutoff || at > cutoff + 12 * 3600 : at <= cutoff) continue;
    const hour = Math.floor((cutoff / 3600 - 0.25) * 12) / 12;
    const fix = o.edit?.mode === 'arrive' && hour >= 0 ? { kind: 'arrive' as const, key: o.edit.key, hour, text: `${o.edit.key} 改到 ${hhmm(hour)} 前到` } : undefined;
    add({ level: 'warn', code: 'cutoff', title: '赶不上分配', text: `${o.id} ${hm(at)} 才到，赶不上 ${hhmm(ctx.allocation)} 的分配${fresh ? '：生鲜要在配送中心多放一天' : '：货要等下一次分配才能发'}${o.edit?.mode === 'standing' ? '（改常规计划里的时刻）' : ''}`, ops: [o.id], at, ...(fix ? { fix } : {}) });
  }

  // —— 当天的指标（门店到货含长途直送） ——
  const allStops = [...fleet, ...direct].flatMap((o) => o.stops ?? []);
  const doorUse = { cold: 0, dry: 0 };
  const doorPeak = { cold: 0, dry: 0 };
  for (const g of ['cold', 'dry'] as const) {
    const list = DOORS[g].flatMap((d) => book.get(d) as Booking[]);
    doorUse[g] = list.reduce((a, b) => a + Math.max(0, Math.min(86400, b.t1) - Math.max(0, b.t0)), 0) / (DOORS[g].length * 86400);
    const ev = list.flatMap((b) => [{ t: b.t0, d: 1 }, { t: b.t1, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
    let n = 0;
    for (const e of ev) doorPeak[g] = Math.max(doorPeak[g], (n += e.d));
  }
  const unitsBy: DayKpi['unitsBy'] = {};
  for (const u of units.values()) unitsBy[u.cls] = (unitsBy[u.cls] ?? 0) + 1;
  issues.sort((a, b) => rank(a.level) - rank(b.level) || a.at - b.at);
  const kpi: DayKpi = {
    ops: ops.length,
    trips: fleet.length,
    stops: allStops.length,
    onTime: allStops.filter((s) => s.onTime).length,
    late: allStops.filter((s) => !s.onTime).length,
    lateMin: allStops.reduce((a, s) => a + (s.onTime ? 0 : Math.max(0, (s.start - s.close * 3600) / 60)), 0),
    waitMin: allStops.reduce((a, s) => a + Math.max(0, (s.start - s.arrive) / 60), 0),
    driverHours: fleet.reduce((a, o) => a + (o.t1 - o.t0) / 3600, 0),
    km: fleet.reduce((a, o) => a + (o.km ?? 0), 0),
    units: units.size,
    unitsBy,
    doorUse,
    doorPeak,
    errors: issues.filter((i) => i.level === 'error').length,
    warns: issues.filter((i) => i.level === 'warn').length,
  };
  return {
    ops,
    byId,
    doors: [...DOORS.cold.map((id) => ({ id, group: 'cold' as const })), ...DOORS.dry.map((id) => ({ id, group: 'dry' as const }))].map((d) => ({ ...d, bookings: book.get(d.id) as Booking[] })),
    units: [...units.values()].sort((a, b) => a.cls.localeCompare(b.cls) || a.id.localeCompare(b.id)),
    issues,
    kpi,
  };
}

const rank = (l: Issue['level']) => (l === 'error' ? 0 : l === 'warn' ? 1 : 2);

function lastEnd(list: readonly Booking[], t: number): number {
  let end = -Infinity;
  for (const b of list) if (b.t0 <= t + 3600) end = Math.max(end, b.t1);
  return end;
}

function isMoved(o: Op, day: DayPlan): boolean {
  if (day.door[o.id] || day.unit[o.id]) return true;
  if (o.edit?.mode === 'depart') return day.depart[o.edit.key] !== undefined;
  if (o.edit?.mode === 'arrive') return day.arrive[o.edit.key] !== undefined;
  return false;
}

/**
 * 自动排程：把能自动修的问题都修掉，返回新的当天调度。门和车的修法直接生效（不用重新仿真），
 * 迟到的车次改出发时刻（要重新仿真）；到早了在门外等的只是提示，不自动改。
 */
export function autoFix(board: Board, day: DayPlan): { day: DayPlan; changed: number; needsRun: boolean } {
  const next: DayPlan = { depart: { ...day.depart }, arrive: { ...day.arrive }, door: { ...day.door }, unit: { ...day.unit } };
  let changed = 0;
  let needsRun = false;
  const usedDoor = new Set<string>();
  for (const i of board.issues) {
    const f = i.fix;
    if (!f || i.code === 'wait') continue;
    if (f.kind === 'door') {
      // 同一轮里每樘门只派一次，剩下的交给自动排
      if (!f.door || usedDoor.has(f.door)) delete next.door[f.op];
      else next.door[f.op] = f.door;
      usedDoor.add(f.door);
    } else if (f.kind === 'unit') delete next.unit[f.op];
    else if (f.kind === 'depart') {
      const cur = next.depart[f.key];
      if (cur !== undefined && cur <= f.hour) continue;
      next.depart[f.key] = f.hour;
      needsRun = true;
    } else {
      next.arrive[f.key] = f.hour;
      needsRun = true;
    }
    changed++;
  }
  return { day: next, changed, needsRun };
}

/** 把一个修法用到当天调度上 */
export function applyFix(day: DayPlan, f: Fix): DayPlan {
  const next: DayPlan = { depart: { ...day.depart }, arrive: { ...day.arrive }, door: { ...day.door }, unit: { ...day.unit } };
  if (f.kind === 'door') {
    if (f.door) next.door[f.op] = f.door;
    else delete next.door[f.op];
  } else if (f.kind === 'unit') next.unit[f.op] = f.unit;
  else if (f.kind === 'depart') next.depart[f.key] = f.hour;
  else next.arrive[f.key] = f.hour;
  return next;
}
