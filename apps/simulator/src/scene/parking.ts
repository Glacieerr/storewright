import { AISLE_W, aisleLaneZ, inLaneX, leaveLot, outLaneX, roundCorners, SPOT_D, SPOT_W, TimedPath, type LotLayout, type ParkingSpot, type PathLike, type PathState, type Pt, type RoadAccess } from './lot';

/**
 * 停车场里的各种停车方式（决策记录 0018）：
 * - 车头朝里停（大多数）、倒车入位（车尾朝里，走时直接开出去）、穿过对面空车位停（车头朝外）；
 * - 房车和拖着拖车的车：在最远一排车位的端头，沿车道把车靠右停在几个车位的前沿上（像在路边停车），
 *   一辆房车占 6 个车位，带拖车的占 7–8 个（都含车尾后面并进来用的一个）；进出都不用倒车，走时继续向前开到环形车道。
 * 纯函数，坐标与场景一致；车辆的参考点是车身中心。
 */

const LOT_SPEED = 4.2;
const LONG_SPEED = 3.2;
const ROAD_SPEED = 11;

export type LongKind = 'rv' | 'camper' | 'boat' | 'utility';

/** 长车位：最远一排的下半排（从最外侧车道驶入）两端，各一个；dir = +1 时车头朝 +X（从西边开进来，往东开走） */
export interface LongBay {
  dir: 1 | -1;
  /** 占用的车位（lot.spots 下标），从车尾一侧到车头一侧 */
  spots: number[];
  /** 车位前沿所在的车道中心 z、车辆停放的中线 z */
  aisleZ: number;
  parkZ: number;
  /** 车位范围（x）：车尾一端、车头一端 */
  xTail: number;
  xHead: number;
}

/**
 * 长车位占几个车位（含车尾后面留出的一个车位，靠进来时从那里斜着并进去，不碰旁边停着的车）：
 * 房车 6 个，带房车拖挂或船的 8 个，带小平板拖车的 7 个
 */
export const LONG_SPOTS: Record<LongKind, number> = { rv: 6, camper: 8, boat: 8, utility: 7 };

export function longBays(lot: LotLayout): LongBay[] {
  const rows = lot.aisles.length - 1;
  if (rows < 1) return [];
  const aisleZ = lot.aisles[rows] as number;
  // 最远一排的下半排：车头朝 +Z（朝门店），从最外侧的车道驶入
  const row = lot.spots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'general' && s.aisle === rows && s.heading === 0)
    .sort((a, b) => a.s.x - b.s.x);
  const n = Math.max(...Object.values(LONG_SPOTS));
  if (row.length < 2 * n + 2) return [];
  // 中间不能夹着购物车回收栏：相邻两个车位的 x 差应为一个车位宽
  const contiguous = (list: typeof row) => list.every((e, k) => k === 0 || Math.abs(e.s.x - (list[k - 1] as (typeof row)[number]).s.x - SPOT_W) < 0.05);
  const out: LongBay[] = [];
  const front = (row[0] as (typeof row)[number]).s.z - SPOT_D / 2;
  const parkZ = front + 1.4;
  const east = row.slice(-n);
  if (contiguous(east)) out.push({ dir: 1, spots: east.map((e) => e.i), aisleZ, parkZ, xTail: (east[0] as (typeof row)[number]).s.x - SPOT_W / 2, xHead: (east[east.length - 1] as (typeof row)[number]).s.x + SPOT_W / 2 });
  const west = row.slice(0, n).reverse();
  if (contiguous([...west].reverse())) out.push({ dir: -1, spots: west.map((e) => e.i), aisleZ, parkZ, xTail: (west[0] as (typeof row)[number]).s.x + SPOT_W / 2, xHead: (west[west.length - 1] as (typeof row)[number]).s.x - SPOT_W / 2 });
  return out;
}

/** 长车位里实际占用的车位（按车型，从车头一端数） */
export function bayCovers(bay: LongBay, kind: LongKind): number[] {
  return bay.spots.slice(bay.spots.length - LONG_SPOTS[kind]);
}

const lotSpeed = (lot: LotLayout, v: number) => (a: Pt, b: Pt) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? ROAD_SPEED : v);

/**
 * 长车（房车、带拖车的车）：主路 → 一端的环形车道 → 最外侧车道 → 靠右停进长车位（车头离车位端头 0.8 米）；
 * 走时向左驶回车道、继续向前开到另一端的环形车道 → 主路。front：车辆参考点到车头的距离；need：占用几个车位。
 */
/** 斜着并进长车位的位置：从占用车位的尾端往前 at 米开始，len 米内并进去（按车型试出来的，车身不越出占用的车位） */
export const LONG_MERGE: Record<LongKind, { at: number; len: number }> = { rv: { at: 0, len: 8 }, camper: { at: 2, len: 7 }, boat: { at: 2, len: 7 }, utility: { at: 0, len: 7 } };

export function longPaths(lot: LotLayout, road: RoadAccess, bay: LongBay, front: number, need: number, fromLeft: boolean, toLeft: boolean, merge: { at: number; len: number } = LONG_MERGE.rv): { entry: TimedPath; exit: PathLike; parked: { x: number; z: number; heading: number } } {
  const d = bay.dir;
  const pxIn = d > 0 ? lot.perimeterX[0] : lot.perimeterX[1];
  const pxOut = d > 0 ? lot.perimeterX[1] : lot.perimeterX[0];
  const stopX = bay.xHead - d * (0.8 + front);
  const parked = { x: stopX, z: bay.parkZ, heading: d > 0 ? Math.PI / 2 : -Math.PI / 2 };
  const inLane = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  // 先贴着车位一侧开（车身离车位前沿 0.3 米），让拖车摆直；到长车位的尾端再靠右横移进去，
  // 车身进入车位范围时已经在长车位里（不碰旁边停着的车）
  const front0 = bay.aisleZ + AISLE_W / 2;
  const hugZ = front0 - 1.55;
  // 占用的这几个车位的尾端（从这里斜着并进去）
  const tail = bay.xHead - d * need * SPOT_W;
  const hugFrom = tail - d * 36;
  const lead = d > 0 ? Math.max(pxIn + 10, hugFrom) : Math.min(pxIn - 10, hugFrom);
  // 从主路拐进环形车道后直接拐进最外侧车道（大车转弯半径大，不在路边多拐一下）
  const entry = new TimedPath(
    roundCorners(
      [
        { x: startX, z: inLane },
        { x: inLaneX(pxIn), z: inLane },
        // 拐进车道时走车道靠路的一半，车头不扫到第一个车位
        { x: inLaneX(pxIn), z: bay.aisleZ - 1.6 },
        { x: lead, z: bay.aisleZ - 1.6 },
        { x: lead + d * 14, z: hugZ },
        { x: tail + d * merge.at, z: hugZ },
        { x: tail + d * (merge.at + merge.len), z: bay.parkZ },
        { x: stopX, z: bay.parkZ },
      ],
      6,
    ),
    lotSpeed(lot, LONG_SPEED),
    false,
    { accel: 1.0, decel: 1.6, lat: 1.2, wheelbase: 4.5, v0: 'cap' },
  );
  // 走时：向左驶回车道、继续向前到另一端的环形车道，在路边停下让行，再拐上主路
  const exit = leaveLot(
    lot,
    road,
    [
      { x: stopX, z: bay.parkZ },
      { x: stopX + d * 4, z: bay.parkZ },
      { x: stopX + d * 12, z: bay.aisleZ },
      { x: outLaneX(pxOut), z: bay.aisleZ },
    ],
    pxOut,
    toLeft,
    { lotSpeed: LONG_SPEED, stopSec: 4, radius: 6, dyn: { accel: 1.0, decel: 1.6, lat: 1.2, wheelbase: 4.5 } },
  );
  return { entry, exit, parked };
}

/**
 * 拖车的运动学：车辆沿路径行驶，挂钩球头在车辆参考点后方 hitch 米处，
 * 拖车（挂钩到车轴 axle 米）的航向按 dθ/ds = sin(θ挂钩运动方向 − θ拖车) / axle 积分；按时间确定，可以拖动时间轴。
 */
export class TowRig {
  private readonly ts: number[] = [];
  private readonly th: number[] = [];

  constructor(
    readonly path: PathLike,
    readonly hitch: number,
    readonly axle: number,
    trailer0?: number,
  ) {
    const st: PathState = { x: 0, z: 0, heading: 0 };
    path.at(0, st);
    let th = trailer0 ?? st.heading;
    let hx = st.x - hitch * Math.sin(st.heading);
    let hz = st.z - hitch * Math.cos(st.heading);
    const step = 0.1;
    for (let t = 0; t <= path.duration + step; t += step) {
      path.at(Math.min(t, path.duration), st);
      const nx = st.x - hitch * Math.sin(st.heading);
      const nz = st.z - hitch * Math.cos(st.heading);
      const dx = nx - hx;
      const dz = nz - hz;
      const ds = Math.hypot(dx, dz);
      if (ds > 1e-6) {
        let diff = Math.atan2(dx, dz) - th;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        th += (ds / axle) * Math.sin(diff);
      }
      hx = nx;
      hz = nz;
      this.ts.push(Math.min(t, path.duration));
      this.th.push(th);
    }
  }

  /** 时刻 τ 的拖车航向 */
  trailerAt(tau: number): number {
    const t = Math.min(this.path.duration, Math.max(0, tau));
    const k = Math.min(this.ts.length - 2, Math.max(0, Math.floor(t / 0.1)));
    const a = this.th[k] as number;
    const b = this.th[k + 1] ?? a;
    const f = Math.min(1, Math.max(0, (t - (this.ts[k] as number)) / 0.1));
    return a + (b - a) * f;
  }

  end(): number {
    return this.th[this.th.length - 1] ?? 0;
  }
}

// ---------------- 普通车位的倒车入位、穿过对面空车位 ----------------

/** 车位所在的车道中心 z 与「驶入方向」（车头朝 +Z 的车位从下方车道向 +Z 驶入） */
function aisleOf(lot: LotLayout, spot: ParkingSpot): { aisleZ: number; into: number } {
  return { aisleZ: lot.aisles[spot.aisle] as number, into: Math.abs(spot.heading) < 0.01 ? 1 : -1 };
}

/**
 * 倒车入位：沿车道开过车位一个车身停下，打方向倒进车位，停好后车头朝车道（离开时直接开出去）。
 * 返回 [前进到倒车起点, 倒进车位]。
 */
export function backInPaths(lot: LotLayout, road: RoadAccess, spot: ParkingSpot, fromLeft: boolean): [TimedPath, TimedPath] {
  const { aisleZ, into } = aisleOf(lot, spot);
  const side = Math.abs(spot.x - lot.perimeterX[0]) <= Math.abs(spot.x - lot.perimeterX[1]) ? 0 : 1;
  const px = lot.perimeterX[side];
  const laneZ = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  const dir = Math.sign(spot.x - px) || 1;
  // 开过车位 5.5 米，车头略向车位的对侧偏，方便倒车（进场车道、车位间车道都靠右）
  const pastX = spot.x + dir * 5.5;
  const approach = new TimedPath(
    roundCorners(
      [
        { x: startX, z: laneZ },
        { x: inLaneX(px), z: laneZ },
        { x: inLaneX(px), z: lot.edgeZ },
        { x: inLaneX(px), z: aisleLaneZ(aisleZ, dir) },
        { x: pastX - dir * 3, z: aisleLaneZ(aisleZ, dir) },
        { x: pastX, z: aisleZ - into * 0.9 },
      ],
      3,
    ),
    lotSpeed(lot, LOT_SPEED),
    false,
    { v0: 'cap' },
  );
  const back = new TimedPath(
    roundCorners(
      [
        { x: pastX, z: aisleZ - into * 0.9 },
        { x: spot.x + dir * 1.2, z: aisleZ + into * 0.6 },
        { x: spot.x, z: aisleZ + into * 2.8 },
        { x: spot.x, z: spot.z },
      ],
      2.6,
    ),
    () => 1.4,
    true,
  );
  return [approach, back];
}

/** 穿过对面的空车位停进来：从对面车道驶入，车头朝外停好（离开时直接向前开出） */
export function pullThroughPath(lot: LotLayout, road: RoadAccess, spot: ParkingSpot, fromLeft: boolean): TimedPath {
  const { into } = aisleOf(lot, spot);
  // 对面车道：车头朝 +Z 的车位从下方车道驶入，穿过停进来时从上方车道来（反过来也一样）
  const otherAisle = into > 0 ? spot.aisle - 1 : spot.aisle + 1;
  const aisleZ = (lot.aisles[otherAisle] ?? lot.aisles[spot.aisle]) as number;
  const side = Math.abs(spot.x - lot.perimeterX[0]) <= Math.abs(spot.x - lot.perimeterX[1]) ? 0 : 1;
  const px = lot.perimeterX[side];
  const laneZ = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  const dir = Math.sign(spot.x - px) || 1;
  const enter = -into;
  return new TimedPath(
    roundCorners(
      [
        { x: startX, z: laneZ },
        { x: inLaneX(px), z: laneZ },
        { x: inLaneX(px), z: lot.edgeZ },
        { x: inLaneX(px), z: aisleLaneZ(aisleZ, dir) },
        { x: spot.x - dir * 2.4, z: aisleLaneZ(aisleZ, dir) },
        { x: spot.x, z: aisleZ + enter * 2.4 },
        { x: spot.x, z: spot.z },
      ],
      3,
    ),
    lotSpeed(lot, LOT_SPEED),
    false,
    { v0: 'cap' },
  );
}

/**
 * 车头朝外停着的车直接向前开出：驶入车头前方的车道（倒车入位和穿过停进来的车，车头都朝着这个车位本来的车道），
 * 转向要去的一侧出口
 */
export function forwardExitPath(lot: LotLayout, road: RoadAccess, spot: ParkingSpot, toLeft: boolean): PathLike {
  const { aisleZ, into } = aisleOf(lot, spot);
  const out = -into;
  const px = lot.perimeterX[toLeft ? 0 : 1];
  const dir = Math.sign(px - spot.x) || 1;
  const az = aisleLaneZ(aisleZ, dir);
  return leaveLot(lot, road, [{ x: spot.x, z: spot.z }, { x: spot.x, z: aisleZ - out * 2.2 }, { x: spot.x + dir * 2.6, z: az }, { x: outLaneX(px), z: az }], px, toLeft);
}

/** 对面的车位（同一列、背靠背的那一个），没有时返回 -1 */
export function facingSpot(lot: LotLayout, idx: number): number {
  const s = lot.spots[idx];
  if (!s || s.kind !== 'general') return -1;
  const into = Math.abs(s.heading) < 0.01 ? 1 : -1;
  const z = s.z + into * SPOT_D;
  return lot.spots.findIndex((o) => o.kind === 'general' && Math.abs(o.x - s.x) < 0.05 && Math.abs(o.z - z) < 0.05);
}
