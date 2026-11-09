import type { Pt, Stall, StoreLot } from './lot';
import { AISLE_W } from './lot';
import { CART_SPEED, GET_IN, LOAD, WALK_SPEED, type Stay } from './stays';

/**
 * 停车场里的人（门店本地坐标，纯函数）：顾客下车走到店门（店里的仿真从门口接上）、出门推着购物车走回车上、装车、
 * 把购物车推回最近的回收栏再走回来（少数顺手放在车位旁）；员工走到店门；到自提柜取货的走到墙上的柜子再回来；
 * 回收员在回收栏攒满时走过去，把购物车串成一串推回店门（顺路收走放在车位旁的）。停车场里的车给这些人让行（motion.ts）。
 */
export interface Walk {
  id: number;
  t0: number;
  t1: number;
  pts: Pt[];
  cum: number[];
  /** 推着购物车、穿反光背心（员工、回收员）、衣服颜色的编号 */
  cart: boolean;
  vest: boolean;
  shirt: number;
}
/** 站着的人（在车尾装车）：位置、朝向 */
export interface Stand {
  id: number;
  t0: number;
  t1: number;
  x: number;
  z: number;
  heading: number;
  cart: boolean;
  shirt: number;
}
/** 回收员推回店门的一串购物车：沿 pts 走，车在回收员前面 */
export interface Train {
  t0: number;
  t1: number;
  n: number;
  pts: Pt[];
  cum: number[];
  corral: number;
}
export interface People {
  walks: Walk[];
  stands: Stand[];
  trains: Train[];
  /** 每个回收栏的购物车数随时间：[时刻, 车数] */
  corralLog: Array<Array<[number, number]>>;
  /** 顺手放在车位旁的购物车（到回收员收走、或下一辆车停进来为止） */
  strays: Array<{ x: number; z: number; t0: number; t1: number }>;
}

export function polyCum(pts: readonly Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as Pt).x - (pts[i - 1] as Pt).x, (pts[i] as Pt).z - (pts[i - 1] as Pt).z));
  return cum;
}
/** 折线上走过 s 米的位置和朝向 */
export function along(pts: readonly Pt[], cum: readonly number[], s: number): { x: number; z: number; h: number } {
  let i = 1;
  while (i < cum.length - 1 && (cum[i] as number) < s) i++;
  const a = pts[i - 1] as Pt;
  const b = (pts[i] ?? a) as Pt;
  const seg = (cum[i] ?? 0) - (cum[i - 1] as number);
  const f = seg > 1e-6 ? Math.min(1, Math.max(0, (s - (cum[i - 1] as number)) / seg)) : 1;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, h: Math.atan2(b.x - a.x, b.z - a.z) };
}
export function walkAt(w: Walk, t: number): { x: number; z: number; h: number } {
  const total = w.cum[w.cum.length - 1] as number;
  return along(w.pts, w.cum, Math.min(1, Math.max(0, (t - w.t0) / Math.max(0.5, w.t1 - w.t0))) * total);
}

export function planPeople(lot: StoreLot, stays: readonly Stay[], seed: number): People {
  const walks: Walk[] = [];
  const stands: Stand[] = [];
  const doorIn = lot.doors.entrance;
  const doorOut = lot.doors.exit;
  const returns: Array<{ t: number; c: number }> = [];
  const strays: People['strays'] = [];
  const mk = (id: number, t0: number, t1: number, pts: Pt[], cart: boolean, vest: boolean, shirt: number) => walks.push({ id, t0, t1: Math.max(t0 + 2, t1), pts, cum: polyCum(pts), cart, vest, shirt });
  stays.forEach((st, id) => {
    const v = st.visit;
    const shirt = (id * 7 + seed) % 10;
    if ((v.kind === 'shopper' || v.kind === 'dept' || v.kind === 'staff') && st.mode !== 'long' && st.mode !== 'drive') {
      const s = lot.stalls[st.stall] as Stall;
      if (!s) return;
      const az = lot.aisles[s.aisle] as number;
      const edge = az - Math.sign(az - s.z) * (AISLE_W / 2 - 0.7);
      // 车尾（车头朝里的车尾在车道一侧）、驾驶座一侧
      const nose = { x: Math.sin(st.mode === 'head' ? s.heading : s.heading + Math.PI), z: Math.cos(st.mode === 'head' ? s.heading : s.heading + Math.PI) };
      const trunk = { x: s.x - nose.x * 2.9, z: s.z - nose.z * 2.9 };
      const side = { x: s.x + Math.cos(s.heading) * 1.3, z: s.z - Math.sin(s.heading) * 1.3 };
      const toDoor = (door: Pt): Pt[] => [side, { x: side.x, z: edge }, { x: lot.walkX, z: edge }, { x: lot.walkX, z: lot.frontZ - 0.8 }, { x: door.x, z: door.z + 0.6 }];
      const inPts = toDoor(doorIn);
      const inLen = polyCum(inPts)[inPts.length - 1] as number;
      const enter = v.enter ?? st.arrive + 15 + inLen / WALK_SPEED;
      const vest = v.kind === 'staff';
      mk(id, Math.max(st.arrive + 12, enter - inLen / WALK_SPEED), enter, inPts, false, vest, shirt);
      const cart = !!st.cart && st.cart !== 'none';
      const outPts = [...toDoor(doorOut)].reverse();
      outPts[outPts.length - 1] = cart ? { x: trunk.x, z: trunk.z } : side;
      const outLen = polyCum(outPts)[outPts.length - 1] as number;
      const exit = v.exit ?? st.leave - LOAD - outLen / WALK_SPEED - GET_IN - (st.cartTrip ?? 0);
      const atCar = exit + outLen / WALK_SPEED;
      mk(id, exit, atCar, outPts, cart, vest, shirt);
      if (!cart) return;
      // 装车，然后把购物车推回回收栏、走回来（少数顺手放在车位旁）
      stands.push({ id, t0: atCar, t1: atCar + LOAD, x: trunk.x, z: trunk.z, heading: Math.atan2(nose.x, nose.z), cart: true, shirt });
      const t1 = atCar + LOAD;
      if (st.cart === 'corral' && st.corral !== undefined) {
        const c = lot.corrals[st.corral] as StoreLot['corrals'][number];
        const mouth = { x: c.x, z: c.z - c.d / 2 - 0.6 };
        const go = [{ x: trunk.x, z: trunk.z }, { x: trunk.x, z: edge }, { x: mouth.x, z: edge }, mouth];
        const goLen = polyCum(go)[go.length - 1] as number;
        mk(id, t1, t1 + goLen / CART_SPEED, go, true, false, shirt);
        returns.push({ t: t1 + goLen / CART_SPEED, c: st.corral });
        const back = [mouth, { x: mouth.x, z: edge }, { x: side.x, z: edge }, side];
        mk(id, t1 + goLen / CART_SPEED + 2, st.leave - GET_IN + 2, back, false, false, shirt);
      } else {
        // 放在车位靠车道的角上（下一辆车停进来时被挪走）
        const next = stays.find((o) => o.mode !== 'drive' && o.mode !== 'long' && o.stall === st.stall && o.arrive > st.leave);
        strays.push({ x: trunk.x + Math.cos(s.heading) * 1.4, z: trunk.z - Math.sin(s.heading) * 1.4, t0: t1, t1: Math.min(next ? next.arrive - 30 : Infinity, t1 + 2 * 3600) });
      }
    } else if (v.kind === 'locker' && st.mode !== 'drive') {
      const s = lot.stalls[st.stall] as Stall;
      if (!s) return;
      const a = { x: s.x - 1.2, z: s.z + 1.4 };
      const b = { x: lot.west.walkX + 0.6, z: s.z + 0.4 };
      const h = v.handoff ?? st.leave;
      mk(id, st.arrive + 12, st.arrive + 16, [a, b], false, false, shirt);
      mk(id, h - 6, h - 2, [b, a], false, false, shirt);
    }
  });
  // 回收栏：攒到 12 辆以上，回收员从店门走过去，串成一串推回店门（顺路收走车位旁的）
  const corralLog = lot.corrals.map(() => [[0, 4] as [number, number]]);
  const trains: Train[] = [];
  const counts = lot.corrals.map(() => 4);
  let busy = 0;
  for (const r of returns.sort((a, b) => a.t - b.t)) {
    counts[r.c] = (counts[r.c] as number) + 1;
    (corralLog[r.c] as Array<[number, number]>).push([r.t, counts[r.c] as number]);
    if ((counts[r.c] as number) < 12 || r.t <= busy || r.t < 8 * 3600 || r.t > 22 * 3600) continue;
    const c = lot.corrals[r.c] as StoreLot['corrals'][number];
    const out = [{ x: doorOut.x + 1, z: doorOut.z + 1.2 }, { x: lot.walkX + 1.2, z: lot.frontZ - 0.6 }, { x: lot.walkX + 1.2, z: c.aisleZ }, { x: c.x, z: c.aisleZ }, { x: c.x, z: c.z - c.d / 2 - 0.5 }];
    const cum = polyCum(out);
    const len = cum[cum.length - 1] as number;
    const t0 = r.t + 60;
    const tPick = t0 + len / 1.2;
    const n = counts[r.c] as number;
    walks.push({ id: -1, t0, t1: tPick, pts: out, cum, cart: false, vest: true, shirt: 0 });
    const back = [...out].reverse();
    const t1 = tPick + 25 + len / 0.9;
    trains.push({ t0: tPick + 25, t1, n, pts: back, cum: polyCum(back), corral: r.c });
    (corralLog[r.c] as Array<[number, number]>).push([tPick + 20, 0]);
    counts[r.c] = 0;
    busy = t1;
    for (const sy of strays) if (sy.t0 < tPick && sy.t1 > tPick) sy.t1 = tPick;
  }
  return { walks, stands, trains, corralLog, strays };
}

/** 一个回收栏此刻的购物车数 */
export function corralCount(p: People, ci: number, t: number): number {
  const log = p.corralLog[ci];
  if (!log) return 0;
  let n = 0;
  for (const [tt, c] of log) {
    if (tt > t) break;
    n = c;
  }
  return n;
}
