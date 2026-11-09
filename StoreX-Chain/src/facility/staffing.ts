import { doorGroup, type Board } from '../sim/board';
import { crewOf, minCrew, SHIFTS, type Facilities, type Role, type Shift } from './config';

/**
 * 按作业量求解排班：每个岗位每小时要几个人（作业量模型），再在三班制（早 6–14、中 14–22、夜 22–6）里定每班几个人，
 * 班次交接的头尾两小时可以让上一班留下来、或下一班提前来加班（加班工资按倍数算），人工成本合计最小。
 *
 * 作业量模型（每个岗位一条，界面上显示依据）：
 * - 物流园：叉车司机 = 同时在作业的月台门（每樘 1 人）+ 每小时进出 40 托多 1 人（入库上架、补货）；收货员 = 同时在卸货的车（每辆 1 人）+ 有车时 1 人做单据；
 *   拣货、自动化运维、库内调度：物流园还服务别的客户，这部分作业量不在本店的计划里，保持现在的人数；
 * - 综合店：收货员 = 同时在卸货的车；理货员 = 到店托盘先进后仓、在之后 8 小时里上架（每托 0.75 工时）+ 营业时间的整理补面（按规模）；
 *   线上拣货员 = 正在拣货的配送波次 × 2 人（每波发车前 1.5 小时拣）；收银 = 每小时卖出的件数 ÷ 每单 25 件 × 人工收银六成 ÷ 每人每小时 30 单；值班经理每班 1 人；
 * - 港口：岸桥、龙门吊、场内集卡司机 = 同时在作业的台数；闸口查验员 = 每小时进闸的外来集卡 ÷ 12（有车时至少 1 人）；绑扎工 = 每小时装卸的箱 ÷ 20；中控保持；
 * - 机场：平台车司机 = 同时在保障的机位；牵引车司机 = 机位 × 每个机位的板车套数；装卸工 = 机位 × 4；拆板组板 = 每小时的集装板 × 0.5；加油员 = 每小时落地的航班；调度保持。
 * 在作业量之外按「余量」多留几个百分点，每班不少于「每班最少几个人」（24 小时都要有人）。
 *
 * 影响仿真作业效率的岗位（仿真按人数换算效率）：物流园叉车司机和收货员最少的那一班、综合店早班收货员、机场夜班牵引车司机和拆板组板、
 * 港口早班闸口查验员。选「不让仿真变慢」时这几项不低于现在的人数。
 *
 * 每个岗位单独精确求解：三班的人数逐一枚举，交接的加班按缺口直接算出（头两小时由上一班留人、末两小时由下一班早来，每人每天最多一段），
 * 取成本最小的。设施配置只存每班人数，所以同时给出「不加班」的方案（可以直接应用）和「加班」的方案（另外省的钱，要排加班表执行）。
 */
export type FacKey = keyof Facilities;

/** 每小时（0–23 点）的作业量 */
export interface Activity {
  /** 物流园：同时在作业的月台门最多几樘、其中在卸货的、进出的托盘 */
  dc?: { doors: number[]; unload: number[]; pallets: number[] };
  /** 综合店：同时在卸货的收货口、到店的托盘、正在拣货的线上配送波次、卖出的件数 */
  store?: { docks: number[]; pallets: number[]; picking: number[]; sales: number[] };
  /** 港口：同时在作业的岸桥、龙门吊、场内集卡，进闸的外来集卡、在装卸的船、装卸的箱 */
  port?: { cranes: number[]; rtg: number[]; tt: number[]; gate: number[]; ships: number[]; moves: number[] };
  /** 机场：同时在保障的机位、落地的航班、拆组的集装板 */
  airport?: { stands: number[]; flights: number[]; ulds: number[] };
}

export interface StaffOptions {
  overtimeRate: number;
  maxOvertimeHours: number;
  reservePct: number;
  minPerShift: number;
  simNeutral: boolean;
}

/** 门店 7–22 点营业，每小时卖出的比例（和仿真一致：src/sim/engine.ts 的 HOUR_W，测试里核对） */
const CURVE = [3, 5, 6, 7, 9, 9, 7, 6, 7, 9, 10, 9, 7, 4, 2];
export const SALES_HOUR = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 22 ? (CURVE[h - 7] as number) / CURVE.reduce((a, b) => a + b, 0) : 0));

const zeros = () => new Array<number>(24).fill(0);
const hourOf = (t: number) => ((Math.floor(t / 3600) % 24) + 24) % 24;

/** 一个时段在每个小时里同时在的个数（每 5 分钟看一次，取小时里的最大）、按时长分到每个小时的量 */
function addSpan(peakArr: number[], spans: [number, number][]): void {
  for (let h = 0; h < 24; h++) {
    let m = 0;
    for (let k = 0; k < 12; k++) {
      const t = h * 3600 + k * 300 + 150;
      let c = 0;
      for (const [a, b] of spans) {
        // 跨午夜的时段按一天循环
        for (const off of [-86400, 0, 86400]) if (a + off <= t && t < b + off) c++;
      }
      m = Math.max(m, c);
    }
    peakArr[h] = Math.max(peakArr[h] as number, m);
  }
}
function spread(arr: number[], a: number, b: number, amount: number): void {
  const len = Math.max(60, b - a);
  for (let t = a; t < a + len; t += 300) {
    const h = hourOf(t);
    arr[h] = (arr[h] as number) + (amount * Math.min(300, a + len - t)) / len;
  }
}

/** 物流园和综合店的作业量：从调度台当天的排程算 */
export function activityFromBoard(board: Board, storeKey: string, salesPerDay: number): Pick<Activity, 'dc' | 'store'> {
  const dc = { doors: zeros(), unload: zeros(), pallets: zeros() };
  const all: [number, number][] = [];
  const inb: [number, number][] = [];
  for (const o of board.ops) {
    if (!o.door || !o.dockAt || !doorGroup(o)) continue;
    all.push(o.dockAt);
    if (o.kind !== 'delivery') inb.push(o.dockAt);
    spread(dc.pallets, o.dockAt[0], o.dockAt[1], o.pallets ?? 0);
  }
  addSpan(dc.doors, all);
  addSpan(dc.unload, inb);
  const store = { docks: zeros(), pallets: zeros(), picking: zeros(), sales: SALES_HOUR.map((w) => w * salesPerDay) };
  const unloading: [number, number][] = [];
  const waves: [number, number][] = [];
  for (const o of board.ops) {
    for (const st of o.stops ?? []) {
      if (st.key !== storeKey) continue;
      unloading.push([st.start, st.end]);
      spread(store.pallets, st.start, st.end, st.pallets);
    }
    if (o.kind === 'van' && o.from === storeKey) waves.push([o.t0 - 5400, o.t0]);
  }
  addSpan(store.docks, unloading);
  addSpan(store.picking, waves);
  return { dc, store };
}

/** 一个岗位的作业量依据和每小时要几个人；fixed = 不在求解范围（保持现在的人数） */
interface RoleNeed {
  need: number[];
  basis: string;
  fixed?: string;
}

function needOf(fac: FacKey, role: Role, act: Activity, f: Facilities): RoleNeed | undefined {
  const ceil = (x: number) => Math.ceil(x - 1e-9);
  const keep = (why: string): RoleNeed => ({ need: zeros(), basis: why, fixed: why });
  if (fac === 'dc') {
    const a = act.dc;
    if (role.key === 'pick' || role.key === 'auto' || role.key === 'ctrl') return keep('物流园还服务别的客户，这部分作业量不在本店的计划里，保持现在的人数');
    if (!a) return undefined;
    if (role.key === 'fork') return { need: a.doors.map((d, h) => d + ceil((a.pallets[h] as number) / 40)), basis: '同时在作业的月台门每樘 1 人 + 每小时进出 40 托多 1 人（入库上架、补货）' };
    if (role.key === 'recv') return { need: a.unload.map((u) => u + (u > 0 ? 1 : 0)), basis: '同时在卸货的车每辆 1 人核对 + 有车时 1 人做单据' };
  }
  if (fac === 'store') {
    const a = act.store;
    if (role.key === 'lead') return { need: new Array<number>(24).fill(1), basis: '每班 1 位值班经理' };
    if (!a) return undefined;
    if (role.key === 'recv') return { need: a.docks.map((d) => d), basis: '同时在卸货的车每辆 1 人' };
    if (role.key === 'stock') {
      const base = SALES_HOUR.map((w) => (w > 0 ? 0.6 * f.store.size : 0.2 * f.store.size));
      // 到店的货先进后仓，在之后 8 小时里陆续上架
      return { need: base.map((b, h) => ceil(b + [0, 1, 2, 3, 4, 5, 6, 7].reduce((s, k) => s + ((a.pallets[(h - k + 24) % 24] as number) * 0.75) / 8, 0))), basis: '到店托盘先进后仓、在之后 8 小时里上架（每托 0.75 工时）+ 营业时整理补面（按门店规模）' };
    }
    if (role.key === 'pick') return { need: a.picking.map((w) => w * 2), basis: '正在拣货的线上配送波次每波 2 人（发车前 1.5 小时拣）' };
    if (role.key === 'cash') return { need: a.sales.map((u) => ceil(((u / 25) * 0.6) / 30)), basis: '每小时卖出的件数 ÷ 每单 25 件 × 人工收银六成 ÷ 每人每小时 30 单' };
  }
  if (fac === 'port') {
    const a = act.port;
    if (role.key === 'ctrl') return keep('中控调度按岗位配，保持现在的人数');
    if (!a) return undefined;
    if (role.key === 'qc') return { need: [...a.cranes], basis: '同时在作业的岸桥每台 1 人' };
    if (role.key === 'rtg') return { need: [...a.rtg], basis: '同时在作业的龙门吊每台 1 人' };
    if (role.key === 'tt') return { need: [...a.tt], basis: '同时在作业的场内集卡每辆 1 人' };
    if (role.key === 'gate') return { need: a.gate.map((g) => (g > 0 ? Math.max(1, ceil(g / 12)) : 0)), basis: '每小时进闸的外来集卡 ÷ 12（有车时至少 1 人）' };
    if (role.key === 'lash') return { need: a.moves.map((m) => ceil(m / 20)), basis: '每小时装卸的箱 ÷ 20' };
  }
  if (fac === 'airport') {
    const a = act.airport;
    if (role.key === 'ctrl') return keep('机坪调度按岗位配，保持现在的人数');
    if (!a) return undefined;
    if (role.key === 'loader') return { need: [...a.stands], basis: '同时在保障的机位每个 1 台平台车' };
    if (role.key === 'tug') return { need: a.stands.map((s) => s * f.airport.dollySets), basis: `同时在保障的机位 × 每个机位 ${f.airport.dollySets} 套板车` };
    if (role.key === 'ramp') return { need: a.stands.map((s) => s * 4), basis: '同时在保障的机位每个 4 人' };
    if (role.key === 'build') return { need: a.ulds.map((u) => ceil(u * 0.5)), basis: '每小时拆、组的集装板 × 0.5 人' };
    if (role.key === 'fuel') return { need: a.flights.map((n) => n), basis: '每小时落地的航班每架 1 人' };
  }
  return undefined;
}

/** 影响仿真作业效率的岗位：哪几班不能低于现在的人数 */
function simFloor(fac: FacKey, role: Role, staff: Role[]): Partial<Record<Shift, number>> {
  if (fac === 'dc' && (role.key === 'fork' || role.key === 'recv')) {
    const m = minCrew(staff, role.key);
    return { early: m, late: m, night: m };
  }
  if (fac === 'store' && role.key === 'recv') return { early: crewOf(staff, 'recv', 'early') };
  if (fac === 'airport' && (role.key === 'tug' || role.key === 'build')) return { night: crewOf(staff, role.key, 'night') };
  if (fac === 'port' && role.key === 'gate') return { early: crewOf(staff, 'gate', 'early') };
  return {};
}

/** 每班开始的小时；班次交接 b：上一班（a）留人覆盖 b、b+1，下一班（b 那一班）提前来覆盖 b−1、b−2 */
const START: Record<Shift, number> = { early: 6, late: 14, night: 22 };
const PREV: Record<Shift, Shift> = { early: 'night', late: 'early', night: 'late' };
const NEXT: Record<Shift, Shift> = { early: 'late', late: 'night', night: 'early' };
export const shiftHours = (s: Shift): number[] => Array.from({ length: 8 }, (_, k) => (START[s] + k) % 24);

export interface Overtime {
  /** 哪一班的人、留下来（stay，覆盖下一班开头）还是提前来（early，覆盖上一班末尾）、几个人、每人几小时 */
  shift: Shift;
  kind: 'stay' | 'early';
  people: number;
  hours: number;
}
export interface RolePlan {
  key: string;
  label: string;
  wage: number;
  basis: string;
  /** 不在求解范围的原因（保持现在的人数） */
  fixed?: string;
  need: number[];
  current: Record<Shift, number>;
  /** 求解（不加班，可以直接应用）、求解（允许加班） */
  plain: Record<Shift, number>;
  crew: Record<Shift, number>;
  overtime: Overtime[];
  /** 每天的人工（美元）：现在、不加班的方案、加班的方案（含加班费） */
  costNow: number;
  costPlain: number;
  cost: number;
  overtimeH: number;
  /** 人手不够的人·小时：现在、加班方案 */
  shortNow: number;
  short: number;
  /** 哪几班不能低于现在（会影响仿真效率） */
  floor: Partial<Record<Shift, number>>;
}
export interface StaffPlan {
  fac: FacKey;
  roles: RolePlan[];
  /** 没有作业量数据（港口、机场的设施作业没接上）时为 false */
  hasData: boolean;
  costNow: number;
  costPlain: number;
  cost: number;
  overtimeH: number;
  shortNow: number;
  changes: string[];
  ms: number;
}

/** 某个排法每小时有几个人（含加班） */
export function coverage(crew: Record<Shift, number>, ot: Overtime[]): number[] {
  const c = zeros();
  for (const s of SHIFTS) for (const h of shiftHours(s)) c[h] = (c[h] as number) + crew[s];
  for (const o of ot) {
    // 留下来：覆盖下一班的头几个小时；提前来：覆盖上一班的末几个小时
    const hs = o.kind === 'stay' ? Array.from({ length: o.hours }, (_, k) => (START[NEXT[o.shift]] + k) % 24) : Array.from({ length: o.hours }, (_, k) => (START[o.shift] - 1 - k + 24) % 24);
    for (const h of hs) c[h] = (c[h] as number) + o.people;
  }
  return c;
}
const shortOf = (need: number[], cov: number[]) => need.reduce((a, n, h) => a + Math.max(0, n - (cov[h] as number)), 0);

/**
 * 一个岗位：三班各几个人 + 交接时的加班，覆盖每小时的需要，成本最小（逐一枚举，精确）。
 * maxOt = 0 就是不加班的方案。lo = 每班的下限。
 */
export function solveRole(need: number[], wage: number, lo: Record<Shift, number>, maxOt: number, rate: number): { crew: Record<Shift, number>; overtime: Overtime[]; cost: number } | undefined {
  const hi = (s: Shift) => Math.max(lo[s], ...shiftHours(s).map((h) => need[h] as number));
  let best: { crew: Record<Shift, number>; overtime: Overtime[]; cost: number; ot: number; people: number } | undefined;
  const E = hi('early');
  const L = hi('late');
  const N = hi('night');
  for (let e = lo.early; e <= E; e++)
    for (let l = lo.late; l <= L; l++)
      for (let n = lo.night; n <= N; n++) {
        const crew: Record<Shift, number> = { early: e, late: l, night: n };
        // 每班中间 4 个小时只能靠本班的人
        let ok = true;
        for (const s of SHIFTS) {
          const hs = shiftHours(s);
          for (let k = 2; k < 6 && ok; k++) if ((need[hs[k] as number] as number) > crew[s]) ok = false;
          if (!ok) break;
        }
        if (!ok) continue;
        const ot: Overtime[] = [];
        // 每人每天最多一段加班：本班「提前来」和「留下来」的人数合计不超过本班人数
        const used: Record<Shift, number> = { early: 0, late: 0, night: 0 };
        let otH = 0;
        for (const s of SHIFTS) {
          const hs = shiftHours(s);
          const p = PREV[s];
          // 本班头两小时的缺口：上一班留人
          const d1 = Math.max(0, (need[hs[0] as number] as number) - crew[s]);
          const d2 = Math.max(0, (need[hs[1] as number] as number) - crew[s]);
          // 本班末两小时的缺口：下一班提前来
          const e1 = Math.max(0, (need[hs[7] as number] as number) - crew[s]);
          const e2 = Math.max(0, (need[hs[6] as number] as number) - crew[s]);
          if ((d2 > 0 || e2 > 0) && maxOt < 2) {
            ok = false;
            break;
          }
          if ((d1 > 0 || e1 > 0) && maxOt < 1) {
            ok = false;
            break;
          }
          const s2 = d2;
          const s1 = Math.max(0, d1 - d2);
          const c2 = e2;
          const c1 = Math.max(0, e1 - e2);
          used[p] += s1 + s2;
          used[NEXT[s]] += c1 + c2;
          if (s2) ot.push({ shift: p, kind: 'stay', people: s2, hours: 2 });
          if (s1) ot.push({ shift: p, kind: 'stay', people: s1, hours: 1 });
          if (c2) ot.push({ shift: NEXT[s], kind: 'early', people: c2, hours: 2 });
          if (c1) ot.push({ shift: NEXT[s], kind: 'early', people: c1, hours: 1 });
          otH += 2 * s2 + s1 + 2 * c2 + c1;
        }
        if (!ok || SHIFTS.some((s) => used[s] > crew[s])) continue;
        const cost = wage * 8 * (e + l + n) + otH * wage * rate;
        const people = e + l + n;
        if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && (otH < best.ot || (otH === best.ot && people < best.people)))) best = { crew, overtime: ot, cost, ot: otH, people };
      }
  return best ? { crew: best.crew, overtime: best.overtime, cost: best.cost } : undefined;
}

/** 一个设施的排班求解 */
export function solveStaffing(fac: FacKey, f: Facilities, act: Activity, opts: StaffOptions): StaffPlan {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const staff = f[fac].staff;
  const roles: RolePlan[] = [];
  let hasData = true;
  for (const role of staff) {
    const r = needOf(fac, role, act, f);
    const current = { ...role.crew };
    const costNow = role.wage * 8 * (current.early + current.late + current.night);
    if (!r || r.fixed) {
      if (!r) hasData = false;
      roles.push({ key: role.key, label: role.label, wage: role.wage, basis: r?.basis ?? '没有作业量数据', fixed: r?.fixed ?? '没有作业量数据，保持现在的人数', need: zeros(), current, plain: current, crew: current, overtime: [], costNow, costPlain: costNow, cost: costNow, overtimeH: 0, shortNow: 0, short: 0, floor: {} });
      continue;
    }
    // 余量按比例四舍五入（1 个人的岗位不会因为一成余量变成 2 个人）
    const need = r.need.map((n) => (n > 0 ? Math.max(n, Math.round(n * (1 + opts.reservePct / 100))) : 0));
    const floor = opts.simNeutral ? simFloor(fac, role, staff) : {};
    const lo: Record<Shift, number> = { early: Math.max(opts.minPerShift, floor.early ?? 0), late: Math.max(opts.minPerShift, floor.late ?? 0), night: Math.max(opts.minPerShift, floor.night ?? 0) };
    const plain = solveRole(need, role.wage, lo, 0, opts.overtimeRate);
    const withOt = opts.maxOvertimeHours > 0 ? solveRole(need, role.wage, lo, Math.min(2, opts.maxOvertimeHours), opts.overtimeRate) : plain;
    const p = plain ?? { crew: current, overtime: [], cost: costNow };
    const w = withOt && withOt.cost < p.cost ? withOt : p;
    roles.push({
      key: role.key,
      label: role.label,
      wage: role.wage,
      basis: r.basis,
      need,
      current,
      plain: p.crew,
      crew: w.crew,
      overtime: w.overtime,
      costNow,
      costPlain: p.cost,
      cost: w.cost,
      overtimeH: w.overtime.reduce((a, o) => a + o.people * o.hours, 0),
      shortNow: shortOf(need, coverage(current, [])),
      short: shortOf(need, coverage(w.crew, w.overtime)),
      floor,
    });
  }
  const sum = (g: (r: RolePlan) => number) => roles.reduce((a, r) => a + g(r), 0);
  return {
    fac,
    roles,
    hasData,
    costNow: sum((r) => r.costNow),
    costPlain: sum((r) => r.costPlain),
    cost: sum((r) => r.cost),
    overtimeH: sum((r) => r.overtimeH),
    shortNow: sum((r) => r.shortNow),
    changes: staffChanges(roles),
    ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}

const SHIFT_NAME: Record<Shift, string> = { early: '早班', late: '中班', night: '夜班' };

function staffChanges(roles: RolePlan[]): string[] {
  const out: string[] = [];
  for (const r of roles) {
    if (r.fixed) continue;
    const bits: string[] = [];
    const moved = SHIFTS.filter((s) => r.plain[s] !== r.current[s]);
    if (moved.length) bits.push(moved.map((s) => `${SHIFT_NAME[s]} ${r.current[s]} → ${r.plain[s]}`).join('、'));
    // 下限顶住了（作业量本来用不了这么多人）
    const held = SHIFTS.filter((s) => r.floor[s] !== undefined && r.plain[s] === r.floor[s] && Math.max(...shiftHours(s).map((h) => r.need[h] as number)) < (r.floor[s] as number));
    if (held.length) bits.push(`${held.map((s) => `${SHIFT_NAME[s]}不少于 ${r.floor[s]} 人`).join('、')}（这几个人数影响仿真里的作业效率）`);
    if (r.shortNow > 0) bits.push(`现在有 ${r.shortNow} 个人·小时不够`);
    const ot = r.overtime.filter((o) => o.people > 0);
    if (ot.length && r.cost < r.costPlain - 0.5) bits.push(`允许加班时 ${ot.map((o) => `${SHIFT_NAME[o.shift]} ${o.people} 人${o.kind === 'stay' ? '留下来' : '提前来'} ${o.hours} 小时`).join('、')}，比多排整班的人每天省 $${Math.round(r.costPlain - r.cost)}`);
    if (bits.length) out.push(`${r.label}：${bits.join('；')}`);
  }
  return out;
}
