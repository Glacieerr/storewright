import * as THREE from 'three';
import { box, cyl, merge, type Part } from '../../../../StoreX/web/src/three/models';
import { currentRegion } from '../../../src/region/network';
import { footprintKm } from '../../../src/region/frames';
import { LOCAL } from '../../../src/region/regionGen';
import { L, LAND, landAt, planLandUse, seaTester, type LandUsePlan } from '../../../src/region/landuse';
import { GeoBuilder, pointInPoly, rand, SegGrid, type V3 } from './geo';
import { chunkInstances } from './lod';
import type { RoadNet } from './roadnet';

/**
 * 按用地规划摆出来的城区和设施周边（三维）：居住区是一个个小区（朝南的板楼、点式高层，围墙里有绿地），
 * 滨水滨河是低层住宅；市中心是高层写字楼（裙楼加塔楼）和商业，副中心有购物中心；
 * 每个生活圈有一所中学（教学楼、跑道和球场），市中心、副中心旁边有医院，还有市民中心、文化中心、大学；
 * 港口背后、物流园和机场陆侧是物流仓库（一排月台门、门前的停车坪）和厂房（重工业有烟囱、储罐）；
 * 公园里有树、草坪、步道和水面，防护绿地是成排的树；自来水厂、污水处理厂、变电站、公交场站和货运场站按规划的位置；
 * 城外靠近城区的地方是农田。地标（电视塔、体育中心、摩天轮、会展中心、灯塔）按规划摆。
 *
 * 建筑都按真实大小画（沙盘只压缩距离），所以一块用地里只摆几栋有代表性的楼；摆不下的设施找附近的空地。
 * 每种楼一个实例化网格（按 700 米的块分开，看不到的块不画），夜里窗户亮灯。
 */
export interface Cityscape {
  group: THREE.Group;
  setNight: (night: number, hour?: number) => void;
  buildings: number;
  landuse: LandUsePlan;
}

type Pt = { x: number; z: number };
export interface CityEnv {
  /** 城区里能不能盖（区域生成器的城区边界以内、离开绕城快速路、高架、铁路、河） */
  inside: (x: number, z: number) => boolean;
  /** 不能盖的地方：路口、立交、门店站点、停车场、本地路 */
  exclude: (x: number, z: number, pad: number) => boolean;
  /** 城市中心和副中心（沙盘米） */
  centers: Pt[];
}

const km = (x: number, z: number) => ({ x: x / 100, y: -z / 100 });
const sb = (k: { x: number; y: number }): Pt => ({ x: k.x * 100, z: -k.y * 100 });

/** 窗户：墙面按层高 3.3 米、开间 3 米划出窗格，夜里每栋楼、每扇窗亮不亮不一样（深夜亮的少） */
function windowify(mat: THREE.MeshStandardMaterial, lit: { value: number }, share: { value: number }): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLit = lit;
    sh.uniforms.uShare = share;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWin;\nvarying float vSeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  #ifdef USE_INSTANCING
  vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  #else
  vec3 sc = vec3(1.0);
  vSeed = 0.5;
  #endif
  vWin = vec3(abs(normal.x) > 0.5 ? position.z * sc.z : position.x * sc.x, position.y * sc.y, abs(normal.y) > 0.5 ? 1.0 : 0.0);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLit;\nuniform float uShare;\nvarying vec3 vWin;\nvarying float vSeed;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  {
    vec2 cell = floor(vec2(vWin.x / 3.0, vWin.y / 3.3));
    vec2 f = fract(vec2(vWin.x / 3.0, vWin.y / 3.3));
    float pane = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.78) * step(2.2, vWin.y) * (1.0 - vWin.z);
    float h = fract(sin(dot(cell + vSeed * 17.0, vec2(127.1, 311.7))) * 43758.5453);
    float on = step(h, uShare * (0.55 + 0.9 * vSeed));
    float m = pane * on;
    totalEmissiveRadiance = totalEmissiveRadiance * (1.0 - 0.75 * m) + vec3(1.0, 0.82, 0.55) * (0.75 + 0.5 * h) * m * uLit;
  }`,
      );
  };
}

/** 把一个零件绕点 (cx, cz) 转 ang（three.js 的 rotation.y） */
function turn(p: Part, cx: number, cz: number, ang: number): Part {
  p.translate(-cx, 0, -cz);
  p.rotateY(ang);
  p.translate(cx, 0, cz);
  return p;
}
/** 带顶点色的几何体（自己造的环、半圆筒用） */
function paintGeo(g: THREE.BufferGeometry, color: string): Part {
  const n = (g.index ? g.toNonIndexed() : g) as THREE.BufferGeometry;
  const c = new THREE.Color(color);
  const cnt = (n.getAttribute('position') as THREE.BufferAttribute).count;
  const arr = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) arr.set([c.r, c.g, c.b], i * 3);
  n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cnt * 2), 2));
  return n;
}

const FACADE_R = ['#e7e1d4', '#ddd6c6', '#efe9dc', '#d9d2c4', '#e4dccb', '#d6cfc0', '#ece4d2', '#cfd4d6'];
const FACADE_B = ['#c9ced3', '#d4d7d9', '#bfc6cc', '#dad6cf'];
const GLASS = ['#a9c1d3', '#9bb4c8', '#b3c7d4', '#a2b6c0', '#b8c6cf'];
const SHED = ['#c8ccd0', '#bfc5ca', '#d2d3cf', '#b9c2c9'];
const WARE = ['#e3e5e6', '#d9dde0', '#e8e6df'];
const CROPS = ['#b9cf7a', '#a8c26a', '#cfd68a', '#c2b26e', '#9fbe6b', '#d8cf8e'];

export function buildCityscape(env: CityEnv, net: RoadNet, corridors: { pts: V3[]; hw: number }[]): Cityscape {
  const group = new THREE.Group();
  group.name = 'city';
  const region = currentRegion();
  const lu = planLandUse(region);
  const r = rand(4242 + region.spec.seed * 31 + region.spec.mode.length * 7);
  const isSea = seaTester(region);
  const code = (x: number, z: number) => landAt(lu, km(x, z));
  const roads = new SegGrid(40, 12);
  for (const c of corridors) roads.add(c.pts, c.hw);
  // 铁路、河、海边：城外的仓库、厂房也要让开
  const wide = new SegGrid(60, 16);
  wide.add(region.rail.map((k) => ({ x: k.x * 100, y: 0, z: -k.y * 100 }) as V3), 0);
  const rivers = region.river ? [region.river.pts, ...(region.river.branches ?? [])] : [];
  for (const l of rivers) wide.add(l.map((k) => ({ x: k.x * 100, y: 0, z: -k.y * 100 }) as V3), 0);
  const riverHalf = region.river ? (region.river.width * 100) / 2 : 0;
  const facility = (
    [
      [region.frames.port, LOCAL.port.rect],
      [region.frames.airport, { ...LOCAL.airport.rect, x0: LOCAL.airport.rect.x0 - 120, x1: LOCAL.airport.rect.x1 + 220, z1: LOCAL.airport.rect.z1 + 120 }],
      [region.frames.park, LOCAL.park.rect],
    ] as const
  ).map(([f, rc]) => {
    const poly = footprintKm(f, rc).map(sb);
    const c = { x: poly.reduce((a, p) => a + p.x, 0) / 4, z: poly.reduce((a, p) => a + p.z, 0) / 4 };
    // 外扩 30 米
    return poly.map((p) => {
      const d = Math.hypot(p.x - c.x, p.z - c.z) || 1;
      return { x: p.x + ((p.x - c.x) / d) * 30, z: p.z + ((p.z - c.z) / d) * 30 };
    });
  });
  const cityPoly = region.city.boundary.map(sb);
  const inCity = (x: number, z: number) => pointInPoly(x, z, cityPoly);
  /** 这一点能不能盖：城区里按城区的规则，城外（设施周边的片区）离开海、河、铁路、设施和路 */
  const okAt0 = (x: number, z: number) => {
    if (env.exclude(x, z, 0) || roads.near(x, z, 4)) return false;
    if (inCity(x, z)) return env.inside(x, z);
    if (isSea(km(x, z)) || wide.near(x, z, Math.max(40, riverHalf + 30))) return false;
    return !facility.some((f) => pointInPoly(x, z, f));
  };
  // 10 米一格：能不能盖（用到才算，算过记下来）、已经摆了东西没有
  const OX = -6000;
  const OZ = -6000;
  const OC = 10;
  const OW = 1200;
  const okGrid = new Int8Array(OW * OW).fill(-1);
  const occ = new Uint8Array(OW * OW);
  const okCell = (i: number): boolean => {
    let v = okGrid[i] as number;
    if (v < 0) {
      v = okAt0(OX + ((i % OW) + 0.5) * OC, OZ + (Math.floor(i / OW) + 0.5) * OC) ? 1 : 0;
      okGrid[i] = v;
    }
    return v === 1;
  };
  /** 一点能不能盖（按 10 米一格） */
  const okAt = (x: number, z: number) => {
    const i = Math.floor((x - OX) / OC);
    const k = Math.floor((z - OZ) / OC);
    return i >= 0 && k >= 0 && i < OW && k < OW && okCell(k * OW + i);
  };
  /** 一块（中心 x、z，w × d，转 ang）上的每一格：f 返回 false 就停下、整个返回 false */
  const cells = (x: number, z: number, w: number, d: number, ang: number, f: (i: number) => boolean | void): boolean => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let u = -w / 2; u <= w / 2 + 1e-6; u += OC * 0.8)
      for (let v = -d / 2; v <= d / 2 + 1e-6; v += OC * 0.8) {
        const px = x + u * c + v * s;
        const pz = z - u * s + v * c;
        const i = Math.floor((px - OX) / OC);
        const k = Math.floor((pz - OZ) / OC);
        if (i < 0 || k < 0 || i >= OW || k >= OW) return false;
        if (f(k * OW + i) === false) return false;
      }
    return true;
  };
  /** 放不放得下：整块（四周再留 pad 米）都能盖、都还空着 */
  const fits = (x: number, z: number, w: number, d: number, ang: number, pad = 6): boolean => cells(x, z, w + 2 * pad, d + 2 * pad, ang, (i) => occ[i] === 0 && okCell(i));
  const take = (x: number, z: number, w: number, d: number, ang: number) => cells(x, z, w, d, ang, (i) => void (occ[i] = 1));
  /** 在 (x, z) 附近找一块放得下 w × d 的空地（螺旋往外找，最远 maxR 米） */
  const near = (x: number, z: number, w: number, d: number, ang: number, maxR = 140, pad = 6): Pt | undefined => {
    for (let rr = 0; rr <= maxR; rr += 10) {
      const n = Math.max(1, Math.round((rr * 2 * Math.PI) / 14));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * rr;
        const pz = z + Math.sin(a) * rr;
        if (fits(px, pz, w, d, ang, pad)) return { x: px, z: pz };
      }
    }
    return undefined;
  };

  // 干道的方向：楼（除了朝南的住宅）跟最近的干道走
  const B = 120;
  const buckets = new Map<string, { x: number; z: number; ang: number }[]>();
  for (const l of net.lines) {
    if (l.cls !== 'arterial' && l.cls !== 'street' && l.cls !== 'highway' && l.cls !== 'service') continue;
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1] as V3;
      const b = l.pts[i] as V3;
      const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, ang: Math.atan2(b.z - a.z, b.x - a.x) };
      const k = `${Math.floor(m.x / B)},${Math.floor(m.z / B)}`;
      const list = buckets.get(k) ?? [];
      list.push(m);
      buckets.set(k, list);
    }
  }
  const nearestRoad = (x: number, z: number): { ang: number; d: number; x: number; z: number } => {
    let best = { ang: 0, d: Infinity, x, z };
    const cx = Math.floor(x / B);
    const cz = Math.floor(z / B);
    for (let ring = 0; ring <= 6 && best.d === Infinity; ring++)
      for (let i = cx - ring; i <= cx + ring; i++)
        for (let k = cz - ring; k <= cz + ring; k++) {
          if (Math.max(Math.abs(i - cx), Math.abs(k - cz)) !== ring) continue;
          for (const m of buckets.get(`${i},${k}`) ?? []) {
            const d = Math.hypot(m.x - x, m.z - z);
            if (d < best.d) best = { ang: m.ang, d, x: m.x, z: m.z };
          }
        }
    return best;
  };
  const centers = [...lu.centers.map((c) => sb(c.at)), ...env.centers];
  const main = sb((lu.centers[0] as { at: { x: number; y: number } }).at);
  const subs = lu.centers.filter((c) => !c.main).map((c) => sb(c.at));
  /** 离中心多远（副中心按 1.6 倍算：副中心的楼比市中心矮一档） */
  const centerD = (x: number, z: number) => Math.min(Math.hypot(main.x - x, main.z - z), ...subs.map((c) => Math.hypot(c.x - x, c.z - z) * 1.6));
  void centers;

  // —— 实例：楼（有窗、玻璃、没窗）、坡屋顶、树 ——
  type Item = { m: THREE.Matrix4; c: THREE.Color };
  const lit = { value: 0 };
  const share = { value: 0.6 };
  const matWin = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0 });
  windowify(matWin, lit, share);
  const matGlass = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.18, emissive: new THREE.Color('#ffe2b0'), emissiveIntensity: 0 });
  windowify(matGlass, lit, share);
  const matPlain = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const win: Item[] = [];
  const glass: Item[] = [];
  const plain: Item[] = [];
  const roofs: Item[] = [];
  const trees: THREE.Vector3[] = [];
  const tallTrees: THREE.Vector3[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const put = (list: Item[], x: number, z: number, w: number, h: number, d: number, ang: number, color: string, y = 0) => {
    list.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.clone().setFromAxisAngle(up, ang), new THREE.Vector3(w, h, d)), c: new THREE.Color(color) });
  };
  // 不实例化的部分：地标、设施、跑道、水面、步道、停车坪、月台门、农田
  const parts: Part[] = [];
  const flat = new GeoBuilder();
  const water = new GeoBuilder();
  let buildings = 0;
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T;
  const off = (x: number, z: number, u: number, v: number, ang: number): Pt => ({ x: x + u * Math.cos(ang) + v * Math.sin(ang), z: z - u * Math.sin(ang) + v * Math.cos(ang) });

  // —— 1）规划里的设施和地标先摆（摆不下就在附近找空地） ——
  const school = (x: number, z: number, ang: number) => {
    // 中学：凹字形的教学楼、一圈 200 米跑道（中间足球场）、两块篮球场
    const a = off(x, z, -18, -14, ang);
    put(win, a.x, a.z, 52, 16, 12, ang, '#e8c9a8');
    const w1 = off(x, z, -38, 2, ang);
    put(win, w1.x, w1.z, 12, 16, 26, ang, '#e8c9a8');
    const w2 = off(x, z, 2, 2, ang);
    put(win, w2.x, w2.z, 12, 12, 26, ang, '#efd5b8');
    const tc = off(x, z, 22, 6, ang);
    flat.color('#b5523f');
    ellipse(flat, tc.x, tc.z, 34, 18, ang, 0.12);
    flat.color('#6aa84f');
    ellipse(flat, tc.x, tc.z, 27, 11.5, ang, 0.14);
    flat.color('#4f7fa8');
    for (const k of [0, 1]) {
      const c = off(x, z, -26 + k * 17, 22, ang);
      flat.box(c.x, 0.1, c.z, 15, 0.06, 13, ang);
    }
    buildings += 3;
  };
  const hospital = (x: number, z: number, ang: number) => {
    for (const s of [-1, 1]) {
      const p = off(x, z, s * 24, 0, ang);
      put(win, p.x, p.z, 14, 30, 56, ang, '#f2f2ee');
    }
    put(win, x, z, 34, 22, 16, ang, '#e9ecef');
    const t = off(x, z, 0, -40, ang);
    put(win, t.x, t.z, 26, 46, 20, ang, '#f4f4f0');
    buildings += 4;
  };
  const civic = (x: number, z: number, ang: number) => {
    put(win, x, z, 120, 24, 36, ang, '#e6e0d2');
    put(win, x, z, 28, 46, 28, ang, '#ece6d8');
    const p = off(x, z, 0, 58, ang);
    flat.color('#d9d2c2');
    flat.box(p.x, 0.1, p.z, 110, 0.06, 56, ang);
    parts.push(cyl(9, 9, 0.8, '#b8c8d4', p.x, 0.1, p.z, 20));
    buildings += 2;
  };
  const museum = (x: number, z: number, ang: number) => {
    parts.push(cyl(30, 34, 20, '#d8d0c0', x, 0, z, 28), cyl(22, 30, 6, '#c9c0ae', x, 20, z, 28));
    const p = off(x, z, 52, 0, ang);
    put(win, p.x, p.z, 60, 16, 40, ang, '#dcd3c3');
    buildings += 2;
  };
  const campus = (x: number, z: number, ang: number) => {
    for (const [u, v, w, d, h] of [
      [-70, -50, 60, 18, 22],
      [-70, -10, 60, 18, 18],
      [10, -55, 50, 20, 26],
      [70, -40, 40, 40, 18],
      [-10, 20, 30, 30, 14],
    ] as const) {
      const p = off(x, z, u, v, ang);
      put(win, p.x, p.z, w, h, d, ang, pick(['#d9b48f', '#e3c4a2', '#cfa77f']));
    }
    const ct = off(x, z, 20, -10, ang);
    parts.push(turn(box(8, 42, 8, '#c99d72', ct.x, 0, ct.z), ct.x, ct.z, ang), turn(box(9, 4, 9, '#7d5b44', ct.x, 42, ct.z), ct.x, ct.z, ang));
    const tc = off(x, z, 50, 40, ang);
    flat.color('#b5523f');
    ellipse(flat, tc.x, tc.z, 46, 26, ang, 0.12);
    flat.color('#6aa84f');
    ellipse(flat, tc.x, tc.z, 38, 18, ang, 0.14);
    buildings += 6;
  };
  const tower = (x: number, z: number) => {
    parts.push(cyl(3.2, 6, 150, '#d9dcdf', x, 0, z, 16), cyl(15, 13, 12, '#9fb0bf', x, 150, z, 20), cyl(11, 15, 6, '#e7e9eb', x, 162, z, 20), cyl(3, 3.2, 30, '#d9dcdf', x, 168, z, 12), cyl(0.8, 1.2, 46, '#c04b3e', x, 198, z, 8));
    buildings++;
  };
  const stadium = (x: number, z: number, ang: number) => {
    const n = 28;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * 92 * Math.cos(ang) + Math.sin(a) * 70 * Math.sin(ang);
      const pz = z - Math.cos(a) * 92 * Math.sin(ang) + Math.sin(a) * 70 * Math.cos(ang);
      const ta = Math.atan2(Math.sin(a) * 70, Math.cos(a) * 92) + ang;
      parts.push(turn(box(22, 26, 18, k % 2 ? '#e4e6e8' : '#d6dade', px, 0, pz), px, pz, -ta + Math.PI / 2));
    }
    flat.color('#5fa548');
    ellipse(flat, x, z, 62, 42, ang, 0.14);
    buildings++;
  };
  const wheel = (x: number, z: number, ang: number) => {
    const ring = new THREE.TorusGeometry(32, 0.9, 6, 48);
    ring.translate(0, 38, 0);
    ring.rotateY(ang);
    ring.translate(x, 0, z);
    parts.push(paintGeo(ring, '#e9edf0'));
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const sp = new THREE.CylinderGeometry(0.25, 0.25, 32, 4);
      sp.translate(0, 16, 0);
      sp.rotateZ(a);
      sp.translate(0, 38, 0);
      sp.rotateY(ang);
      sp.translate(x, 0, z);
      parts.push(paintGeo(sp, '#cfd6db'));
      const cab = new THREE.BoxGeometry(2.6, 2.6, 2.6);
      cab.translate(Math.cos(a) * 32, 38 + Math.sin(a) * 32 - 1.6, 0);
      cab.rotateY(ang);
      cab.translate(x, 0, z);
      parts.push(paintGeo(cab, ['#d9534f', '#f0ad4e', '#5bc0de', '#5cb85c'][k % 4] as string));
    }
    for (const s of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.8, 1.2, 42, 6);
      leg.translate(0, 19, 0);
      leg.rotateZ(s * 0.32);
      leg.translate(0, 0, 3);
      leg.rotateY(ang);
      leg.translate(x, 0, z);
      parts.push(paintGeo(leg, '#bfc7cd'));
    }
    buildings++;
  };
  const expo = (x: number, z: number, ang: number) => {
    put(win, x, z, 220, 14, 100, ang, '#e4e7ea');
    const roof = new THREE.CylinderGeometry(50, 50, 224, 24, 1, false, 0, Math.PI);
    roof.rotateZ(Math.PI / 2);
    roof.scale(1, 0.32, 1);
    roof.translate(0, 14, 0);
    roof.rotateY(ang);
    roof.translate(x, 0, z);
    parts.push(paintGeo(roof, '#b9c9d6'));
    buildings++;
  };
  const lighthouse = (x: number, z: number) => {
    parts.push(cyl(3.2, 4.4, 10, '#f4f4f0', x, 0, z), cyl(2.9, 3.2, 6, '#c8443a', x, 10, z), cyl(2.6, 2.9, 10, '#f4f4f0', x, 16, z), cyl(2.4, 2.6, 4, '#2d3e4e', x, 26, z), cyl(2.9, 2.9, 1.2, '#c8443a', x, 30, z));
    buildings++;
  };
  const util = (kind: string, x: number, z: number, ang: number) => {
    if (kind === 'waterworks') {
      for (const k of [0, 1]) {
        const p = off(x, z, -40 + k * 40, -30, ang);
        parts.push(cyl(16, 16, 6, '#c9ced2', p.x, 0, p.z, 24));
        water.color('#6c9fc4');
        disc(water, p.x, p.z, 14.5, 6.1);
      }
      water.color('#5e93bd');
      for (let k = 0; k < 4; k++) {
        const p = off(x, z, -54 + k * 22, 18, ang);
        water.box(p.x, 0.1, p.z, 18, 0.9, 30, ang);
      }
      const b = off(x, z, 60, 10, ang);
      put(win, b.x, b.z, 30, 10, 20, ang, '#e0e3e5');
    } else if (kind === 'wastewater') {
      for (let k = 0; k < 4; k++) {
        const p = off(x, z, -60 + (k % 2) * 40, -26 + Math.floor(k / 2) * 40, ang);
        parts.push(cyl(16, 16, 3.5, '#b8bec3', p.x, 0, p.z, 24));
        water.color('#7d9a8f');
        disc(water, p.x, p.z, 14.5, 3.6);
      }
      water.color('#6f8f86');
      for (let k = 0; k < 3; k++) {
        const p = off(x, z, 30 + k * 18, 0, ang);
        water.box(p.x, 0.1, p.z, 14, 0.8, 64, ang);
      }
    } else if (kind === 'substation') {
      flat.color('#a9a9a2');
      flat.box(x, 0.1, z, 56, 0.06, 42, ang);
      for (let k = 0; k < 6; k++) {
        const p = off(x, z, -20 + (k % 3) * 20, -9 + Math.floor(k / 3) * 18, ang);
        parts.push(turn(box(6, 5, 4, '#8f9ba3', p.x, 0, p.z), p.x, p.z, ang));
      }
      for (const s of [-1, 1]) {
        const p = off(x, z, s * 34, 0, ang);
        parts.push(cyl(0.6, 1.4, 34, '#9aa3ab', p.x, 0, p.z, 4), turn(box(14, 0.6, 0.6, '#9aa3ab', p.x, 30, p.z), p.x, p.z, ang));
      }
    } else if (kind === 'waste') {
      put(plain, x, z, 44, 13, 30, ang, '#c7cfc4');
      flat.color('#8d9095');
      const p = off(x, z, 0, 30, ang);
      flat.box(p.x, 0.1, p.z, 60, 0.06, 26, ang);
    } else if (kind === 'busdepot' || kind === 'truckhub') {
      const truck = kind === 'truckhub';
      flat.color('#77797d');
      flat.box(x, 0.1, z, truck ? 130 : 90, 0.06, truck ? 76 : 56, ang);
      const b = off(x, z, truck ? -52 : -34, truck ? -28 : -20, ang);
      put(win, b.x, b.z, 22, 9, 14, ang, '#e6e8ea');
      for (let k = 0; k < (truck ? 12 : 9); k++) {
        const p = off(x, z, (truck ? -36 : -16) + (k % (truck ? 6 : 9)) * (truck ? 14 : 8), truck ? (k < 6 ? 6 : 26) : 8, ang);
        parts.push(turn(box(truck ? 2.6 : 2.55, truck ? 4 : 3.2, truck ? 16 : 12, truck ? pick(['#f2f2ef', '#d6e4ef', '#e6e6e6']) : pick(['#3f8f5f', '#3f74a8', '#d9a33f']), p.x, 0, p.z), p.x, p.z, ang));
      }
    }
    buildings++;
  };
  const anchor = (w: number, d: number, k: { x: number; y: number }, fn: (x: number, z: number, ang: number) => void, maxR = 140, south = false) => {
    const p = sb(k);
    const ang = south ? (r() - 0.5) * 0.12 : -nearestRoad(p.x, p.z).ang;
    const at = near(p.x, p.z, w, d, ang, maxR);
    if (!at) return false;
    take(at.x, at.z, w, d, ang);
    fn(at.x, at.z, ang);
    return true;
  };
  for (const lm of lu.landmarks) {
    if (lm.kind === 'tower') anchor(36, 36, lm.at, (x, z) => tower(x, z), 160);
    else if (lm.kind === 'stadium') anchor(220, 180, lm.at, stadium, 220);
    else if (lm.kind === 'wheel') anchor(80, 50, lm.at, wheel, 160);
    else if (lm.kind === 'expo') anchor(240, 120, lm.at, expo, 260);
    else if (lm.kind === 'campus') anchor(220, 170, lm.at, campus, 220);
    else if (lm.kind === 'museum') anchor(140, 90, lm.at, museum, 160);
    else if (lm.kind === 'civic') anchor(130, 120, lm.at, civic, 160);
    else if (lm.kind === 'hospital') anchor(70, 110, lm.at, hospital, 160);
    else if (lm.kind === 'lighthouse') {
      const p = sb(lm.at);
      if (!isSea(km(p.x, p.z)) && !roads.near(p.x, p.z, 8)) lighthouse(p.x, p.z);
    }
  }
  for (const u of lu.utilities) anchor(u.kind === 'substation' ? 72 : u.kind === 'truckhub' ? 140 : u.kind === 'busdepot' ? 100 : 160, u.kind === 'substation' ? 50 : u.kind === 'truckhub' ? 86 : u.kind === 'busdepot' ? 64 : 100, u.at, (x, z, a) => util(u.kind, x, z, a), 200);
  // 地方小的生活圈：小一号的学校（L 形教学楼和两块球场，没有跑道）
  const compact = (x: number, z: number, ang: number) => {
    const a = off(x, z, -6, -10, ang);
    put(win, a.x, a.z, 44, 15, 12, ang, '#e8c9a8');
    const w = off(x, z, -22, 6, ang);
    put(win, w.x, w.z, 12, 15, 22, ang, '#efd5b8');
    flat.color('#4f7fa8');
    for (const k of [0, 1]) {
      const c = off(x, z, 4 + k * 15, 12, ang);
      flat.box(c.x, 0.1, c.z, 13, 0.06, 12, ang);
    }
    buildings += 2;
  };
  let schools = 0;
  for (const lc of lu.lifeCircles) if (anchor(96, 70, lc.school, school, 110) || anchor(62, 46, lc.school, compact, 90)) schools++;

  // —— 2）按用地填：居住小区、低层住宅、商务、商业、工业、物流、公园、防护绿地、农田 ——
  const residential = (x: number, z: number, low: boolean) => {
    const ang = (r() - 0.5) * 0.14;
    if (low) {
      // 低层住宅：一片坡屋顶的小楼，中间有树
      const n = 6 + Math.floor(r() * 4);
      let made = 0;
      for (let k = 0; k < n; k++) {
        const u = (k % 3) * 22 - 22 + (r() - 0.5) * 3;
        const v = Math.floor(k / 3) * 21 - 21 + (r() - 0.5) * 3;
        const p = off(x, z, u, v, ang);
        if (!fits(p.x, p.z, 13, 11, ang, 3)) continue;
        take(p.x, p.z, 13, 11, ang);
        const h = 6 + r() * 3.5;
        const col = pick(FACADE_R);
        put(win, p.x, p.z, 13, h, 11, ang, col);
        put(roofs, p.x, p.z, 13.6, 3.2, 11.6, ang, pick(['#9a5b46', '#7d5148', '#5f6b75', '#8a7a6a']), h);
        if (r() < 0.6) trees.push(new THREE.Vector3(p.x + 9, 0, p.z + 7));
        made++;
      }
      buildings += made;
      return made > 0;
    }
    // 小区：朝南的板楼（两三排），或者几栋点式高层；楼间有树；围墙
    const rr = centerD(x, z);
    const tall = rr < 380 ? 45 + r() * 30 : rr < 760 ? 27 + r() * 21 : 15 + r() * 18;
    // 地块放得下多大的小区就摆多大（76、62、50 米见方，附近挪一挪）
    let W = 0;
    let at: Pt | undefined;
    for (const size of [76, 62, 50]) {
      at = fits(x, z, size, size, ang, 4) ? { x, z } : undefined;
      if (at) {
        W = size;
        break;
      }
    }
    if (!at) return false;
    x = at.x;
    z = at.z;
    const D = W;
    const point = r() < 0.32 || W < 60;
    take(x, z, W, D, ang);
    if (point) {
      const q4 = W / 2 - 14;
      for (const [u, v] of [
        [-q4, -q4],
        [q4, -q4],
        [-q4, q4],
        [q4, q4],
      ] as const) {
        const p = off(x, z, u, v, ang);
        put(win, p.x, p.z, W < 60 ? 17 : 20, tall * (0.85 + r() * 0.3), W < 60 ? 17 : 20, ang, pick(FACADE_R));
      }
      buildings += 4;
    } else {
      const depth = 13;
      const gap = Math.max(16, Math.min(28, tall * 0.42));
      const n = Math.max(2, Math.min(3, Math.floor((D - 6) / (depth + gap)) + 1));
      const span = (n - 1) * (depth + gap);
      for (let k = 0; k < n; k++) {
        const v = -span / 2 + k * (depth + gap);
        const len = Math.min(W - 10, 44 + r() * 18);
        const p = off(x, z, (r() - 0.5) * 6, v, ang);
        put(win, p.x, p.z, len, tall * (0.9 + r() * 0.2), depth, ang, pick(FACADE_R));
        // 楼间的绿地种几棵树
        if (k < n - 1)
          for (const u of [-14, 6, 22]) {
            const t = off(x, z, u + (r() - 0.5) * 6, v + (depth + gap) / 2, ang);
            trees.push(new THREE.Vector3(t.x, 0, t.z));
          }
      }
      buildings += n;
    }
    // 围墙（矮的一圈）
    for (const [u, v, w, d] of [
      [0, -D / 2, W, 0.4],
      [0, D / 2, W, 0.4],
      [-W / 2, 0, 0.4, D],
      [W / 2, 0, 0.4, D],
    ] as const) {
      const p = off(x, z, u, v, ang);
      put(plain, p.x, p.z, w, 2, d, ang, '#cfc6b6');
    }
    return true;
  };
  const business = (x: number, z: number, cbd: boolean) => {
    const rd = nearestRoad(x, z);
    const ang = -rd.ang;
    const rr = centerD(x, z);
    if (cbd) {
      // 裙楼加塔楼；地块小的只放塔楼
      const big = fits(x, z, 50, 50, ang, 5);
      if (!big && !fits(x, z, 32, 32, ang, 4)) return false;
      const fw = big ? 50 : 32;
      take(x, z, fw, fw, ang);
      const h = rr < 260 ? 110 + r() * 100 : rr < 520 ? 70 + r() * 60 : 45 + r() * 35;
      if (big) put(glass, x, z, 46, 16 + r() * 6, 46, ang, pick(GLASS));
      const t = off(x, z, big ? (r() - 0.5) * 8 : 0, big ? (r() - 0.5) * 8 : 0, ang);
      put(glass, t.x, t.z, big ? 24 + r() * 8 : 26, h, big ? 24 + r() * 8 : 26, ang, pick(GLASS));
      buildings += big ? 2 : 1;
      return true;
    }
    const w = 40 + r() * 26;
    const d = 26 + r() * 16;
    const at3 = fits(x, z, w, d, ang, 5) ? { x, z } : fits(x, z, w * 0.7, d, ang, 5) ? { x, z } : undefined;
    if (!at3) return false;
    take(at3.x, at3.z, w, d, ang);
    put(win, at3.x, at3.z, w, 14 + r() * (rr < 700 ? 30 : 16), d, ang, pick(FACADE_B));
    buildings++;
    return true;
  };
  const mall = (x: number, z: number) => {
    const ang = -nearestRoad(x, z).ang;
    if (!fits(x, z, 130, 86, ang, 6)) return false;
    take(x, z, 130, 86, ang);
    put(win, x, z, 130, 22, 86, ang, '#e2ddd3');
    const p = off(x, z, 0, 58, ang);
    flat.color('#5f6266');
    flat.box(p.x, 0.1, p.z, 120, 0.06, 28, ang);
    buildings++;
    return true;
  };
  const shed = (x: number, z: number, heavy: boolean, outside: boolean) => {
    const ang = -nearestRoad(x, z).ang;
    const w = heavy ? 100 + r() * 50 : 66 + r() * 40;
    const d = heavy ? 54 + r() * 24 : 40 + r() * 24;
    const at4 = fits(x, z, w, d, ang, outside ? 10 : 6) ? { x, z } : fits(x, z, w * 0.7, d * 0.8, ang, outside ? 10 : 6) ? { x, z } : undefined;
    if (!at4) return false;
    x = at4.x;
    z = at4.z;
    take(x, z, w, d, ang);
    put(plain, x, z, w, heavy ? 14 + r() * 6 : 10 + r() * 4, d, ang, pick(SHED));
    const o = off(x, z, -w / 2 + 11, d / 2 + 7, ang);
    put(win, o.x, o.z, 20, 12, 12, ang, '#e6e8ea');
    if (heavy) {
      const c = off(x, z, w / 2 - 10, -d / 2 + 8, ang);
      parts.push(cyl(1.8, 2.6, 34 + r() * 18, '#b7b2aa', c.x, 0, c.z, 10), cyl(1.9, 1.9, 2, '#c0453a', c.x, 30, c.z, 10));
      for (let k = 0; k < 2; k++) {
        const t = off(x, z, w / 2 + 12, -10 + k * 18, ang);
        if (fits(t.x, t.z, 14, 14, ang, 2)) parts.push(cyl(6.5, 6.5, 10, '#d8dadb', t.x, 0, t.z, 16));
      }
    }
    buildings += 2;
    return true;
  };
  const warehouse = (x: number, z: number, heavy: boolean) => {
    const rd = nearestRoad(x, z);
    const ang = -rd.ang;
    const urban = inCity(x, z);
    let w = urban ? 60 + r() * 34 : 130 + r() * 80;
    const d = urban ? 34 + r() * 14 : 56 + r() * 26;
    let at5 = fits(x, z, w, d + 30, ang, 8) ? { x, z } : undefined;
    if (!at5) {
      w *= 0.65;
      at5 = fits(x, z, w, d + 30, ang, 8) ? { x, z } : undefined;
    }
    if (!at5) return false;
    x = at5.x;
    z = at5.z;
    take(x, z, w, d + 30, ang);
    put(plain, x, z, w, 11 + r() * 3, d, ang, pick(WARE));
    // 月台门朝着最近的路那一侧，门前一块停车坪
    const toward = Math.sign((rd.x - x) * Math.sin(ang) + (rd.z - z) * Math.cos(ang)) || 1;
    const ap = off(x, z, 0, toward * (d / 2 + 14), ang);
    flat.color('#66696d');
    flat.box(ap.x, 0.1, ap.z, w - 4, 0.06, 26, ang);
    for (let u = -w / 2 + 6; u < w / 2 - 5; u += 4.4) {
      const p = off(x, z, u, toward * (d / 2 + 0.15), ang);
      parts.push(turn(box(3, 3.6, 0.3, '#3f454c', p.x, 1.1, p.z), p.x, p.z, ang));
    }
    // 二类（港口物流园）门前堆几列空箱
    if (heavy)
      for (let k = 0; k < 6; k++) {
        const p = off(x, z, -w / 2 + 18 + k * 16, toward * (d / 2 + 24), ang);
        for (let t = 0; t < 1 + Math.floor(r() * 3); t++) parts.push(turn(box(12, 2.6, 2.44, pick(['#b5523f', '#3f74a8', '#5f8f4a', '#d0a23f', '#8a8f96']), p.x, t * 2.6, p.z), p.x, p.z, ang));
      }
    buildings++;
    return true;
  };
  const park = (x: number, z: number, buffer: boolean) => {
    if (!okAt(x, z) || !cells(x, z, 60, 60, 0, (i) => occ[i] === 0)) return;
    if (buffer) {
      for (let k = 0; k < 14; k++) {
        const px = x + (r() - 0.5) * 70;
        const pz = z + (r() - 0.5) * 70;
        if (okAt(px, pz)) tallTrees.push(new THREE.Vector3(px, 0, pz));
      }
      return;
    }
    // 草坪、几棵树；有的地块里有一片水面和环湖的步道
    flat.color('#a6cf86');
    flat.box(x, 0.075, z, 64, 0.02, 64, r() * 0.3);
    if (r() < 0.22 && fits(x, z, 40, 30, 0, 2)) {
      water.color('#6aa5cf');
      ellipse(water, x, z, 18 + r() * 8, 11 + r() * 6, r() * 3, 0.12);
      flat.color('#e2d9c3');
      ellipse(flat, x, z, 26, 18, 0, 0.09);
    } else {
      flat.color('#e2d9c3');
      flat.box(x, 0.09, z, 66, 0.02, 2.4, r() * 3);
    }
    for (let k = 0; k < 9; k++) {
      const px = x + (r() - 0.5) * 64;
      const pz = z + (r() - 0.5) * 64;
      if (okAt(px, pz)) trees.push(new THREE.Vector3(px, 0, pz));
    }
  };
  // 按用地一类类往里填：每类在 step 米的格点上逐个试，放得下就放（先放大的：商务、商业、居住，再放工业、物流，最后是绿地）
  const ext = 5200;
  const scan = (codes: readonly number[], step: number, fn: (x: number, z: number, c: number) => void, phase = 0) => {
    for (let x = -ext + phase; x <= ext; x += step)
      for (let z = -ext + phase; z <= ext; z += step) {
        const c = code(x, z);
        if (!codes.includes(c)) continue;
        const city = inCity(x, z);
        const g = LAND[c]?.group;
        if (!city && g !== 'W' && g !== 'M' && g !== 'B') continue;
        fn(x + (r() - 0.5) * 4, z + (r() - 0.5) * 4, c);
      }
  };
  scan([L.B2], 24, (x, z) => business(x, z, true));
  const malls = new Set<number>();
  scan([L.B1], 30, (x, z) => {
    const k = lu.centers.findIndex((o) => !o.main && Math.hypot(sb(o.at).x - x, sb(o.at).z - z) < 110);
    if (k >= 0 && !malls.has(k) && mall(x, z)) malls.add(k);
  });
  // 市中心附近的商业用地也是写字楼（玻璃塔楼），外面是多层的商业楼
  const cbdR = region.city.radius * 100 * 0.3;
  scan([L.B1], 26, (x, z) => {
    if (Math.hypot(main.x - x, main.z - z) < cbdR) business(x, z, true);
  }, 3);
  scan([L.B1], 22, (x, z) => business(x, z, false), 7);
  scan([L.R2], 20, (x, z) => residential(x, z, false));
  scan([L.R1], 20, (x, z) => residential(x, z, true), 5);
  // 公共服务用地上还空着的地方：一栋公共建筑
  scan([L.A1, L.A2, L.A5, L.A33, L.A31], 30, (x, z) => {
    const ang = -nearestRoad(x, z).ang;
    if (!fits(x, z, 40, 26, ang, 6)) return;
    take(x, z, 40, 26, ang);
    put(win, x, z, 40, 12 + r() * 10, 26, ang, pick(['#e7dccb', '#efe7d8', '#dfd7c9']));
    buildings++;
  });
  scan([L.M2], 40, (x, z) => shed(x, z, true, !inCity(x, z)));
  scan([L.M1], 34, (x, z) => shed(x, z, false, !inCity(x, z)));
  scan([L.W2], 40, (x, z) => warehouse(x, z, true));
  scan([L.W1], 40, (x, z) => warehouse(x, z, false), 11);
  scan([L.B1], 40, (x, z) => {
    // 城外的商业（临空经济区的酒店、写字楼）
    if (inCity(x, z)) return;
    const ang = -nearestRoad(x, z).ang;
    if (!fits(x, z, 50, 18, ang, 8)) return;
    take(x, z, 50, 18, ang);
    put(win, x, z, 50, 30 + r() * 26, 18, ang, pick(FACADE_B));
    buildings++;
  }, 13);
  scan([L.G1], 66, (x, z) => park(x, z, false));
  scan([L.G2], 60, (x, z) => park(x, z, true));
  scan([L.G3], 56, (x, z) => {
    if (fits(x, z, 50, 50, 0, 2)) {
      flat.color('#ddd6c6');
      flat.box(x, 0.09, z, 56, 0.02, 56, 0);
    }
  });

  // —— 3）农田：城外离城区不远、没有路和设施的地方，一块块颜色不同的田 ——
  const fields = new GeoBuilder();
  let nField = 0;
  for (let x = -ext; x <= ext && nField < 2600; x += 60)
    for (let z = -ext; z <= ext && nField < 2600; z += 60) {
      if (code(x, z) !== L.RURAL || inCity(x, z)) continue;
      const d0 = Math.hypot(main.x - x, main.z - z);
      if (d0 > region.city.radius * 100 * 1.6 || r() < 0.3 || isSea(km(x, z)) || !okAt(x, z) || wide.near(x, z, 30)) continue;
      // 林地（世界里的树林）那一带不种田：按同一个噪声函数
      const forest = Math.sin(x / 430 + 1.3) * Math.cos(z / 370 - 0.7) + 0.6 * Math.sin((x + z) / 260 + 2.1) + 0.35 * Math.cos((x - 2 * z) / 190);
      if (forest > 0.6) continue;
      fields.color(pick(CROPS));
      fields.box(x + (r() - 0.5) * 6, 0.02, z + (r() - 0.5) * 6, 52 + r() * 6, 0.04, 26 + r() * 30, Math.floor(r() * 2) * (Math.PI / 2) + (r() - 0.5) * 0.1);
      nField++;
    }

  // —— 网格 ——
  const box1 = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  if (win.length) group.add(chunkInstances(box1, matWin, win, 'city-blocks', { cast: true, receive: true, cell: 700 }));
  if (glass.length) group.add(chunkInstances(box1, matGlass, glass, 'city-towers', { cast: true, receive: true, cell: 700 }));
  if (plain.length) group.add(chunkInstances(box1, matPlain, plain, 'city-sheds', { cast: true, receive: true, cell: 700 }));
  if (roofs.length) {
    const roof = new THREE.BufferGeometry();
    // 坡屋顶：沿 x 的三棱柱（底宽 1、高 1）
    const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, -0.5, 0, 0.5, 0.5, 0, 0.5];
    roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    roof.setIndex([0, 3, 2, 0, 2, 1, 4, 5, 2, 4, 2, 3, 0, 4, 3, 1, 2, 5]);
    roof.computeVertexNormals();
    group.add(chunkInstances(roof, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), roofs, 'city-roofs', { cast: true, cell: 700, far: 2600 }));
  }
  const vc = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  if (parts.length) {
    const m = new THREE.Mesh(merge(parts), vc);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'city-landmarks';
    group.add(m);
  }
  const addFlat = (g: GeoBuilder, name: string, mat: THREE.Material) => {
    if (g.empty) return;
    const m = new THREE.Mesh(g.build(), mat);
    m.receiveShadow = true;
    m.name = name;
    group.add(m);
  };
  addFlat(flat, 'city-ground', vc);
  addFlat(water, 'city-water', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.1 }));
  addFlat(fields, 'farmland', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  const treeGeo = new THREE.ConeGeometry(2.6, 7, 6).translate(0, 6, 0);
  const treeMat = new THREE.MeshStandardMaterial({ color: '#6b9452', roughness: 0.9, flatShading: true });
  if (trees.length) group.add(chunkInstances(treeGeo, treeMat, trees.slice(0, 5000).map((p) => ({ m: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z) })), 'city-trees', { far: 3500, cell: 700 }));
  if (tallTrees.length) group.add(chunkInstances(new THREE.ConeGeometry(2.2, 10, 6).translate(0, 7, 0), new THREE.MeshStandardMaterial({ color: '#4f7f45', roughness: 0.9, flatShading: true }), tallTrees.slice(0, 4000).map((p) => ({ m: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z) })), 'buffer-trees', { far: 3500, cell: 700 }));
  void schools;
  return {
    group,
    landuse: lu,
    buildings,
    setNight: (night, hour = 20) => {
      const n = Math.max(0, Math.min(1, night));
      matWin.emissiveIntensity = 0.16 * n;
      matGlass.emissiveIntensity = 0.12 * n;
      lit.value = Math.max(0, Math.min(1, (n - 0.3) / 0.4)) * 1.3;
      const h = ((hour % 24) + 24) % 24;
      share.value = h >= 17 && h < 23 ? 0.62 : h >= 23 || h < 1 ? 0.4 : h < 5 ? 0.14 : 0.32;
    },
  };
}

/** 水平的椭圆（中心 x、z，半轴 a、b，转 ang），高度 y */
function ellipse(g: GeoBuilder, x: number, z: number, a: number, b: number, ang: number, y: number): void {
  const pts: Pt[] = [];
  for (let k = 0; k < 28; k++) {
    const t = (k / 28) * Math.PI * 2;
    const u = Math.cos(t) * a;
    const v = Math.sin(t) * b;
    pts.push({ x: x + u * Math.cos(ang) + v * Math.sin(ang), z: z - u * Math.sin(ang) + v * Math.cos(ang) });
  }
  g.polygon(pts, y);
}
function disc(g: GeoBuilder, x: number, z: number, r: number, y: number): void {
  ellipse(g, x, z, r, r, 0, y);
}
