import { bayCovers, doorDistance, PICKUP_PITCH, type LongKind, type Stall, type StoreLot } from './lot';
import { isLong, rng, type CarVisit } from './visits';

/**
 * 停车场的车位安排（第一部分决策记录 0018 的停车规则）：
 * - 取货的车停到 StoreX 轨迹里那个取货位对应的位置：自提柜外侧 → 即时取货车位 2–7，车边交付（上一代）→ 即时取货车位 1–6，
 *   免下车取货 → 免下车车道的 4 个取货位；
 * - 购物的车：越靠近店门的车位越容易停满（按离店门的远近，选中的权重在 1.3 倍到 0.7 倍之间），有无障碍证的停无障碍车位，
 *   电动车先找充电车位；约 12% 倒车入位（车头朝车道），约 8% 穿过对面空着的车位停（车头朝外）；
 * - 员工停员工车位（最远的一片），满了停最远的普通车位；
 * - 房车和拖车停长车位，占着的那几个车位那段时间不停别的车；
 * - 每个车位一段时间只停一辆车：占用时段 = 停进来之前 25 秒（倒进、开进的时间）到开走之后 35 秒。
 * 同一份来车、同一个停车场每次排出来一样。
 */
export type ParkMode = 'head' | 'back' | 'through' | 'long' | 'drive';

export interface Stay {
  visit: CarVisit;
  /** 车位（lot.stalls 的下标）；免下车取货是取货位的下标（lot.drive），长车是长车位（lot.long） */
  stall: number;
  mode: ParkMode;
  /** 停进车位、开始开走的时刻（购物的车按走到店门的时间调过；免下车取货要等前面的车开走） */
  arrive: number;
  leave: number;
  /** 下车走到店门（或从店门走回车上）的秒数（购物的车） */
  walk?: number;
  /** 免下车取货：到车道口的时刻（照门店仿真）；在车道里停过的位置和开始挪过去的时刻（前面的车走了就往前挪） */
  enter?: number;
  drive?: Array<{ t: number; pos: number }>;
  /** 购物车：推回回收栏（哪个、来回多少秒）、顺手放在车位旁、没推车 */
  cart?: 'corral' | 'stray' | 'none';
  corral?: number;
  cartTrip?: number;
  /** 长车占着的车位 */
  covers?: number[];
}

/**
 * 走路、推车的速度（米 / 秒）；下车锁车、装车、上车的秒数；车比顾客该下车的时刻早到多少秒（司机在车里坐一会儿，
 * 停车场里让行耽误的时间从这里扣，顾客进店的时刻不变）
 */
export const WALK_SPEED = 1.25;
export const CART_SPEED = 1.05;
export const GET_OUT = 15;
export const LOAD = 30;
export const GET_IN = 10;
export const SLACK_IN = 40;
/** 免下车取货：交付前 25 秒到交付后 2 秒车不动（送框小车在车边装货）；车道里挪一个位置约 6 秒 */
export const SERVE_HOLD = 25;
const MOVE_UP = 6;

export const STAY_BEFORE = 25;
export const STAY_AFTER = 35;

export interface StayPlan {
  stays: Stay[];
  /** 每个车位的占用时段（车位下标 → [开始, 结束] 列表，按开始排） */
  byStall: Map<number, Array<[number, number]>>;
  /** 员工车位（最远的那一片） */
  staffStalls: Set<number>;
  /** 没停上的车（车位全满，开走了）、穿过停 / 倒车入位的车数 */
  turnedAway: CarVisit[];
}

/** 员工车位：最远一组双排里靠路的半排（长车位除外），不够时再加上靠门店的半排 */
export function staffStalls(lot: StoreLot, want = 24): Set<number> {
  const longs = new Set(lot.long.flatMap((b) => b.spots));
  const rows = Math.max(...lot.frontStalls.map((i) => (lot.stalls[i] as Stall).row));
  const cand = lot.frontStalls
    .map((i) => lot.stalls[i] as Stall)
    .filter((s) => s.kind === 'general' && s.row === rows && !longs.has(s.i))
    .sort((a, b) => b.aisle - a.aisle || Math.abs(b.x - lot.walkX) - Math.abs(a.x - lot.walkX));
  return new Set(cand.slice(0, want).map((s) => s.i));
}

/** 对面的车位（双排里背靠背的那个） */
export function oppositeStall(lot: StoreLot, s: Stall): Stall | undefined {
  if (s.zone !== 'front' || s.row === 0) return undefined;
  return lot.stalls.find((o) => o.zone === 'front' && o.row === s.row && o.col === s.col && o.aisle !== s.aisle);
}

export function planStays(lot: StoreLot, visits: readonly CarVisit[], seed: number): StayPlan {
  const byStall = new Map<number, Array<[number, number]>>();
  const free = (i: number, a: number, b: number) => !(byStall.get(i) ?? []).some(([x, y]) => x < b && a < y);
  const take = (i: number, a: number, b: number) => {
    const list = byStall.get(i) ?? [];
    list.push([a, b]);
    list.sort((p, q) => p[0] - q[0]);
    byStall.set(i, list);
  };
  const staff = staffStalls(lot);
  const longs = new Set(lot.long.flatMap((b) => b.spots));
  // 店前的车位按离店门的远近排名：近的权重 1.3，远的 0.7
  const front = lot.frontStalls.map((i) => lot.stalls[i] as Stall).filter((s) => !staff.has(s.i));
  const ranked = [...front].sort((a, b) => doorDistance(lot, a) - doorDistance(lot, b) || a.i - b.i);
  const weight = new Map<number, number>(ranked.map((s, k) => [s.i, 1.3 - (0.6 * k) / Math.max(1, ranked.length - 1)]));
  const staffList = [...staff].map((i) => lot.stalls[i] as Stall).sort((a, b) => doorDistance(lot, b) - doorDistance(lot, a));
  const farGeneral = [...ranked].reverse().filter((s) => s.kind === 'general' && !longs.has(s.i));
  const r = rng(seed * 101 + 5);
  const stays: Stay[] = [];
  const turnedAway: CarVisit[] = [];
  const longFree = lot.long.map(() => [] as Array<[number, number]>);
  // 免下车取货车道是单行道：车从北头进、往南开，停在前面那辆车的后面（车道空着就开到最南头）；
  // 交付完要等前面的车开走才能走；四个取货位都满了就在车道口等
  const lane: Array<{ pos: number; leave: number }> = [];
  for (const v of visits) {
    const a = v.arrive - STAY_BEFORE;
    const b = v.leave + STAY_AFTER;
    if (v.kind === 'drive') {
      // 车道满了在车道口等；进去开到前面那辆车的后面（车道空着就开到最南头）
      let t = v.arrive;
      for (let guard = 0; guard < 20; guard++) {
        for (let k = lane.length - 1; k >= 0; k--) if ((lane[k] as { leave: number }).leave + 4 <= t) lane.splice(k, 1);
        if (!lane.length || Math.min(...lane.map((c) => c.pos)) > 0) break;
        t = Math.min(...lane.map((c) => c.leave)) + 4;
      }
      let pos = lane.length ? Math.min(...lane.map((c) => c.pos)) - 1 : lot.drive.length - 1;
      const stops = [{ t, pos }];
      const h = v.handoff ?? v.leave - 20;
      // 前面的车开走了就往前挪（交付前后那几十秒不挪，送框小车在车边）
      const ahead = lane.filter((c) => c.pos > pos).sort((a, b) => a.leave - b.leave);
      let tt = t;
      for (const c of ahead) {
        const free = c.leave + 4;
        if (free >= h - SERVE_HOLD - MOVE_UP) break;
        const front = Math.max(...lane.filter((o) => o.pos > pos && o.leave + 4 > free).map((o) => o.pos), -1);
        const to = front >= 0 ? front - 1 : lot.drive.length - 1;
        if (to <= pos) continue;
        tt = Math.max(tt + MOVE_UP, free + 1);
        if (tt >= h - SERVE_HOLD - MOVE_UP) break;
        pos = to;
        stops.push({ t: tt, pos });
      }
      const stuck = lane.filter((c) => c.pos > pos).map((c) => c.leave);
      const leave = Math.max(v.leave + (t - v.arrive), stuck.length ? Math.max(...stuck) + 4 : -Infinity);
      lane.push({ pos, leave });
      stays.push({ visit: v, stall: pos, mode: 'drive', arrive: t, leave, enter: v.arrive, drive: stops });
      continue;
    }
    if (v.kind === 'locker' || v.kind === 'pickup') {
      // 栅格 y → 本地 z（y − 35），找最近的即时取货车位；取货的车进出快，占用时段前后各留 10、20 秒
      const z = (v.bay?.y ?? 30) - 35;
      const p0 = lot.stalls[lot.pickup[0] as number] as Stall;
      const k0 = Math.max(0, Math.min(lot.pickup.length - 1, Math.round((z - p0.z) / PICKUP_PITCH)));
      const pa = v.arrive - 10;
      const pb = v.leave + 20;
      // 轨迹里的取货位对应的车位被前一辆占着（前后脚），用离它最近的空车位
      const order = lot.pickup.map((_, k) => k).sort((p, q) => Math.abs(p - k0) - Math.abs(q - k0) || p - q);
      const k = order.find((kk) => free(lot.pickup[kk] as number, pa, pb));
      if (k === undefined) {
        turnedAway.push(v);
        continue;
      }
      const idx = lot.pickup[k] as number;
      take(idx, pa, pb);
      stays.push({ visit: v, stall: idx, mode: 'head', arrive: v.arrive, leave: v.leave });
      continue;
    }
    if (isLong(v.kind)) {
      const kind = v.kind as LongKind;
      const bi = lot.long.findIndex((bay, i) => !(longFree[i] as Array<[number, number]>).some(([x, y]) => x < b + 60 && a - 60 < y) && bayCovers(bay, kind).every((s) => free(s, a - 30, b + 30)));
      if (bi < 0) {
        turnedAway.push(v);
        continue;
      }
      const covers = bayCovers(lot.long[bi] as (typeof lot.long)[number], kind);
      for (const s of covers) take(s, a - 30, b + 30);
      (longFree[bi] as Array<[number, number]>).push([a, b]);
      stays.push({ visit: v, stall: bi, mode: 'long', covers, arrive: v.arrive, leave: v.leave });
      continue;
    }
    if (v.kind === 'staff') {
      const s = staffList.find((x) => free(x.i, a, b)) ?? farGeneral.find((x) => free(x.i, a, b));
      if (!s) {
        turnedAway.push(v);
        continue;
      }
      take(s.i, a, b);
      stays.push({ visit: v, stall: s.i, mode: r() < 0.25 ? 'back' : 'head', arrive: v.arrive, leave: v.leave });
      continue;
    }
    // 购物的车：无障碍证 → 无障碍车位；电动车 → 充电车位；其余按权重挑一个空着的普通车位。
    // 车要在顾客进门之前停好（下车走到店门），顾客出门走回车上、装完车再开走：先按走一分钟估，挑好车位再按实际的路算
    const est = 110;
    const sa = (v.enter ?? v.arrive) - est - GET_OUT;
    const sb = (v.exit ?? v.leave) + est + LOAD;
    const fa = Math.min(a, sa - STAY_BEFORE);
    const fb = Math.max(b, sb + STAY_AFTER);
    let cand: Stall[] = [];
    if (v.accessible) cand = front.filter((s) => s.kind === 'accessible' && free(s.i, fa, fb));
    if (!cand.length && v.ev) cand = front.filter((s) => s.kind === 'ev' && free(s.i, fa, fb));
    if (!cand.length) cand = front.filter((s) => s.kind === 'general' && !longs.has(s.i) && free(s.i, fa, fb));
    if (!cand.length) cand = front.filter((s) => s.kind === 'general' && free(s.i, fa, fb));
    if (!cand.length) {
      turnedAway.push(v);
      continue;
    }
    // 权重的 4 次方：近处明显更满（离店门最近的一圈先停满，远处稀稀拉拉）
    const w = cand.map((s) => Math.pow(weight.get(s.i) ?? 1, 4));
    let pick = r() * w.reduce((x, y) => x + y, 0);
    let s = cand[cand.length - 1] as Stall;
    for (let k = 0; k < cand.length; k++) {
      pick -= w[k] as number;
      if (pick <= 0) {
        s = cand[k] as Stall;
        break;
      }
    }
    const walk = doorDistance(lot, s) / WALK_SPEED;
    // 购物车：约四分之一的顾客没推车（买得少）；推车的把车推回最近的回收栏再走回来，少数顺手放在车位旁
    const rc = r();
    let cart: Stay['cart'] = rc < 0.25 ? 'none' : rc < 0.31 ? 'stray' : 'corral';
    let corral: number | undefined;
    let cartTrip = cart === 'stray' ? 6 : 0;
    if (cart === 'corral' && lot.corrals.length) {
      const best = lot.corrals.map((c, ci) => ({ ci, d: Math.abs(c.x - s.x) + Math.abs(c.z - c.d / 2 - 0.6 - s.z) + 1.5 })).sort((a, b) => a.d - b.d)[0] as { ci: number; d: number };
      corral = best.ci;
      cartTrip = best.d / CART_SPEED + best.d / WALK_SPEED + 4;
    } else if (cart === 'corral') cart = 'stray';
    const arrive = Math.min(v.arrive, (v.enter ?? v.arrive) - walk - GET_OUT - SLACK_IN);
    const leave = Math.max(v.leave, (v.exit ?? v.leave) + walk + LOAD + cartTrip + GET_IN);
    take(s.i, Math.min(a, arrive - STAY_BEFORE), Math.max(b, leave + STAY_AFTER));
    const u = r();
    let mode: ParkMode = 'head';
    if (s.kind === 'general' && u < 0.12) mode = 'back';
    else if (s.kind === 'general' && u < 0.2) {
      const o = oppositeStall(lot, s);
      if (o && free(o.i, arrive - 40, arrive + 5)) {
        mode = 'through';
        // 穿过去的那一下也占一会儿对面的车位
        take(o.i, arrive - 40, arrive - 2);
      }
    }
    stays.push({ visit: v, stall: s.i, mode, arrive, leave, walk, cart, ...(corral !== undefined ? { corral } : {}), cartTrip });
  }
  return { stays, byStall, staffStalls: staff, turnedAway };
}

/**
 * 车停不进原来的车位（停好的时刻晚过顾客下车走开的时刻）：换一个前后都空着的车位（同一种车位、离店门的远近差不多，
 * 提前一会儿就空着，车可以早到在车里等；taken：车流里实际停着车的时段），顾客走的路、推车回收栏、几点能走按新车位重算；
 * 找不到返回 false
 */
export function moveStay(lot: StoreLot, plan: StayPlan, i: number, taken?: (stall: number, a: number, b: number) => boolean): boolean {
  const st = plan.stays[i];
  if (!st || st.walk === undefined || st.mode === 'drive' || st.mode === 'long') return false;
  const v = st.visit;
  const old = lot.stalls[st.stall] as Stall;
  const busy = (k: number, a: number, b: number) => (plan.byStall.get(k) ?? []).some(([x, y]) => x < b && a < y);
  const longs = new Set(lot.long.flatMap((b) => b.spots));
  const want = doorDistance(lot, old);
  // 先找提前 10 分钟就空着的，没有再放宽到提前半分钟
  let c: Stall | undefined;
  let early = 0;
  for (const e of [600, 240, 90, 30]) {
    const a0 = st.arrive - STAY_BEFORE - e;
    const b0 = st.leave + STAY_AFTER;
    c = lot.frontStalls
      .map((k) => lot.stalls[k] as Stall)
      .filter((x) => x.i !== st.stall && x.kind === old.kind && !longs.has(x.i) && !plan.staffStalls.has(x.i) && !busy(x.i, a0, b0) && !taken?.(x.i, a0, b0))
      .sort((x, y) => Math.abs(doorDistance(lot, x) - want) - Math.abs(doorDistance(lot, y) - want))[0];
    early = e;
    if (c) break;
  }
  if (!c) return false;
  // 退掉原来车位上的这一段（盖住这次停车的那一段），占上新车位
  const list = plan.byStall.get(st.stall) ?? [];
  const k = list.findIndex(([x, y]) => x <= st.arrive && y >= st.leave);
  if (k >= 0) list.splice(k, 1);
  const walk = doorDistance(lot, c) / WALK_SPEED;
  let cartTrip = st.cart === 'stray' ? 6 : 0;
  let corral: number | undefined;
  if (st.cart === 'corral' && lot.corrals.length) {
    const best = lot.corrals.map((r, ci) => ({ ci, d: Math.abs(r.x - c.x) + Math.abs(r.z - r.d / 2 - 0.6 - c.z) + 1.5 })).sort((x, y) => x.d - y.d)[0] as { ci: number; d: number };
    corral = best.ci;
    cartTrip = best.d / CART_SPEED + best.d / WALK_SPEED + 4;
  }
  st.stall = c.i;
  st.mode = 'head';
  st.walk = walk;
  st.cartTrip = cartTrip;
  if (corral !== undefined) st.corral = corral;
  st.arrive = Math.min(st.arrive, (v.enter ?? v.arrive) - walk - GET_OUT - SLACK_IN);
  st.leave = Math.max(st.leave, (v.exit ?? v.leave) + walk + LOAD + cartTrip + GET_IN);
  const nl = plan.byStall.get(c.i) ?? [];
  nl.push([st.arrive - STAY_BEFORE - early, st.leave + STAY_AFTER]);
  nl.sort((x, y) => x[0] - y[0]);
  plan.byStall.set(c.i, nl);
  return true;
}

