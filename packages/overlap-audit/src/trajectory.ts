import { obbFromHeading, type Quad } from './geom';
import type { Body } from './audit';

/**
 * A plain JSON trajectory format, so any engine (game engine, traffic simulator, your own code) can be audited.
 * 一个简单的 JSON 轨迹格式：任何引擎（游戏引擎、交通仿真、自己的代码）导出来都能审计。
 *
 * ```json
 * {
 *   "format": "overlap-audit/trajectories", "version": 1,
 *   "heading": "atan2",                      // or "yaw" (three.js style); default "atan2": 0 = facing +z
 *   "vehicles": [
 *     { "id": "T1", "type": "truck", "length": 12, "width": 2.5, "group": "rig-1",
 *       "frames": [ { "t": 0, "x": 0, "z": 0, "heading": 0 }, { "t": 30, "x": 0, "z": 120, "heading": 0 } ] }
 *   ],
 *   "snapshots": [ { "t": 0, "bodies": [ { "id": "P1", "type": "parked", "quad": [0,0, 0,12, 2.5,12, 2.5,0] } ] } ],
 *   "areas": [ { "name": "dock", "polygon": [[-20,-5],[60,-5],[60,40],[-20,40]] } ]
 * }
 * ```
 * - `frames`: (x, z) is the centre of the rectangle unless `"anchor": "rear"` (centre of the rear edge); positions are
 *   interpolated linearly, headings along the shorter arc; a vehicle exists from its first frame to its last.
 * - `snapshots`: bodies given directly at sample times (centre + heading + size, or `quad`); a snapshot holds until the next one.
 * - Bodies with the same `group` (tractor and trailer of one rig) never count against each other.
 * - `areas`: an overlap is filed under the first polygon containing the midpoint of the two centres, otherwise "other";
 *   without areas everything goes to "all".
 */
export interface Frame {
  t: number;
  x: number;
  z: number;
  heading: number;
}
export interface TrajVehicle {
  id: string;
  type: string;
  length: number;
  width: number;
  anchor?: 'center' | 'rear';
  group?: string;
  frames: Frame[];
}
export interface SnapBody {
  id: string;
  type: string;
  group?: string;
  quad?: number[];
  x?: number;
  z?: number;
  heading?: number;
  length?: number;
  width?: number;
}
export interface TrajectoryFile {
  format?: string;
  version?: number;
  heading?: 'atan2' | 'yaw';
  vehicles?: TrajVehicle[];
  snapshots?: { t: number; bodies: SnapBody[] }[];
  areas?: { name: string; polygon: [number, number][] }[];
}

export interface TrajData {
  id: string;
  group?: string;
  x: number;
  z: number;
}

/** Validate a parsed file; returns error messages (empty = fine). 检查文件，返回错误（空 = 没问题）。 */
export function validateTrajectories(f: unknown): string[] {
  const e: string[] = [];
  const o = f as TrajectoryFile;
  if (typeof f !== 'object' || f === null) return ['the file must contain a JSON object'];
  if (o.format !== undefined && o.format !== 'overlap-audit/trajectories') e.push('format must be "overlap-audit/trajectories"');
  if (o.version !== undefined && o.version !== 1) e.push('only version 1 is supported');
  if (o.heading !== undefined && o.heading !== 'atan2' && o.heading !== 'yaw') e.push('heading must be "atan2" or "yaw"');
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  (o.vehicles ?? []).forEach((v, i) => {
    if (typeof v?.id !== 'string' || typeof v?.type !== 'string') e.push(`vehicles[${i}]: id and type are required strings`);
    if (!num(v?.length) || !num(v?.width) || v.length <= 0 || v.width <= 0) e.push(`vehicles[${i}]: length and width must be positive numbers`);
    if (!Array.isArray(v?.frames) || !v.frames.length) e.push(`vehicles[${i}]: frames must be a non-empty array`);
    else if (!v.frames.every((fr) => num(fr?.t) && num(fr?.x) && num(fr?.z) && num(fr?.heading))) e.push(`vehicles[${i}]: every frame needs numeric t, x, z, heading`);
  });
  (o.snapshots ?? []).forEach((s, i) => {
    if (!num(s?.t) || !Array.isArray(s?.bodies)) e.push(`snapshots[${i}]: t and bodies are required`);
    else
      s.bodies.forEach((b, j) => {
        const quad = Array.isArray(b?.quad) && b.quad.length === 8 && b.quad.every(num);
        const box = num(b?.x) && num(b?.z) && num(b?.heading) && num(b?.length) && num(b?.width);
        if (typeof b?.id !== 'string' || typeof b?.type !== 'string' || !(quad || box)) e.push(`snapshots[${i}].bodies[${j}]: needs id, type and either quad[8] or x, z, heading, length, width`);
      });
  });
  (o.areas ?? []).forEach((a, i) => {
    if (typeof a?.name !== 'string' || !Array.isArray(a?.polygon) || a.polygon.length < 3) e.push(`areas[${i}]: name and a polygon of at least 3 points are required`);
  });
  if (!(o.vehicles?.length || o.snapshots?.length)) e.push('nothing to audit: give vehicles and/or snapshots');
  return e;
}

const lerpAngle = (a: number, b: number, u: number) => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
};

/** Time span covered by the file. 文件覆盖的时间范围。 */
export function trajectorySpan(f: TrajectoryFile): { t0: number; t1: number } {
  const ts = [...(f.vehicles ?? []).flatMap((v) => v.frames.map((x) => x.t)), ...(f.snapshots ?? []).map((s) => s.t)];
  return { t0: Math.min(...ts), t1: Math.max(...ts) };
}

/** Bodies present at time t. t 时刻在场的车身。 */
export function bodiesAt(f: TrajectoryFile, t: number): Body<TrajData>[] {
  const yaw = f.heading === 'yaw';
  const out: Body<TrajData>[] = [];
  for (const v of f.vehicles ?? []) {
    const fr = v.frames;
    if (t < (fr[0] as Frame).t || t > (fr[fr.length - 1] as Frame).t) continue;
    let k = 0;
    while (k < fr.length - 2 && (fr[k + 1] as Frame).t < t) k++;
    const a = fr[k] as Frame;
    const b = (fr[k + 1] ?? a) as Frame;
    const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const h = lerpAngle(a.heading, b.heading, u);
    const box = obbFromHeading(x, z, h, v.length / 2, v.width / 2, { yaw });
    if (v.anchor === 'rear') {
      box.cx += box.ux * box.hl;
      box.cz += box.uz * box.hl;
    }
    out.push({ type: v.type, shape: box, data: { id: v.id, ...(v.group ? { group: v.group } : {}), x: box.cx, z: box.cz } });
  }
  const snaps = (f.snapshots ?? []).filter((s) => s.t <= t);
  const snap = snaps.length ? snaps.reduce((p, s) => (s.t >= p.t ? s : p)) : undefined;
  for (const b of snap?.bodies ?? []) {
    if (b.quad) {
      const q = b.quad as Quad;
      const cx = ((q[0] as number) + (q[2] as number) + (q[4] as number) + (q[6] as number)) / 4;
      const cz = ((q[1] as number) + (q[3] as number) + (q[5] as number) + (q[7] as number)) / 4;
      out.push({ type: b.type, shape: [...b.quad], data: { id: b.id, ...(b.group ? { group: b.group } : {}), x: cx, z: cz } });
    } else {
      const box = obbFromHeading(b.x as number, b.z as number, b.heading as number, (b.length as number) / 2, (b.width as number) / 2, { yaw });
      out.push({ type: b.type, shape: box, data: { id: b.id, ...(b.group ? { group: b.group } : {}), x: box.cx, z: box.cz } });
    }
  }
  return out;
}

/** Point in polygon (even-odd rule). 点在多边形里（奇偶规则）。 */
export function inPolygon(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as [number, number];
    const [xj, zj] = poly[j] as [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
