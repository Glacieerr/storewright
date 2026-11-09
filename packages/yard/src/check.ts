import type { PathLike, PathState, Pt, RigPose, YardPlan } from './index';
import { angDiff, minRadius, obbIntersects } from './geom';
import { backOf, dimsOf, footprint, frontOf, overhangOf } from './rig';
import { dockedPose } from './setup';
import { lanePose, type YardRoute } from './routes';

/**
 * 场地和路线的检查（测试用，场地搭建者也可以在开发时跑一遍）：
 * - 路线：车道走完（车头外摆停下）和倒车起点接得上；倒车时铰接角不超过 65°、车身不碰两边门口停着的车（留 0.15 米）、
 *   车尾进到两边车头之间时挂车已经摆正、挂车在 alignZ 以外摆正、牵引车车头不进待命车道；靠稳时正对门、车尾离墙约 0.6 米；
 *   拉出时不碰两边的车；进场车道（到靠台车道起点）、驶离路线的转弯半径（相隔 3 米三点的外接圆）不小于 11.5 米；
 * - 场地：车道从墙往外依次排开、待命车位和甩挂车位在场地里、每个门属于一个区段。
 */
export interface RouteCheck {
  ok: boolean;
  problems: string[];
  /** 车道终点和倒车起点的位置差、挂车朝向差 */
  startGap: number;
  startTrailerGap: number;
  maxArtic: number;
  /** 挂车最后一次还没摆正时车轴离墙多远 */
  alignedAt: number;
  minRadius: { lane: number; exit: number };
}

const DEG = Math.PI / 180;
const newPose = (): RigPose => ({ x: 0, z: 0, heading: 0, trailer: 0, reversing: false, speed: 0, steer: 0 });

function pathPts(path: PathLike, step = 0.5): Pt[] {
  const st: PathState = { x: 0, z: 0, heading: 0 };
  const out: Pt[] = [];
  for (let t = 0; t <= path.duration + 1e-6; t += step) {
    path.at(Math.min(path.duration, t), st);
    const last = out[out.length - 1];
    if (!last || Math.hypot(st.x - last.x, st.z - last.z) > 0.2) out.push({ x: st.x, z: st.z });
  }
  return out;
}

/** Check one route: body clearance to vehicles at the neighbouring doors, articulation angle, trailer squared in time, cab out of the staging lane, turning radii. 检查一条路线。 */
export function checkRoute(p: YardPlan, r: YardRoute, opts: { rigRadius?: number } = {}): RouteCheck {
  const problems: string[] = [];
  const d = r.dims;
  const design = dimsOf(p.design);
  const neighbours = p.doors.filter((q) => Math.abs(q.x - r.doorX) > 0.01).flatMap((q) => footprint(design, dockedPose(design, q.x)));
  // 1. 车道终点和倒车起点
  const a = newPose();
  lanePose(r, r.lane.length, a);
  const b = newPose();
  r.back.rig.poseAt(0, b);
  const startGap = Math.hypot(a.x - b.x, a.z - b.z);
  const startTrailerGap = Math.abs(angDiff(a.trailer, b.trailer));
  if (startGap > 0.6) problems.push(`倒车起点和车道终点差 ${startGap.toFixed(2)} 米`);
  if (startTrailerGap > 0.08) problems.push(`倒车起步挂车朝向跳了 ${(startTrailerGap / DEG).toFixed(1)}°`);
  // 2. 倒车
  const p0 = newPose();
  let maxArtic = 0;
  let alignedAt = -Infinity;
  const back = backOf(d);
  const axleBack = d.kind === 'rig' ? d.axle : 0;
  const nose = frontOf(d);
  const zQ = Number.isFinite(p.zQueue) ? p.zQueue - 1.3 : Infinity;
  let hit = 0;
  let noseIn = false;
  let notAligned = false;
  for (let s = 0; s <= r.back.rig.length + 1e-6; s += 0.25) {
    r.back.rig.poseAt(s, p0);
    maxArtic = Math.max(maxArtic, Math.abs(angDiff(p0.trailer, p0.heading)));
    for (const box of footprint(d, p0)) for (const n of neighbours) if (obbIntersects(box, n, 0.15)) hit++;
    const rz = p0.z - back * Math.cos(p0.trailer);
    if (rz < p.noseLine + 0.5 && Math.abs(angDiff(p0.trailer, 0)) > 0.06) notAligned = true;
    if (Math.abs(angDiff(p0.trailer, 0)) > 0.02) alignedAt = Math.max(alignedAt, p0.z - axleBack * Math.cos(p0.trailer));
    if (p0.z + nose * Math.cos(p0.heading) > zQ) noseIn = true;
  }
  if (maxArtic > 65 * DEG) problems.push(`倒车时铰接角到了 ${(maxArtic / DEG).toFixed(0)}°`);
  if (hit) problems.push(`倒车时车身碰到两边停着的车（${hit} 次采样）`);
  if (notAligned) problems.push('车尾进到两边车头之间时挂车还没摆正');
  if (d.kind === 'rig' && alignedAt > -Infinity && alignedAt < p.alignZ - 0.01) problems.push(`挂车在离墙 ${alignedAt.toFixed(1)} 米处才摆正（要在 ${p.alignZ.toFixed(1)} 米以外）`);
  if (noseIn) problems.push('倒车时牵引车车头进了待命车道');
  // 3. 靠稳
  const pk = r.parked;
  const rearZ = pk.z - back * Math.cos(pk.trailer);
  if (Math.abs(angDiff(pk.trailer, 0)) > 0.03) problems.push('靠稳时没有正对门');
  if (Math.abs(pk.x - r.doorX) > 0.1) problems.push('靠稳时没对准门');
  if (rearZ < 0.3 || rearZ > 0.9) problems.push(`靠稳时车尾离墙 ${rearZ.toFixed(2)} 米`);
  // 4. 拉出驶离：在驶离车道以内不碰两边的车
  const st: PathState = { x: 0, z: 0, heading: 0 };
  let exitHit = 0;
  for (let t = 0; t <= r.exit.path.duration; t += 0.25) {
    r.exit.path.at(t, st);
    r.exit.rig.poseAt(st.dist ?? 0, p0);
    if (p0.z > p.zExit + 3) break;
    for (const box of footprint(d, p0)) for (const n of neighbours) if (obbIntersects(box, n, 0.15)) exitHit++;
  }
  if (exitHit) problems.push(`拉出时车身碰到两边停着的车（${exitHit} 次采样）`);
  // 5. 转弯半径：进场车道到靠台车道起点、驶离全程
  const sCourt = r.lane.nearest({ x: p.xTurnDock, z: p.zCourt });
  const laneR = minRadius(r.lane.slice(0, sCourt));
  const exitR = minRadius(pathPts(r.exit.path));
  // 铰接车按 11.5 米，单体车按它自己的最小转弯半径（轴距 / tan 35°，再留一点）
  const need = d.kind === 'rig' ? (opts.rigRadius ?? 11.5) : Math.max(5, d.wheelbase / Math.tan(35 * DEG) - 0.5);
  if (laneR < need) problems.push(`进场车道最急的转弯半径 ${laneR.toFixed(1)} 米`);
  if (exitR < need) problems.push(`驶离路线最急的转弯半径 ${exitR.toFixed(1)} 米`);
  void overhangOf;
  return { ok: problems.length === 0, problems, startGap, startTrailerGap, maxArtic, alignedAt, minRadius: { lane: laneR, exit: exitR } };
}

/**
 * 场地布置的检查：车道顺序、车位和甩挂车位在场地里、区段覆盖每个门
 * Check a plan: lane order, staging and drop stalls inside the yard, sections covering every door.
 */
export function checkPlan(p: YardPlan): string[] {
  const out: string[] = [];
  const zs = [0, p.zCourt, p.zExit, p.zQueue, p.zTop].filter((z) => Number.isFinite(z));
  for (let i = 1; i < zs.length; i++) if (!((zs[i] as number) > (zs[i - 1] as number))) out.push('车道没有从墙往外依次排开');
  if (!(p.z1 > (zs[zs.length - 1] as number))) out.push('场地外沿在最外面的车道以内');
  if (p.alignZ < p.noseLine) out.push('摆正线在车头线以内');
  for (let j = 0; j < p.queue.slots; j++) {
    const nose = p.queue.xHead + j * p.queue.pitch;
    if (nose < p.x0 - 0.01 || nose + p.queue.pitch - 3 > p.x1 + 0.01) out.push(`待命车位 ${j + 1} 超出场地`);
  }
  const design = dimsOf(p.design);
  const tl = design.kind === 'rig' ? design.trailerFront + design.rear : 0;
  for (const s of p.stalls) if (s.x - 1.9 < p.x0 || s.x + 1.9 > p.x1 || s.z + (design.kind === 'rig' ? design.rear - design.axle : 0) > p.z1 + 0.01) out.push(`${s.id} 超出场地`);
  void tl;
  for (const d of p.doors) {
    const sec = p.sections[d.section];
    if (!sec || d.x < sec.x0 - 1e-6 || d.x > sec.x1 + 1e-6) out.push(`${d.id} 不在自己的区段里`);
  }
  return out;
}
