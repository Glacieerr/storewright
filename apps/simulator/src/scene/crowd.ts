import { createRng } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';
import { nodeWorld, type StoreGeometry, type Vec3 } from './layout';
import type { Stay } from './shoppers';

/**
 * 到店购物的顾客：从停好的车走到门店入口，在店里逛几条通道，再回到车上开走。
 * 时间完全由停车时段决定（与停车场里的车辆一致），只用于画面，不进入订单仿真。
 */

interface Leg {
  t0: number;
  t1: number;
  pts: Vec3[];
  cum: number[];
  len: number;
  /** 这一段推着购物车 */
  cart: boolean;
}

export interface ShopperTrack {
  legs: Leg[];
  start: number;
  end: number;
  cart: boolean;
}

export interface ShopperPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  moving: boolean;
  cart: boolean;
}

function leg(pts: Vec3[], t0: number, t1: number, cart: boolean): Leg {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Vec3;
    const b = pts[i] as Vec3;
    cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.y - a.y) * 0.5);
  }
  return { t0, t1, pts, cum, len: cum[cum.length - 1] as number, cart };
}

const WALK = 1.25;

/** 门店的顾客入口：正面中部（交付门口在另一侧），以及离入口最近的店内节点 */
export function customerEntrance(model: StoreModel, geo: StoreGeometry): { outside: Vec3; node: number } {
  const f0 = geo.floors[0];
  const custom = model.config.outdoor.entranceX;
  const x = custom ?? (f0 ? f0.minX + (f0.maxX - f0.minX) * 0.42 : 10);
  const floorId = f0?.floorId ?? 'F1';
  let best = 0;
  let bestD = Infinity;
  for (const n of model.nodes) {
    if (n.floorId !== floorId) continue;
    const d = Math.hypot(n.x - x, n.y - 4);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  const nw = nodeWorld(model, geo.floorY, best);
  return { outside: { x: nw.x, y: 0, z: -1.5 }, node: best };
}

export function planShopper(model: StoreModel, geo: StoreGeometry, stay: Stay, index: number): ShopperTrack | undefined {
  const spot = geo.lot.spots[stay.spot];
  if (!spot) return undefined;
  const rng = createRng(index * 7919 + stay.spot * 31 + 17);
  const entrance = customerEntrance(model, geo);
  const node = (id: number) => nodeWorld(model, geo.floorY, id);
  // 驾驶员侧下车（车头方向的左侧）
  const side = { x: spot.x + Math.cos(spot.heading) * 1.4, y: 0, z: spot.z - Math.sin(spot.heading) * 1.4 };
  const cross = { x: entrance.outside.x, y: 0, z: geo.lot.fireLaneZ };
  const outsidePts: Vec3[] = [side, { x: side.x, y: 0, z: geo.lot.aisles[spot.aisle] ?? side.z }, cross, entrance.outside, node(entrance.node)];
  const outLen = leg(outsidePts, 0, 1, false).len;
  const walkSec = outLen / WALK;
  const tIn = stay.arrive + 25;
  const tDoor = tIn + walkSec;
  const tBack = stay.leave - 45 - walkSec;
  const legs: Leg[] = [leg(outsidePts, tIn, tDoor, false)];
  const cart = rng.chance(0.65);
  if (tBack - tDoor > 120) {
    // 店内：随机逛 3–6 个货位（偶尔上二楼），最后回到入口
    const locs = [...model.locations.values()];
    const stops = rng.int(3, 6);
    const route: number[] = [entrance.node];
    for (let k = 0; k < stops && locs.length; k++) route.push((locs[rng.int(0, locs.length - 1)] as (typeof locs)[number]).nodeId);
    route.push(entrance.node);
    const segs: Vec3[][] = [];
    for (let k = 1; k < route.length; k++) segs.push(walkBetween(model, geo, route[k - 1] as number, route[k] as number));
    // 结账：从入口附近走到一个收银通道，排队结账后再出门
    const lanes = geo.checkouts;
    if (lanes.length) {
      const lane = lanes[(index * 7 + stay.spot) % lanes.length] as (typeof lanes)[number];
      const last = segs[segs.length - 1];
      const from = last ? (last[last.length - 1] as Vec3) : node(entrance.node);
      segs.push([from, { x: lane.x, y: 0, z: lane.z + 2.2 }, { x: lane.x, y: 0, z: lane.z - 1.6 }, node(entrance.node)]);
    }
    const lens = segs.map((p) => leg(p, 0, 1, cart).len);
    const walkTotal = lens.reduce((a, b) => a + b, 0) / WALK;
    const window = tBack - tDoor;
    const speedUp = walkTotal > window ? walkTotal / window : 1;
    const pause = Math.max(0, (window - walkTotal / speedUp) / segs.length);
    let t = tDoor;
    segs.forEach((pts, k) => {
      const d = (lens[k] as number) / WALK / speedUp;
      legs.push(leg(pts, t, t + d, cart));
      t += d;
      // 在货架前挑选商品
      const last = pts[pts.length - 1] as Vec3;
      legs.push(leg([last], t, t + pause, cart));
      t += pause;
    });
  }
  const back = [...outsidePts].reverse();
  const tOut = Math.max(tDoor, tBack);
  legs.push(leg(back, tOut, tOut + walkSec, cart));
  return { legs, start: tIn, end: tOut + walkSec, cart };
}

/**
 * 顾客在两个节点之间的路线：同层走最短路径；跨层时优先乘最近的自动扶梯（上行、下行分开两条），
 * 没有扶梯时乘电梯（行走网络里的电梯连接）。
 */
function walkBetween(model: StoreModel, geo: StoreGeometry, a: number, b: number): Vec3[] {
  const node = (id: number) => nodeWorld(model, geo.floorY, id);
  const path = (x: number, y: number) => {
    const ids = model.path(x, y);
    return (ids.length ? ids : [y]).map(node);
  };
  const na = model.nodes[a];
  const nb = model.nodes[b];
  if (!na || !nb || na.floorId === nb.floorId) return path(a, b);
  const up = (geo.floorY.get(nb.floorId) ?? 0) > (geo.floorY.get(na.floorId) ?? 0);
  let best: { pts: Vec3[]; d: number } | undefined;
  for (const c of geo.connectors) {
    if (c.kind !== 'ESCALATOR' || !c.bottom || !c.top) continue;
    const ends = model.connectorNodes.get(c.id);
    if (!ends) continue;
    const [lower, upper] = ends;
    const start = up ? lower : upper;
    const end = up ? upper : lower;
    const d = model.distance(a, start) + model.distance(end, b);
    if (!Number.isFinite(d) || (best && d >= best.d)) continue;
    const dz = up ? -0.65 : 0.65;
    const ride = up
      ? [{ ...c.bottom, z: c.z + dz }, { ...c.top, z: c.z + dz }]
      : [{ ...c.top, z: c.z + dz }, { ...c.bottom, z: c.z + dz }];
    best = { pts: [...path(a, start), ...ride, ...path(end, b)], d };
  }
  return best ? best.pts : path(a, b);
}

/** 在时刻 t 的位置；不在时间范围内返回 false */
export function shopperPose(track: ShopperTrack, t: number, out: ShopperPose): boolean {
  if (t < track.start || t > track.end) return false;
  let lo = 0;
  let hi = track.legs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((track.legs[mid] as Leg).t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const l = track.legs[lo] as Leg;
  out.cart = l.cart;
  if (l.pts.length === 1 || l.len === 0 || t >= l.t1) {
    const p = l.pts[l.pts.length - 1] as Vec3;
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.moving = false;
    return true;
  }
  const d = ((t - l.t0) / Math.max(1e-6, l.t1 - l.t0)) * l.len;
  let i = 1;
  while (i < l.cum.length - 1 && (l.cum[i] as number) < d) i++;
  const a = l.pts[i - 1] as Vec3;
  const b = l.pts[i] as Vec3;
  const seg = (l.cum[i] as number) - (l.cum[i - 1] as number);
  const k = seg > 0 ? (d - (l.cum[i - 1] as number)) / seg : 1;
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-6) out.heading = Math.atan2(b.x - a.x, b.z - a.z);
  out.moving = true;
  return true;
}
