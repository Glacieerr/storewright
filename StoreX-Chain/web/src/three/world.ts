import * as THREE from 'three';
import { box, cyl, merge, type Part } from '../../../../StoreX/web/src/three/models';
import { currentRegion } from '../../../src/region/network';
import { COAST, FRAMES, NODES, RAIL, RAIL_DC_INDEX, type Km } from '../../../src/region/region';
import { footprintKm, toWorld as frameToWorld, type Frame } from '../../../src/region/frames';
import { DIR_LABEL, dirOf, LOCAL } from '../../../src/region/regionGen';
import { cumulative, pointInPoly, polyDist, resample, sampleAt, SegGrid, segIntersect, type V3 } from './geo';
import { buildRoads, type RoadMeshes } from './roadmesh';
import { RoadNet } from './roadnet';
import { layoutCity } from './cityplan';
import type { LightSpot } from './lamps';
import { chunkInstances } from './lod';
import { dcLayout } from './places';
import { buildLots, type LotMeshes } from './parking';
import { buildStores, toWorld, type Site, type StoreMeshes } from './stores';
import { buildZoning, type Zoning } from './zoning';
import { LAND, landAt } from '../../../src/region/landuse';
import { currentFacilities } from '../../../src/facility/state';
import { parkLayout } from '../../../src/hub/park';

/**
 * 区域沙盘：1 公里画成 100 米（地理关系是真的，距离压缩了），建筑、车辆、船、飞机按真实尺寸画。
 * 坐标：x = 公里 × 100（向东），z = −公里 × 100（向南为正），y 向上。全部由代码生成：
 * 海和陆地、河、城区的地面、道路网、铁路（含城市客运站、过河的铁路桥）、树林、门店；
 * 港口、机场、物流园的地面和设施放在各自的坐标系里（frames），整体平移、旋转到区域生成器选的位置。
 */
export const S = 100;
export const P = (k: Km): THREE.Vector3 => new THREE.Vector3(k.x * S, 0, -k.y * S);

export interface World {
  group: THREE.Group;
  labels: { text: string; pos: THREE.Vector3; kind: 'big' | 'zone' | 'store' }[];
  /** 综合店里 StoreX 门店模型放的位置和朝向：布局 (0, 0) 角在 origin，绕 y 轴转 rotation */
  flagship: { origin: THREE.Vector3; rotation: number };
  net: RoadNet;
  roads: RoadMeshes;
  stores: StoreMeshes;
  sites: Map<string, Site>;
  /** 城区的分区规划：街道、地块、建筑、规划图层 */
  zoning: Zoning;
  /** 各区域的停车场（地面、车位线、灯杆、道闸） */
  parking: LotMeshes;
  /** 配送中心每樘月台门上方的状态灯（调度台排的装车、卸货按时刻亮） */
  doorLights: { mesh: THREE.InstancedMesh; index: Map<string, number> };
  /** 港口、机场、物流园的坐标系节点：设施作业（ops）的组加到 inner 里，按局部坐标画 */
  frames: Record<'port' | 'airport' | 'park', { outer: THREE.Group; inner: THREE.Group }>;
  /** 夜里亮的灯（路灯、停车场的灯杆、物流园的高杆灯）：灯头的位置、地上光圈的半径、地面高度 */
  lights: LightSpot[];
}

/** 设施的坐标系节点：外层平移、旋转到区域里，内层减去局部参考点（和 frames.ts 的换算一致） */
export function frameGroup(f: Frame, name: string): { outer: THREE.Group; inner: THREE.Group } {
  const outer = new THREE.Group();
  outer.name = name;
  outer.position.set(f.w.x, 0, f.w.z);
  outer.rotation.y = f.rot;
  const inner = new THREE.Group();
  inner.position.set(-f.o.x, 0, -f.o.z);
  outer.add(inner);
  return { outer, inner };
}
/** 局部坐标（沙盘米）的点换到区域里 */
export const fw = (f: Frame, x: number, y: number, z: number): THREE.Vector3 => {
  const p = frameToWorld(f, { x, z });
  return new THREE.Vector3(p.x, y, p.z);
};

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
const VC = std({ vertexColors: true });

/** 沿折线铺一条带子（道路、铁路的路基）；给几段折线就铺几段，合在一个几何体里 */
function ribbon(pts: readonly THREE.Vector3[] | readonly (readonly THREE.Vector3[])[], width: number, y: number): THREE.BufferGeometry {
  const runs = (pts.length && Array.isArray(pts[0]) ? pts : [pts]) as readonly (readonly THREE.Vector3[])[];
  const pos: number[] = [];
  const idx: number[] = [];
  for (const run of runs) ribbonRun(run, width, y, pos, idx);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function ribbonRun(pts: readonly THREE.Vector3[], width: number, y: number, pos: number[], idx: number[]): void {
  const base = pos.length / 3;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)] as THREE.Vector3;
    const b = pts[Math.min(pts.length - 1, i + 1)] as THREE.Vector3;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const p = pts[i] as THREE.Vector3;
    pos.push(p.x + (nx * width) / 2, y, p.z + (nz * width) / 2, p.x - (nx * width) / 2, y, p.z - (nz * width) / 2);
    if (i > 0) {
      // 绕向固定成朝上（不管折线往哪个方向走，从上面都看得见）
      const k = base + i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
}

/** 把折线加密（转弯处圆一点） */
function densify(pts: readonly THREE.Vector3[], step: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as THREE.Vector3;
    const b = pts[i + 1] as THREE.Vector3;
    const n = Math.max(1, Math.ceil(a.distanceTo(b) / step));
    for (let k = 0; k < n; k++) out.push(a.clone().lerp(b, k / n));
  }
  out.push((pts[pts.length - 1] as THREE.Vector3).clone());
  return out;
}

/** 固定的伪随机数（场景每次都一样） */
function rand(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export function buildWorld(): World {
  const plan = currentRegion();
  const group = new THREE.Group();
  group.name = 'world';
  const labels: World['labels'] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true, name = '', parent: THREE.Group = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.castShadow = shadow;
    m.name = name;
    parent.add(m);
    return m;
  };
  const frames = {
    port: frameGroup(FRAMES.port, 'port-frame'),
    airport: frameGroup(FRAMES.airport, 'airport-frame'),
    park: frameGroup(FRAMES.park, 'park-frame'),
  };
  group.add(frames.port.outer, frames.airport.outer, frames.park.outer);

  // —— 海和陆地：海岸线朝陆地一侧围出陆地 ——
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(26000, 20000).rotateX(-Math.PI / 2), std({ color: '#5f93bf', roughness: 0.35, metalness: 0.15 }));
  sea.position.set(300, -1.2, 400);
  sea.receiveShadow = true;
  sea.name = 'sea';
  group.add(sea);
  const sd = plan.seaDir;
  const first = COAST[0] as Km;
  const last = COAST[COAST.length - 1] as Km;
  const landKm: Km[] = [...COAST, { x: last.x - sd.x * 160, y: last.y - sd.y * 160 }, { x: first.x - sd.x * 160, y: first.y - sd.y * 160 }];
  const shape = new THREE.Shape();
  landKm.forEach((k, i) => (i ? shape.lineTo(k.x * S, k.y * S) : shape.moveTo(k.x * S, k.y * S)));
  const land = new THREE.ShapeGeometry(shape, 8);
  land.rotateX(-Math.PI / 2);
  add(land, std({ color: '#93ad74' }), false, 'land');
  // 海里的岛（河口、海湾）：一圈沙滩，中间是草地和树林
  const islandPolys = (plan.islands ?? []).map((isl) => isl.map((k) => ({ x: k.x * S, z: -k.y * S })));
  for (const [k, isl] of (plan.islands ?? []).entries()) {
    const sh = new THREE.Shape();
    isl.forEach((p, i) => (i ? sh.lineTo(p.x * S, p.y * S) : sh.moveTo(p.x * S, p.y * S)));
    add(new THREE.ShapeGeometry(sh, 4).rotateX(-Math.PI / 2).translate(0, 0.02, 0), std({ color: '#e3d6ad' }), false, `island-beach-${k}`);
    const c = isl.reduce((a, p) => ({ x: a.x + p.x / isl.length, y: a.y + p.y / isl.length }), { x: 0, y: 0 });
    const inner = new THREE.Shape();
    isl.forEach((p, i) => {
      const q = { x: c.x + (p.x - c.x) * 0.82, y: c.y + (p.y - c.y) * 0.82 };
      if (i) inner.lineTo(q.x * S, q.y * S);
      else inner.moveTo(q.x * S, q.y * S);
    });
    add(new THREE.ShapeGeometry(inner, 4).rotateX(-Math.PI / 2).translate(0, 0.05, 0), std({ color: '#8fae6f' }), false, `island-${k}`);
  }
  // 陆地判断（种树、摆背景用）：50 米一格预先算好
  const landPoly = landKm.map((k) => ({ x: k.x * S, z: -k.y * S }));
  const G0 = { x: -4600, z: -4000 };
  const GC = 50;
  const GW = Math.ceil(10000 / GC);
  const GH = Math.ceil(8000 / GC);
  const landGrid = new Uint8Array(GW * GH);
  for (let i = 0; i < GW; i++)
    for (let k = 0; k < GH; k++) {
      const x = G0.x + (i + 0.5) * GC;
      const z = G0.z + (k + 0.5) * GC;
      // 岛只算里面那一圈（沙滩上不种树）
      landGrid[k * GW + i] = pointInPoly(x, z, landPoly) || islandPolys.some((isl) => pointInPoly(x, z, shrink(isl, 0.75))) ? 1 : 0;
    }
  const isLand = (x: number, z: number) => {
    const i = Math.floor((x - G0.x) / GC);
    const k = Math.floor((z - G0.z) / GC);
    return i >= 0 && k >= 0 && i < GW && k < GH && landGrid[k * GW + i] === 1;
  };
  // 海滩：区域里那一段海岸
  // 港口的码头前沿不铺（船靠在码头边，下面是水）：港区占地外扩 220 米以内的一段截掉
  const coastIn = COAST.filter((k) => k.x > -60 && k.x < 70 && k.y > -50 && k.y < 55).map(P);
  const portFoot = footprintKm(FRAMES.port, LOCAL.port.rect).map((k) => ({ x: k.x * S, z: -k.y * S }));
  const pc = { x: portFoot.reduce((a, p) => a + p.x, 0) / portFoot.length, z: portFoot.reduce((a, p) => a + p.z, 0) / portFoot.length };
  const portZone = portFoot.map((p) => {
    const d = Math.hypot(p.x - pc.x, p.z - pc.z) || 1;
    return { x: p.x + ((p.x - pc.x) / d) * 220, z: p.z + ((p.z - pc.z) / d) * 220 };
  });
  const sand: THREE.Vector3[][] = [[]];
  if (coastIn.length > 1)
    for (const p of densify(coastIn, 20)) {
      if (pointInPoly(p.x, p.z, portZone)) {
        if ((sand[sand.length - 1] as THREE.Vector3[]).length) sand.push([]);
      } else (sand[sand.length - 1] as THREE.Vector3[]).push(p);
    }
  const beach = sand.filter((r) => r.length > 1);
  if (beach.length) add(ribbon(beach, 60, 0.05), std({ color: '#e6d9b0' }), false, 'beach');

  // —— 河：水面（两岸一条浅色的岸）——
  let riverD: V3[] = [];
  let riverHalf = 0;
  /** 支流（汇进干流）：铁路过支流也要架桥 */
  const branchD: { pts: V3[]; half: number }[] = [];
  if (plan.river) {
    riverD = resample(plan.river.pts.map(P), 20);
    riverHalf = (plan.river.width * S) / 2;
    // 盖在城区的地面上面（城区地面 0.06 米）
    add(ribbon(riverD, riverHalf * 2 + 12, 0.085), std({ color: '#c9c09d' }), false, 'river-bank');
    add(ribbon(riverD, riverHalf * 2, 0.095), std({ color: '#5a8fbb', roughness: 0.3, metalness: 0.12 }), false, 'river');
    for (const [k, b] of (plan.river.branches ?? []).entries()) {
      const pts = resample(b.map(P), 20);
      const half = ((plan.river.branchWidth ?? plan.river.width) * S) / 2;
      branchD.push({ pts, half });
      add(ribbon(pts, half * 2 + 10, 0.083), std({ color: '#c9c09d' }), false, `river-branch-bank-${k}`);
      add(ribbon(pts, half * 2, 0.093), std({ color: '#5a8fbb', roughness: 0.3, metalness: 0.12 }), false, `river-branch-${k}`);
    }
  }

  // —— 城区的地面：区域生成器给的边界里稍微亮一点的草地 ——
  const cityShape = new THREE.Shape();
  plan.city.boundary.forEach((k, i) => (i ? cityShape.lineTo(k.x * S, k.y * S) : cityShape.moveTo(k.x * S, k.y * S)));
  add(new THREE.ShapeGeometry(cityShape, 4).rotateX(-Math.PI / 2).translate(0, 0.06, 0), std({ color: '#9db57f' }), false, 'city');
  const cityPoly = plan.city.boundary.map((k) => ({ x: k.x * S, z: -k.y * S }));

  const pad = (k: Km, w: number, d: number, color: string, y: number, name: string, parent: THREE.Group) => {
    const p = P(k);
    const g = new THREE.BoxGeometry(w, 0.2, d);
    g.translate(p.x, y, p.z);
    add(g, std({ color }), false, name, parent);
  };
  // —— 港口（坐标系里画）：填海造的港区，从陆地一直填到码头；码头、岸桥、堆场、闸口、靠离泊的船和作业动画在 ops/port.ts ——
  const poly = (pts: Km[], y: number, color: string, name: string) => {
    const sh = new THREE.Shape();
    pts.forEach((k, i) => (i ? sh.lineTo(k.x * S, k.y * S) : sh.moveTo(k.x * S, k.y * S)));
    add(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).translate(0, y, 0), std({ color }), false, name, frames.port.inner);
  };
  // 先用陆地的颜色把港区背后填平（换了海岸线以后不露海），再铺港区的硬化地面
  poly([{ x: -29.5, y: -14.12 }, { x: -14.5, y: -14.12 }, { x: -14.5, y: -8.6 }, { x: -29.5, y: -8.6 }], 0.01, '#93ad74', 'port-fill');
  poly([{ x: -27.4, y: -14.12 }, { x: -16.9, y: -14.12 }, { x: -16.9, y: -11.6 }, { x: -19.6, y: -9.6 }, { x: -27.4, y: -9.6 }], 0.03, '#a9a69c', 'reclaimed');
  pad({ x: -22.0, y: -13.2 }, 860, 230, '#b4b3ad', 0.1, 'port-yard', frames.port.inner);
  labels.push({ text: '集装箱港口', pos: fw(FRAMES.port, (-2560 + -1820) / 2, 70, 1385 - 60), kind: 'big' });

  // —— 机场（坐标系里画）：整个占地铺草地；跑道、滑行道、机坪、货站和地面作业动画在 ops/airport.ts ——
  pad({ x: 21.25, y: -11.15 }, 2350, 430, '#9fb388', 0.08, 'airport-grass', frames.airport.inner);
  labels.push({ text: '机场货运区', pos: fw(FRAMES.airport, 2115, 46, 1020), kind: 'big' });

  // —— 道路网：在仿真的道路图上细化车道、路口、立交和桥；门店站点和进店路 ——
  const net = new RoadNet();
  // 车辆停靠的地点（门店收货口、配送中心月台门和车场、港口、机场、面包房、高速口）：和孪生服务共用；
  // 各区域的停车场、城区的小街和小区停车场：在路口收尾之前摆（进出场的路、小街要算进路口）
  const { sites, lots, zplan } = layoutCity(net);
  const roads = buildRoads(net);
  group.add(roads.group);
  const parking = buildLots(lots);
  group.add(parking.group);
  const zoning = buildZoning(zplan, net, roads.corridors);
  group.add(zoning.group);
  const roadGrid = new SegGrid(50, 40);
  for (const c of roads.corridors) roadGrid.add(c.pts, c.hw);
  const nearRoad = (x: number, z: number, pd: number) => roadGrid.near(x, z, pd);
  const railPts = RAIL.map(P);
  const m = new THREE.Matrix4();

  // —— 铁路桥（过河处：钢梁和桥墩）、城市客运站（站台、雨棚、站房）——
  const railDeco: Part[] = [];
  for (const rv of riverD.length ? [{ pts: riverD, half: riverHalf }, ...branchD] : []) {
    for (let k = 1; k < railPts.length; k++)
      for (let i = 1; i < rv.pts.length; i++) {
        const hit = segIntersect(railPts[k - 1] as V3, railPts[k] as V3, rv.pts[i - 1] as V3, rv.pts[i] as V3);
        if (!hit) continue;
        const a = railPts[k - 1] as V3;
        const b = railPts[k] as V3;
        const c = a.clone().lerp(b, hit.t);
        const ang = Math.atan2(b.x - a.x, b.z - a.z);
        const L = rv.half * 2 + 30;
        const dir = { x: Math.sin(ang), z: Math.cos(ang) };
        const side = { x: dir.z, z: -dir.x };
        // 两根钢梁（沿铁路方向画好再转过去）、河里一排桥墩
        for (const sg of [-1, 1]) railDeco.push(...rotatePart(box(1.2, 3.2, L, '#7d8590', c.x + 3.6 * sg, 0.2, c.z), c, ang));
        for (let s2 = -L / 2 + 6; s2 <= L / 2 - 6; s2 += 16) railDeco.push(...rotatePart(box(8.6, 2.2, 2.2, '#a9a49a', c.x, -1.6, c.z + s2), c, ang));
        void side;
        void dir;
      }
  }
  const pax = plan.railPassenger;
  if (pax) {
    const cum = cumulative(railPts);
    const sm = sampleAt(railPts, cum, pax.s * S);
    const ang = Math.atan2(sm.dx, sm.dz);
    const side = { x: sm.dz, z: -sm.dx };
    // 站房在靠市中心的一侧
    const toC = -(sm.p.x * side.x + sm.p.z * side.z) > 0 ? 1 : -1;
    for (const sg of [-1, 1]) {
      const c = new THREE.Vector3(sm.p.x + side.x * 7.2 * sg, 0, sm.p.z + side.z * 7.2 * sg);
      railDeco.push(...rotatePart(box(5, 1.1, 230, '#d8d3c7', c.x, 0, c.z), c, ang));
      railDeco.push(...rotatePart(box(4.4, 0.35, 150, '#6f7f8f', c.x, 5.4, c.z), c, ang));
      for (let s2 = -66; s2 <= 66; s2 += 22) {
        const q = new THREE.Vector3(c.x + sm.dx * s2, 0, c.z + sm.dz * s2);
        railDeco.push(box(0.35, 5.4, 0.35, '#5b6670', q.x, 0, q.z));
      }
    }
    const hall = new THREE.Vector3(sm.p.x + side.x * 32 * toC, 0, sm.p.z + side.z * 32 * toC);
    railDeco.push(...rotatePart(box(26, 13, 70, '#e3ddd0', hall.x, 0, hall.z), hall, ang), ...rotatePart(box(28, 1.2, 72, '#8a6e5a', hall.x, 13, hall.z), hall, ang));
    labels.push({ text: pax.name, pos: new THREE.Vector3(hall.x, 34, hall.z), kind: 'zone' });
  }
  if (railDeco.length) add(merge(railDeco), VC, true, 'rail-structures');

  // —— 物流园（坐标系里画）：配送中心和冷链中心的库房、月台、库内作业在 ops/dc.ts，铁路货运站的龙门吊在 ops/rail.ts；这里是园区的地面、车场、中央面包房 ——
  // 一排月台门（干货 26 樘、冷链 12 樘），铁路货运站在库房背后；货车从园区路口进来，开过门再倒车靠台
  pad({ x: 13.0, y: 14.5 }, 680, 410, '#b9b7b0', 0.1, 'logistics-park', frames.park.inner);
  const { dc, wallZ, dryDoors, coldDoors } = dcLayout();
  const park: Part[] = [];
  // 月台前的停车坪和车道标线
  park.push(box(470, 0.12, 46, '#55585c', dc.x + 115, 0.12, wallZ + 23));
  for (let i = 0; i < 40; i++) park.push(box(0.15, 0.04, 14, '#e8e8e2', dc.x - 125 + i * 11.5, 0.25, wallZ + 8));
  // 挂车场（待命停车场、甩挂区）和车上的挂车在 ops/parkYard.ts 里按当天的计划画
  // 中央面包房（局部坐标）
  const bk = P(LOCAL.park.bakery);
  park.push(box(70, 10, 45, '#f0dfc0', bk.x, 0, bk.z), cyl(2.5, 2.5, 18, '#8d6e63', bk.x + 20, 10, bk.z - 10));
  // 充电站（全链路的电动卡车）
  for (let i = 0; i < 10; i++) park.push(box(1.2, 2.4, 1, '#1baf7a', dc.x + 180 + i * 8, 0, dc.z + 30));
  // 高杆灯：月台前停车坪的两头、挂车场的两头、面包房前（不挡货车的路；夜里亮，见 lamps.ts）
  const parkMasts: [number, number][] = [
    [dc.x - 128, wallZ + 10],
    [dc.x - 128, wallZ + 40],
    [dc.x + 358, wallZ + 10],
    [dc.x + 358, wallZ + 40],
    [dc.x - 158, dc.z + 56],
    [dc.x - 58, dc.z + 56],
    [bk.x - 45, bk.z + 35],
  ];
  for (const [x, z] of parkMasts) park.push(cyl(0.3, 0.45, 25, '#9aa3ab', x, 0, z), box(3, 0.9, 3, '#f4f1e6', x, 25, z));
  const parkLights = parkMasts.map(([x, z]) => {
    const p = fw(FRAMES.park, x, 24.5, z);
    return { x: p.x, y: p.y, z: p.z, r: 26, g: 0.15 };
  });
  // 挂车场的 5 根高杆灯（待命停车场两根、甩挂区两头、拆箱车场一根；灯杆画在 ops/parkYard.ts，位置按同一份园区布局）
  {
    const PL = parkLayout(currentFacilities().dc.railTracks);
    for (const [x, z] of [
      [PL.hold.x0 + 4, PL.hold.z0 + 6],
      [PL.hold.x0 + 4, PL.hold.z1 - 6],
      [PL.drop.x0 - 4, PL.drop.aisleZ],
      [PL.drop.x1 + 6, PL.drop.aisleZ],
      [PL.tl.x0 - 6, PL.tl.zN - 20],
    ] as [number, number][]) {
      const p = fw(FRAMES.park, x, 21.5, z);
      parkLights.push({ x: p.x, y: p.y, z: p.z, r: 24, g: 0.15 });
    }
  }
  labels.push({ text: '物流园 · 配送中心', pos: fw(FRAMES.park, dc.x + 60, 45, dc.z - 150), kind: 'big' });
  labels.push({ text: '中央面包房', pos: fw(FRAMES.park, bk.x, 22, bk.z), kind: 'zone' });
  const rt = P(RAIL[RAIL_DC_INDEX] as Km);
  labels.push({ text: '物流园铁路货运站', pos: new THREE.Vector3(rt.x, 30, rt.z), kind: 'zone' });
  // 门上方的状态灯：空闲暗灰，装车蓝，卸货橙，冲突红（不受光照，夜里也看得见）
  const doorLights = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.55, 0.3), new THREE.MeshBasicMaterial({ color: '#ffffff' }), dryDoors.length + coldDoors.length);
  const lightIndex = new Map<string, number>();
  [...dryDoors.map((x, i) => [`D${String(i + 1).padStart(2, '0')}`, x] as const), ...coldDoors.map((x, i) => [`C${String(i + 1).padStart(2, '0')}`, x] as const)].forEach(([id, x], i) => {
    m.makeTranslation(x, 6.3, wallZ + 0.5);
    doorLights.setMatrixAt(i, m);
    doorLights.setColorAt(i, new THREE.Color('#3a3d42'));
    lightIndex.set(id, i);
  });
  doorLights.name = 'door-lights';
  frames.park.inner.add(doorLights);
  park.push(box(130, 0.12, 22, '#55585c', dc.x + 97, 0.12, dc.z - 17));
  for (let k = 0; k <= 24; k++) park.push(box(0.12, 0.04, 14, '#e8e8e2', dc.x + 37.5 + k * 5, 0.25, dc.z - 21));
  add(merge(park), VC, true, 'logistics-park', frames.park.inner);

  // —— 城市：街区和建筑由 zoning 模块生成 ——
  const storeSpots = [...sites.values()].map((x) => x.center);
  // 市中心、各组团的副中心（用地规划给的名字）
  for (const c of zoning.landuse.centers) labels.push({ text: c.name, pos: new THREE.Vector3(c.at.x * S, c.main ? 190 : 120, -c.at.y * S), kind: 'zone' });
  // 树：城外成片长（林地、防护林），零星几棵；不种在海里、河里、城区、路上、铁路上、设施和停车场里
  const lotPolys = lots.map((l) => {
    const cx = l.outline.reduce((a, p) => a + p.x, 0) / l.outline.length;
    const cz = l.outline.reduce((a, p) => a + p.z, 0) / l.outline.length;
    return l.outline.map((p) => {
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dx / d) * 14, z: p.z + (dz / d) * 14 };
    });
  });
  const treeM: THREE.Matrix4[] = [];
  let tn = 0;
  const trr = rand(5 + plan.spec.seed);
  const footD = ([
    [FRAMES.port, LOCAL.port.rect],
    // 机场再让出跑道外侧的升降带和两头的净空
    [FRAMES.airport, { ...LOCAL.airport.rect, x0: LOCAL.airport.rect.x0 - 100, x1: LOCAL.airport.rect.x1 + 250, z1: LOCAL.airport.rect.z1 + 120 }],
    [FRAMES.park, LOCAL.park.rect],
  ] as const).map(([f, rc]) => footprintKm(f, rc).map((k) => ({ x: k.x * S, z: -k.y * S })));
  const forest = (x: number, z: number) => Math.sin(x / 430 + 1.3) * Math.cos(z / 370 - 0.7) + 0.6 * Math.sin((x + z) / 260 + 2.1) + 0.35 * Math.cos((x - 2 * z) / 190);
  for (let tries = 0; tries < 70000 && tn < 3500; tries++) {
    const x = -4000 + trr() * 8800;
    const z = -3600 + trr() * 6400;
    if (forest(x, z) < 0.75 && trr() > 0.06) continue;
    if (!isLand(x, z) || !isLand(x + 25, z) || !isLand(x, z + 25)) continue;
    if (pointInPoly(x, z, cityPoly)) continue;
    if (nearRoad(x, z, 8) || polyDist(x, z, railPts) < 18) continue;
    if (riverD.length && polyDist(x, z, riverD) < riverHalf + 18) continue;
    if (branchD.some((b) => polyDist(x, z, b.pts) < b.half + 16)) continue;
    // 设施周边的物流、工业、商业片区和农田不种成片的树
    const lg = LAND[landAt(zoning.landuse, { x: x / S, y: -z / S })]?.group;
    if (lg === 'W' || lg === 'M' || lg === 'B' || lg === 'S' || lg === 'U') continue;
    if (footD.some((poly) => pointInPoly(x, z, poly)) || lotPolys.some((poly) => pointInPoly(x, z, poly))) continue;
    if (storeSpots.some((p) => Math.hypot(p.x - x, p.z - z) < 110)) continue;
    const s2 = 0.7 + trr() * 0.8;
    treeM.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(s2, s2, s2)));
    tn++;
  }
  // 按 1.6 公里的地块分块（看不到的块不画）；远看林地也要在，不按远近藏
  group.add(chunkInstances(merge([cyl(0.6, 0.8, 5, '#7a5a3a', 0, 0, 0), cyl(0, 5, 11, '#5e8f4e', 0, 4, 0, 7)]), VC, treeM.map((mm) => ({ m: mm })), 'trees', { cell: 1600, cast: true }));

  // 内陆供应商方向的高速出口
  labels.push({ text: `往${DIR_LABEL[dirOf(plan.offmap.NORTH)]} · 国内长途、内陆产区`, pos: P(NODES.NORTH as Km).add(new THREE.Vector3(0, 30, 0)), kind: 'zone' });
  labels.push({ text: `往${DIR_LABEL[dirOf(plan.offmap.EAST)]} · 跨境长途（洲际公路）`, pos: P(NODES.EAST as Km).add(new THREE.Vector3(0, 30, 0)), kind: 'zone' });

  // —— 门店：综合店的百货日用馆和收货区（两种方案）；中间的生鲜食品区放 StoreX 门店模型（由视图加进来） ——
  const stores = buildStores(sites);
  group.add(stores.group);
  const fs = [...sites.values()].find((x) => x.st.flagship) as Site;
  const flagship: World['flagship'] = { origin: toWorld(fs, -42, -35), rotation: fs.rot };
  for (const site of sites.values()) labels.push({ text: site.st.name, pos: toWorld(site, 0, -40, 30), kind: 'store' });

  const lights: LightSpot[] = [...roads.lampSpots, ...parking.lamps.map((p) => ({ ...p, r: 8, g: 0.3 })), ...parkLights];
  return { group, labels, flagship, net, roads, stores, sites, zoning, parking, doorLights: { mesh: doorLights, index: lightIndex }, frames, lights };
}

/** 多边形往中心缩到 k 倍 */
function shrink(poly: readonly { x: number; z: number }[], k: number): { x: number; z: number }[] {
  const c = { x: poly.reduce((a, p) => a + p.x, 0) / poly.length, z: poly.reduce((a, p) => a + p.z, 0) / poly.length };
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * k, z: c.z + (p.z - c.z) * k }));
}

/** 把一个零件绕点 c 转 ang（绕 y 轴）：零件是沿 z 方向画的，转完沿 (sin ang, cos ang) 方向 */
function rotatePart(p: Part, c: THREE.Vector3, ang: number): Part[] {
  p.translate(-c.x, 0, -c.z);
  p.rotateY(ang);
  p.translate(c.x, 0, c.z);
  return [p];
}
