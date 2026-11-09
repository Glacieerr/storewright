import type { Pt, RigPose, VehicleDims } from './index';
import { DOCK_GAP } from './consts';
import { angDiff, dirOf, newPrepared, prepareOBB, preparedIntersects, type OBB, type PreparedOBB } from './geom';
import { BodyRig, footprint, ForwardRig, frontOf, ReverseRig, type DistRig } from './rig';

/**
 * 倒车靠台的准备动作（第一部分 Storewright 的 semiSetup，按车型尺寸推广）：沿靠台车道（向 +x）驶过门 → 车头向外（+z，右侧）摆
 * → 再直行一点停下 → 倒车：挂车车轴（单体车是后轴）先沿 θ + π 方向直退，再沿圆弧转到正对墙，在 alignZ 以外摆正，最后笔直退进门里。
 * 在几组候选（驶过多少、摆的半径和角度、摆完直行多少）里按评分挑；评分最好的几组再完整检查一遍：
 * 倒车时车身不碰两边门口停着的车、牵引车车头不越过 zLimit（待命车道）和 xMax、铰接角不超过 65°。
 * 都在「墙面坐标」里算：墙在 z = 0，靠台车道向 +x；甩挂车位用镜像的墙面坐标，同一套算法。
 */
export interface FaceGeo {
  /** 靠台车道（参考点走的线）z */
  zCourt: number;
  /** 车头摆出去时不能超过的 z（待命车道外沿）、x（场地边 / 进场道路） */
  zLimit: number;
  xMax: number;
  /** 挂车在这条线以外摆正；两边门口停着的车车头连成的线 */
  alignZ: number;
  noseLine: number;
  /** 两边门口停着的车（检查倒车时碰不碰） */
  parked: OBB[];
}

export interface DockSetup {
  /** 前进部分：从靠台车道上 lead 点起，驶过门、外摆、停下（参考点的路径） */
  fwd: Pt[];
  /** 倒车部分：车轴（挂车车轴组 / 后轴）从倒车起点到靠稳 */
  back: Pt[];
  /** 停下时（倒车起点）、靠稳时的位姿 */
  stop: RigPose;
  parked: RigPose;
  ok: boolean;
  /** 挂车摆正的位置（车轴 z）、最大铰接角 */
  alignedAt: number;
  maxArtic: number;
}

const DEG = Math.PI / 180;
/** inspect 用的车身矩形（反复用，不分配） */
const PREP_BOX: PreparedOBB = newPrepared();

/** 靠稳时的位姿：车尾离墙 DOCK_GAP，正对墙（朝 +z） */
export function dockedPose(d: VehicleDims, doorX: number): RigPose {
  const z = d.kind === 'rig' ? DOCK_GAP + d.rear : DOCK_GAP + d.rearOverhang;
  return { x: doorX, z, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
}
/** 靠稳时车轴（挂车车轴组 / 后轴）的位置 */
function dockedAxle(d: VehicleDims, doorX: number): Pt {
  return { x: doorX, z: DOCK_GAP + (d.kind === 'rig' ? d.rear - d.axle : d.rearOverhang) };
}

/** 倒车的车轴路径：从 A0（朝向 th）直退 s1、沿半径 R 的圆弧转到朝 +z、再直退到靠稳 */
function backPath(A0: Pt, th: number, doorX: number, end: Pt, R: number, s1: number): { pts: Pt[]; zEnd: number } {
  const B = { x: A0.x - s1 * Math.sin(th), z: A0.z - s1 * Math.cos(th) };
  const pts: Pt[] = [A0];
  if (s1 > 0.05) pts.push(B);
  const steps = Math.max(8, Math.ceil((th * R) / 0.5));
  for (let k = 1; k <= steps; k++) {
    const phi = th * (1 - k / steps);
    pts.push({ x: B.x - R * (Math.cos(phi) - Math.cos(th)), z: B.z - R * (Math.sin(th) - Math.sin(phi)) });
  }
  const zEnd = B.z - R * Math.sin(th);
  pts[pts.length - 1] = { x: doorX, z: zEnd };
  pts.push(end);
  return { pts, zEnd };
}

/** 检查一组倒车：每 0.25 米取一次位姿，看碰不碰停着的车、车头越不越界、铰接角、挂车什么时候摆正 */
function inspect(d: VehicleDims, rig: DistRig, geo: FaceGeo, parked: readonly PreparedOBB[] = geo.parked.map((n) => prepareOBB(n))): { ok: boolean; alignedAt: number; maxArtic: number } {
  const p: RigPose = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true, speed: 0, steer: 0 };
  let alignedAt = -Infinity;
  let maxArtic = 0;
  let ok = true;
  const back = d.kind === 'rig' ? d.rear : d.rearOverhang;
  const axleBack = d.kind === 'rig' ? d.axle : 0;
  // 停着的车的矩形预先算好（parked），车身的矩形每个位姿算一次；判断和 obbIntersects(box, n, 0.15) 一样
  const mine = PREP_BOX;
  for (let s = 0; s <= rig.length + 1e-6; s += 0.25) {
    rig.poseAt(s, p);
    const art = Math.abs(angDiff(p.trailer, p.heading));
    maxArtic = Math.max(maxArtic, art);
    if (art > 65 * DEG) ok = false;
    const nose = frontOf(d);
    if (p.z + nose * Math.cos(p.heading) > geo.zLimit || p.x + nose * Math.sin(p.heading) > geo.xMax) ok = false;
    // 已经不行了就不用再比（结果只看 ok）
    if (ok)
      for (const box of footprint(d, p)) {
        prepareOBB(box, mine);
        for (const n of parked)
          if (preparedIntersects(mine, n, 0.15)) {
            ok = false;
            break;
          }
        if (!ok) break;
      }
    // 车尾进到两边车头之间时必须已经摆正
    const rz = p.z - back * Math.cos(p.trailer);
    const az = p.z - axleBack * Math.cos(p.trailer);
    if (Math.abs(angDiff(p.trailer, 0)) > 0.02) alignedAt = Math.max(alignedAt, az);
    if (rz < geo.noseLine + 0.5 && Math.abs(angDiff(p.trailer, 0)) > 0.06) ok = false;
    if (!ok) break;
  }
  return { ok, alignedAt, maxArtic };
}

interface Template {
  /** 驶过门多远、前进和倒车路径（相对门，门在 x = 0；fwd 不含 lead）、倒车起点的位姿、牵引车最靠 +x 的位置、车头的 z */
  pass: number;
  fwd: Pt[];
  back: Pt[];
  stop: RigPose;
  maxX: number;
  frontZ: number;
  score: number;
}
const TEMPLATES = new Map<string, Template[]>();

/** 一种车、一条靠台车道的候选动作（和门的位置无关，只算一次） */
function templatesFor(d: VehicleDims, zCourt: number, zAlignT: number, endZ: number): Template[] {
  const key = `${JSON.stringify(d)}|${zCourt}|${zAlignT}|${endZ}`;
  const hit = TEMPLATES.get(key);
  if (hit) return hit;
  const rig = d.kind === 'rig';
  const L = rig ? d.axle : 0;
  const minR = rig ? 6 : Math.max(4.5, d.wheelbase / Math.tan(35 * DEG));
  const maxR = rig ? 14 : Math.max(minR + 2, 12);
  const end = { x: 0, z: endZ };
  const lead = { x: -40, z: zCourt };
  const nose = frontOf(d);
  // 单体车也可以没过门就外摆（大角度摆出去、停在门的斜上方，再一把倒进去），像小车倒进垂直车位
  const passes = rig ? [-4, -1, 2, 5, 8, 11, 14] : [-8, -5, -2, 2, 4, 6, 9];
  const radii = rig ? [8, 10, 13] : [Math.max(minR, 6), Math.max(minR, 8), Math.max(minR, 10)];
  const angles = rig ? [45, 60, 75, 90, 105] : [30, 40, 55, 70, 78];
  const runs = rig ? [1, 4, 8] : [0.5, 2, 4];
  const out: Template[] = [];
  for (const pass of passes)
    for (const rs of radii)
      for (const ang of angles)
        for (const run of runs) {
          const a = ang * DEG;
          // 车头向外（+z，右侧）摆：圆心在 (pass, zCourt + rs)
          const swing: Pt[] = [];
          const n = Math.max(6, Math.ceil((a * rs) / 0.75));
          for (let k = 1; k <= n; k++) {
            const t = (k / n) * a;
            swing.push({ x: pass + rs * Math.sin(t), z: zCourt + rs * (1 - Math.cos(t)) });
          }
          const sEnd = swing[swing.length - 1] as Pt;
          const dir = { x: Math.cos(a), z: Math.sin(a) };
          const stopPt = { x: sEnd.x + dir.x * run, z: sEnd.z + dir.z * run };
          const front = { x: stopPt.x + dir.x * nose, z: stopPt.z + dir.z * nose };
          const fwd = [{ x: pass, z: zCourt }, ...swing, stopPt];
          const stop = rig ? new ForwardRig([lead, ...fwd], L, Math.PI / 2).end() : new BodyRig([lead, ...fwd], false, d.wheelbase).end();
          const th = stop.trailer;
          if (th <= 0.2 || th >= Math.PI / 2 - 0.05) continue;
          const A0 = { x: stop.x - L * Math.sin(th), z: stop.z - L * Math.cos(th) };
          const span = A0.x;
          if (span <= 0.3) continue;
          // 圆弧半径：能放下的最大半径（倒车最从容）和几个小一点的（圆弧越小，摆正的位置离墙越远）
          const rMaxFit = Math.min(maxR, span / (1 - Math.cos(th)));
          for (const R of new Set([rMaxFit, Math.min(rMaxFit, minR * 1.1), Math.min(rMaxFit, (minR + maxR) / 2)])) {
            if (R < minR) continue;
            const s1 = Math.max(0, (span - R * (1 - Math.cos(th))) / Math.sin(th));
            const bp = backPath(A0, th, 0, end, R, s1);
            if (bp.zEnd < zAlignT || bp.zEnd < end.z + 0.5) continue;
            // 评分：摆正点离 alignZ 不远、半径适中、驶过门少、车头摆得不高
            const score = Math.abs(bp.zEnd - zAlignT - 2) * 0.5 + Math.max(0, minR + 3 - R) + Math.max(0, R - (maxR - 2)) * 0.5 + Math.abs(pass) * 0.1 + (front.z - zCourt) * 0.08 + run * 0.05;
            out.push({ pass, fwd, back: bp.pts, stop, maxX: Math.max(stopPt.x, front.x), frontZ: front.z, score });
          }
        }
  out.sort((x, y) => x.score - y.score);
  TEMPLATES.set(key, out);
  return out;
}

/**
 * 找一组能顺利倒进门的准备动作。lead：靠台车道上开始算挂车角度的点（门前 25 米以上，挂车已经摆直）。
 */
export function dockSetup(d: VehicleDims, doorX: number, geo: FaceGeo, leadX = doorX - 25, endAxle?: Pt): DockSetup {
  const rig = d.kind === 'rig';
  const L = rig ? d.axle : 0;
  const minR = rig ? 6 : Math.max(4.5, d.wheelbase / Math.tan(35 * DEG));
  // （最大摆动半径：铰接车 14 米、单体车 max(minR + 2, 12) 米——候选里用不到，只记在这里）
  const zAlignT = geo.alignZ + 0.5;
  const end = endAxle ?? dockedAxle(d, doorX);
  const lead = { x: Math.min(leadX, doorX - 6), z: geo.zCourt };
  const nose = frontOf(d);
  // 单体车也可以没过门就外摆（大角度摆出去、停在门的斜上方，再一把倒进去），像小车倒进垂直车位
  const parked = endAxle ? { ...dockedPose(d, doorX), z: end.z + L } : dockedPose(d, doorX);
  // 候选（相对门的位置算好、按评分排，长墙上每个门共用）；按这个门的场地边界过滤，评分最好的几组完整检查
  const near = geo.parked.filter((n) => Math.abs(n.x - doorX) < 45);
  const g2 = near.length === geo.parked.length ? geo : { ...geo, parked: near };
  const shift = (q: Pt): Pt => ({ x: q.x + doorX, z: q.z });
  let first: { c: Template; chk: ReturnType<typeof inspect> } | undefined;
  let tried = 0;
  const toSetup = (c: Template, ok: boolean, chk: ReturnType<typeof inspect>): DockSetup => ({ fwd: [lead, ...c.fwd.map(shift)], back: c.back.map(shift), stop: { ...c.stop, x: c.stop.x + doorX }, parked, ok, alignedAt: chk.alignedAt, maxArtic: chk.maxArtic });
  let prepared: PreparedOBB[] | undefined;
  for (const c of templatesFor(d, geo.zCourt, zAlignT, end.z)) {
    if (doorX + c.pass <= lead.x + 1) continue;
    if (doorX + c.maxX > geo.xMax || c.frontZ > geo.zLimit) continue;
    const back = c.back.map(shift);
    const rr = rig ? new ReverseRig(back, L, c.stop.heading) : new BodyRig(back, true, d.wheelbase);
    prepared ??= g2.parked.map((n) => prepareOBB(n));
    const chk = inspect(d, rr, g2, prepared);
    if (!first) first = { c, chk };
    if (chk.ok) return toSetup(c, true, chk);
    if (++tried >= 40) break;
  }
  if (first) return toSetup(first.c, false, first.chk);
  // 兜底：沿靠台车道驶过门直接倒（几乎不会用到）
  const stopX = Math.min(geo.xMax - nose - 1, doorX + 14 + L);
  const fwd = [lead, { x: stopX, z: geo.zCourt }];
  const stop: RigPose = { x: stopX, z: geo.zCourt, heading: Math.PI / 2, trailer: Math.PI / 2, reversing: false, speed: 0, steer: 0 };
  const back = [{ x: stopX - L, z: geo.zCourt }, { x: doorX + 4, z: geo.zCourt }, { x: doorX, z: Math.max(zAlignT, geo.zCourt - 6) }, end];
  return { fwd, back, stop, parked, ok: false, alignedAt: NaN, maxArtic: NaN };
}

/**
 * 从任意的倒车起点（停下时的位姿）重排倒车路径：车轴先直退、再沿圆弧转到朝 +z、在 x = doorX 摆正、直退到 end。
 * 前进路线换了（比如从车道起点一路积分挂车角度）以后，用实际停下的位姿重排，倒车起步不跳。放不下圆弧时返回 undefined。
 */
export function reverseFrom(d: VehicleDims, stop: RigPose, doorX: number, end: Pt, alignZ: number): { pts: Pt[]; zEnd: number } | undefined {
  const rig = d.kind === 'rig';
  const L = rig ? d.axle : 0;
  const minR = rig ? 6 : Math.max(4.5, d.wheelbase / Math.tan(35 * DEG));
  const maxR = rig ? 14 : Math.max(minR + 2, 12);
  const th = stop.trailer;
  if (th <= 0.05 || th >= Math.PI / 2 + 0.2) return undefined;
  const A0 = { x: stop.x - L * Math.sin(th), z: stop.z - L * Math.cos(th) };
  const span = A0.x - doorX;
  if (span <= 0.3) return undefined;
  const rMaxFit = Math.min(maxR, span / (1 - Math.cos(th)));
  for (const R of [rMaxFit, Math.min(rMaxFit, (minR + maxR) / 2), Math.min(rMaxFit, minR * 1.1), Math.min(rMaxFit, minR)]) {
    if (R < minR * 0.9) continue;
    const s1 = Math.max(0, (span - R * (1 - Math.cos(th))) / Math.sin(th));
    const bp = backPath(A0, th, doorX, end, R, s1);
    if (bp.zEnd >= alignZ && bp.zEnd >= end.z + 0.5) return bp;
  }
  return undefined;
}

/** 靠稳时车轴的位置（导出给路线用） */
export const dockedAxleAt = (d: VehicleDims, doorX: number): Pt => dockedAxle(d, doorX);

/** 两边门口停着的车（按设计车型停满，除了 doorX 这个门）的矩形 */
export function parkedNeighbours(d: VehicleDims, doors: readonly number[], doorX: number): OBB[] {
  const out: OBB[] = [];
  for (const x of doors) if (Math.abs(x - doorX) > 0.01) out.push(...footprint(d, dockedPose(d, x)));
  return out;
}

export { dirOf };
