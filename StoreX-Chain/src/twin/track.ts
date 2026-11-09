import type { WSeg, WVehicle } from '../sim/trace';

/**
 * 计划轨迹的几何：计划时钟 τ 时刻在哪一段、在折线上的哪个位置。现场和孪生用同一套计算，
 * 孪生把定位点对回计划轨迹（找最近的那一刻）就知道车晚了多少。
 */
const cache = new WeakMap<WSeg, number[]>();

export function segCum(s: WSeg): number[] {
  let c = cache.get(s);
  if (!c) {
    c = [0];
    for (let k = 2; k + 1 < s.pts.length; k += 2) c.push((c[c.length - 1] as number) + Math.hypot((s.pts[k] as number) - (s.pts[k - 2] as number), (s.pts[k + 1] as number) - (s.pts[k - 1] as number)));
    cache.set(s, c);
  }
  return c;
}

export function segAt(v: WVehicle, tau: number): { i: number; s: WSeg } | undefined {
  const segs = v.segs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as WSeg;
    if (tau >= s.t0 && tau < s.t1) return { i, s };
  }
  return undefined;
}

export function posAt(s: WSeg, tau: number): { x: number; z: number } {
  if (s.pts.length < 4) return { x: s.pts[0] as number, z: s.pts[1] as number };
  const c = segCum(s);
  const total = c[c.length - 1] as number;
  const want = total * Math.max(0, Math.min(1, (tau - s.t0) / Math.max(1, s.t1 - s.t0)));
  let k = 1;
  while (k < c.length - 1 && (c[k] as number) < want) k++;
  const a = c[k - 1] as number;
  const b = (c[k] as number) ?? a;
  const f = b > a ? (want - a) / (b - a) : 0;
  const x0 = s.pts[(k - 1) * 2] as number;
  const z0 = s.pts[(k - 1) * 2 + 1] as number;
  const x1 = (s.pts[k * 2] as number) ?? x0;
  const z1 = (s.pts[k * 2 + 1] as number) ?? z0;
  return { x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f };
}

export const isLoad = (s: WSeg): boolean => s.place === 'DC' && /装车/.test(s.act ?? '');
export const isDcUnload = (s: WSeg): boolean => s.place === 'DC' && /卸货|拆箱/.test(s.act ?? '');
export const isStoreUnload = (s: WSeg): boolean => !!s.place && /^S\d\d$/.test(s.place) && /卸货/.test(s.act ?? '');
export const isWait = (s: WSeg): boolean => /等收货/.test(s.act ?? '');
export const isMoving = (s: WSeg): boolean => s.pts.length > 2 || !!s.route || !!s.loop;
