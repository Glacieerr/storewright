import * as THREE from 'three';
import { merge, box as part, cyl } from '../../../../StoreX/web/src/three/models';
import { RAIL } from '../../../src/region/region';
import { cumulative, dirOf, GeoBuilder, offset, resample, sampleAt, segIntersect, slice, v3, type V3 } from './geo';
import { chunkInstances } from './lod';
import { halfAll, halfRoad, P, type Junction, type Leg, type Line, type RoadNet } from './roadnet';
import { AMBER, GREEN, phaseClock } from './signals';

/**
 * 道路网的模型：车行道、标线（车道虚线、边线、中心黄线、人行横道、停止线）、中央分隔带（环线的混凝土护栏、
 * 干道的绿化带、高速的草地和护栏）、人行道和路缘、桥（桥面板、栏杆、桥墩、引桥挡墙）、路口铺装、环岛的中心岛，
 * 信号灯杆（灯色按相位变）、路灯、行道树、铁路（道砟、轨枕、钢轨）和平交道口的栏杆。
 */
const ROAD_Y = 0.3;
const MARK_Y = 0.07;

export interface Signal {
  junction: string;
  phase: 0 | 1;
  offset: number;
  /** 三个灯头的实例编号（红、黄、绿） */
  idx: number;
}
export interface LevelCrossing {
  pos: V3;
  ang: number;
  arms: number[];
}

export interface RoadMeshes {
  group: THREE.Group;
  signals: Signal[];
  crossings: LevelCrossing[];
  /** 夜里亮的灯（路灯灯头、信号灯）材质 */
  lampMat: THREE.MeshBasicMaterial;
  /** 路灯灯头的位置、灯下地面的高度（夜里的光晕和光圈，lamps.ts） */
  lampSpots: { x: number; y: number; z: number; r: number; g: number }[];
  /** 每帧更新信号灯和道口栏杆 */
  update: (t: number, trainsNear: (p: V3, r: number) => boolean) => void;
  /** 道路的折线（城区建筑要避开）：中心线 + 半宽 */
  corridors: { pts: V3[]; hw: number }[];
}

const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });

export function buildRoads(net: RoadNet): RoadMeshes {
  const group = new THREE.Group();
  group.name = 'roads';
  const asphalt = new GeoBuilder().color('#4f5256');
  const asphaltLight = new GeoBuilder().color('#5d6064');
  const walk = new GeoBuilder();
  const median = new GeoBuilder();
  const marks = new GeoBuilder();
  const concrete = new GeoBuilder();
  const corridors: RoadMeshes['corridors'] = [];
  const lights: { p: V3; ang: number; double?: boolean }[] = [];
  const trees: { p: V3; s: number }[] = [];

  for (const line of net.lines) {
    const s0 = line.trimA;
    const s1 = line.len - line.trimB;
    if (s1 - s0 < 2) continue;
    const pts = rangePts(line, s0, s1);
    const xs = line.xs;
    const hw = halfRoad(xs);
    corridors.push({ pts, hw: halfAll(xs) });
    const urban = xs.walk > 0;
    const surface = line.cls === 'service' || line.cls === 'farm' ? asphaltLight : asphalt;
    // 车行道
    if (!xs.oneWay && xs.median > 0) {
      surface.strip(pts, -hw, -xs.median / 2, ROAD_Y);
      surface.strip(pts, xs.median / 2, hw, ROAD_Y);
    } else surface.strip(pts, -hw, hw, ROAD_Y);
    // 桥：桥面板侧面、栏杆、桥墩；引桥用挡墙
    for (const b of line.bridges) bridge(line, Math.max(s0, b.s0), Math.min(s1, b.s1), hw, concrete);
    // 中央分隔带（干道在 T 形路口处断开）
    const gaps = line.mids.map((m) => {
      const j = net.junctions.get(m.j) as Junction;
      const side = j.legs[0];
      return { a: m.s - (side ? side.hwAll + 4 : 10), b: m.s + (side ? side.hwAll + 4 : 10), merge: j.kind === 'merge' };
    });
    const pieces = (from: number, to: number, ignoreMerge = true) => {
      const out: [number, number][] = [];
      let a = from;
      for (const g of gaps.filter((x) => !(ignoreMerge && x.merge)).sort((x, y) => x.a - y.a)) {
        if (g.b < a || g.a > to) continue;
        if (g.a > a) out.push([a, g.a]);
        a = Math.max(a, g.b);
      }
      if (a < to) out.push([a, to]);
      return out;
    };
    if (line.cls === 'arterial' || line.cls === 'under') {
      for (const [a, b] of pieces(s0 + 2, s1 - 2)) {
        const mp = rangePts(line, a, b);
        median.color(line.cls === 'under' ? '#b9b6ae' : '#6f8f55').prism(mp, -xs.median / 2 + 0.15, xs.median / 2 - 0.15, ROAD_Y, ROAD_Y + 0.18);
        median.color('#c4c0b6').wall(mp, -xs.median / 2 + 0.15, ROAD_Y, ROAD_Y + 0.2, -1);
        if (line.cls === 'arterial') for (let s = a + 6; s < b - 4; s += 13) trees.push({ p: sampleAt(line.pts, line.cum, s).p.setY(line.elev(s) + ROAD_Y + 0.18), s: 0.8 + ((s * 7) % 5) / 10 });
      }
    } else if (line.cls === 'ring' || line.cls === 'elevated') {
      median.color('#c9c6bf').prism(pts, -0.35, 0.35, ROAD_Y, ROAD_Y + 0.95);
      median.color('#b3b0a8').strip(pts, -xs.median / 2, -0.35, ROAD_Y + 0.01);
      median.color('#b3b0a8').strip(pts, 0.35, xs.median / 2, ROAD_Y + 0.01);
    } else if (line.cls === 'highway') {
      median.color('#7f9a5c').strip(pts, -xs.median / 2, xs.median / 2, ROAD_Y - 0.08);
      median.color('#a9adb1').prism(pts, -0.12, 0.12, ROAD_Y - 0.08, ROAD_Y + 0.75);
    }
    // 人行道（在侧路口处断开）
    if (urban) {
      for (const [a, b] of pieces(s0 + 1, s1 - 1, false)) {
        const wp = rangePts(line, a, b);
        walk.color('#c9c5bb').prism(wp, hw, hw + xs.walk, ROAD_Y, ROAD_Y + 0.16);
        walk.color('#c9c5bb').prism(wp, -hw - xs.walk, -hw, ROAD_Y, ROAD_Y + 0.16);
      }
    }
    // 标线
    lineMarks(line, s0 + 3, s1 - 3, marks);
    // 路灯、行道树
    const stepL = line.lights === 'median' ? 42 : line.lights === 'both' ? 34 : 38;
    if (line.lights !== 'none')
      for (let s = s0 + 10, k = 0; s < s1 - 8; s += stepL, k++) {
        const q = sampleAt(line.pts, line.cum, s);
        const y = line.elev(s) + ROAD_Y;
        const ang = Math.atan2(q.dx, q.dz);
        if (line.lights === 'median') lights.push({ p: q.p.clone().setY(y + 0.95), ang, double: true });
        else if (line.lights === 'both') {
          const side = k % 2 ? 1 : -1;
          const o = offset([q.p, q.p.clone().add(new THREE.Vector3(q.dx, 0, q.dz))], side * (hw + 0.6))[0] as V3;
          lights.push({ p: o.setY(y + 0.16), ang: ang + (side > 0 ? 0 : Math.PI) });
        } else {
          const o = offset([q.p, q.p.clone().add(new THREE.Vector3(q.dx, 0, q.dz))], hw + 0.5)[0] as V3;
          lights.push({ p: o.setY(y + (urban ? 0.16 : 0)), ang });
        }
      }
    if (line.trees === 'walk')
      for (let s = s0 + 9; s < s1 - 6; s += 17)
        for (const side of [-1, 1]) {
          const q = sampleAt(line.pts, line.cum, s);
          const o = offset([q.p, q.p.clone().add(new THREE.Vector3(q.dx, 0, q.dz))], side * (hw + xs.walk - 0.8))[0] as V3;
          trees.push({ p: o.setY(ROAD_Y + 0.16), s: 0.6 + ((s * 13) % 4) / 10 });
        }
  }

  // 路口
  const signals: Signal[] = [];
  const signalPoles: { p: V3; ang: number; arm: number }[] = [];
  const heads: { p: V3; ang: number }[] = [];
  for (const j of net.junctions.values()) {
    if (j.kind === 'roundabout') roundabout(j, asphalt, median, marks);
    else if (j.kind === 'grade' && j.legs.length >= 2) {
      // 铺装：每条腿退让处的两个角点，按角度排成多边形
      const poly: { x: number; z: number }[] = [];
      for (const leg of j.legs) {
        const line = net.lines[leg.line] as Line;
        const t = leg.end === 'a' ? line.trimA : line.trimB;
        const q = sampleAt(line.pts, line.cum, leg.end === 'a' ? t : line.len - t);
        const u = leg.end === 'a' ? { x: q.dx, z: q.dz } : { x: -q.dx, z: -q.dz };
        const r = { x: -u.z, z: u.x };
        const w = leg.hw + 0.3;
        poly.push({ x: q.p.x - r.x * w, z: q.p.z - r.z * w }, { x: q.p.x + r.x * w, z: q.p.z + r.z * w });
      }
      poly.sort((a, b) => Math.atan2(-(a.z - j.pos.z), a.x - j.pos.x) - Math.atan2(-(b.z - j.pos.z), b.x - j.pos.x));
      asphalt.polygon(poly, ROAD_Y + 0.004);
    } else if (j.kind === 'end' && j.bulb && j.legs.length) {
      // 尽头路的回车场：路的尽头铺一个圆
      const leg = j.legs[0] as Leg;
      const r = leg.hwAll + 6;
      const line = net.lines[leg.line] as Line;
      const q = sampleAt(line.pts, line.cum, leg.end === 'a' ? 0 : line.len);
      const u = leg.end === 'a' ? { x: -q.dx, z: -q.dz } : { x: q.dx, z: q.dz };
      const c = { x: j.pos.x + u.x * (r - leg.hw), z: j.pos.z + u.z * (r - leg.hw) };
      asphalt.polygon(Array.from({ length: 28 }, (_, k) => ({ x: c.x + Math.cos((k / 28) * 2 * Math.PI) * r, z: c.z + Math.sin((k / 28) * 2 * Math.PI) * r })), ROAD_Y + 0.004);
    }
    // 人行横道、停止线、信号灯（城市道路的路口；只有两条腿的转折点不画）
    if (j.kind !== 'grade' && j.kind !== 'mid') continue;
    if (j.kind === 'grade' && j.legs.length < 3) continue;
    for (const leg of j.legs) {
      const line = net.lines[leg.line] as Line;
      // 城市道路画斑马线；匝道、高速、快速路、进出场的路接进信号灯路口的只画停止线和信号灯
      const city = line.cls === 'arterial' || line.cls === 'street' || line.cls === 'local' || line.cls === 'under';
      if (!city && !(j.signal && j.kind === 'grade')) continue;
      const t = leg.end === 'a' ? line.trimA : line.trimB;
      if (t <= 0.5 && j.kind !== 'mid') continue;
      const s = leg.end === 'a' ? t + 1.2 : line.len - t - 1.2;
      const q = sampleAt(line.pts, line.cum, s);
      const u = leg.end === 'a' ? { x: q.dx, z: q.dz } : { x: -q.dx, z: -q.dz };
      const r = { x: -u.z, z: u.x };
      const hw = leg.hw;
      const y = line.elev(s) + ROAD_Y + MARK_Y;
      // 斑马线：沿路方向 4 米长的白条，横向每 1 米一条
      marks.color('#efefea');
      if (city)
        for (let o = -hw + 0.6; o < hw - 0.3; o += 1.0) {
          const c = v3(q.p.x + r.x * o + u.x * 2.2, y, q.p.z + r.z * o + u.z * 2.2);
          marks.box(c.x, y - 0.02, c.z, 0.5, 0.02, 4, Math.atan2(u.x, u.z));
        }
      // 停止线（进口道一侧 = 往路口方向行驶的右侧，也就是 r 的反方向）
      const sl = v3(q.p.x + u.x * 5, y, q.p.z + u.z * 5);
      marks.box(sl.x - r.x * hw * 0.5, y - 0.02, sl.z - r.z * hw * 0.5, hw, 0.02, 0.45, Math.atan2(u.x, u.z) + Math.PI / 2);
      if (j.signal) {
        const pole = v3(q.p.x + u.x * 6.5 - r.x * (hw + 1.4), ROAD_Y + 0.16, q.p.z + u.z * 6.5 - r.z * (hw + 1.4));
        const facing = Math.atan2(u.x, u.z);
        const armLen = Math.max(3, hw - 1.5);
        signalPoles.push({ p: pole, ang: facing + Math.PI / 2, arm: armLen });
        heads.push({ p: v3(pole.x + r.x * armLen * 0.85, 5.6, pole.z + r.z * armLen * 0.85), ang: facing });
        signals.push({ junction: j.id, phase: j.phase.get(leg.line * 2 + (leg.end === 'a' ? 0 : 1)) ?? 0, offset: j.offset, idx: heads.length - 1 });
      }
    }
  }

  // 合成
  const add = (g: GeoBuilder, m: THREE.Material, name: string, receive = true, cast = false) => {
    if (g.empty) return;
    const mesh = new THREE.Mesh(g.build(), m);
    mesh.name = name;
    mesh.receiveShadow = receive;
    mesh.castShadow = cast;
    group.add(mesh);
  };
  add(asphalt, mat({ vertexColors: true, roughness: 0.95 }), 'asphalt');
  add(asphaltLight, mat({ vertexColors: true, roughness: 0.95 }), 'asphalt-light');
  add(walk, mat({ vertexColors: true, roughness: 0.9 }), 'sidewalks');
  add(median, mat({ vertexColors: true, roughness: 0.9 }), 'medians', true, true);
  add(concrete, mat({ vertexColors: true, roughness: 0.85 }), 'bridges', true, true);
  const markMat = mat({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  // 小街路边的停车位：每个车位两头一道白线
  marks.color('#e8e8e2');
  for (const c of net.curbs) {
    const dx = c.b.x - c.a.x;
    const dz = c.b.z - c.a.z;
    const l = Math.hypot(dx, dz) || 1;
    const ang = Math.atan2(dx, dz);
    for (const e of [-3.1, 3.1]) {
      const mx = (c.a.x + c.b.x) / 2 + (dx / l) * e;
      const mz = (c.a.z + c.b.z) / 2 + (dz / l) * e;
      marks.box(mx, ROAD_Y + MARK_Y - 0.02, mz, 2.0, 0.02, 0.12, ang);
    }
  }
  add(marks, markMat, 'markings');

  // 路灯（灯杆 + 灯臂 + 灯头），夜里灯头发光
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fff4d6' });
  const poleGeo = merge([cyl(0.12, 0.16, 10, '#7b8087', 0, 0, 0, 6), part(2.6, 0.12, 0.14, '#7b8087', 1.2, 9.8, 0)]);
  const poleGeo2 = merge([cyl(0.14, 0.18, 11, '#7b8087', 0, 0, 0, 6), part(5.6, 0.12, 0.14, '#7b8087', 0, 10.8, 0)]);
  const single = lights.filter((l) => !l.double);
  const double = lights.filter((l) => l.double);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const inst = (geo: THREE.BufferGeometry, material: THREE.Material, list: { p: V3; ang: number }[], name: string, cast = true) => {
    const im = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
    list.forEach((l, i) => {
      q.setFromAxisAngle(up, l.ang - Math.PI / 2);
      m4.compose(l.p, q, one);
      im.setMatrixAt(i, m4);
    });
    im.count = list.length;
    im.castShadow = cast;
    im.name = name;
    group.add(im);
    return im;
  };
  /** 路灯、行道树：按地块分块（看不到的块不画），镜头 2.6 公里以外整块不画 */
  const chunked = (geo: THREE.BufferGeometry, material: THREE.Material, list: { p: V3; ang: number }[], name: string, cast = true) => {
    if (!list.length) return;
    group.add(
      chunkInstances(
        geo,
        material,
        list.map((l) => ({ m: new THREE.Matrix4().compose(l.p, q.setFromAxisAngle(up, l.ang - Math.PI / 2), one) })),
        name,
        { cast, far: 2600, cell: 600 },
      ),
    );
  };
  const poleMat = mat({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
  chunked(poleGeo, poleMat, single, 'street-lights');
  chunked(poleGeo2, poleMat, double, 'street-lights-double');
  const lampHead = new THREE.BoxGeometry(0.9, 0.18, 0.4);
  const headsList = [...single.map((l) => ({ p: l.p.clone().add(new THREE.Vector3(Math.sin(l.ang - Math.PI / 2 + Math.PI / 2) * 0, 9.7, 0)), ang: l.ang })), ...double.flatMap((l) => [{ p: l.p.clone().setY(l.p.y + 10.7), ang: l.ang }, { p: l.p.clone().setY(l.p.y + 10.7), ang: l.ang + Math.PI }])];
  // 灯头放在灯臂末端
  const lampList = headsList.map((h, i) => {
    const arm = i < single.length ? 2.4 : 2.7;
    const a = h.ang - Math.PI / 2;
    return { p: v3(h.p.x + Math.cos(a) * arm, h.p.y, h.p.z - Math.sin(a) * arm), ang: h.ang };
  });
  chunked(lampHead, lampMat, lampList, 'lamps', false);
  // 夜里的光：灯头的位置、灯下地面的高度
  const lampSpots = lampList.map((l, i) => ({ x: l.p.x, y: l.p.y - 0.15, z: l.p.z, r: 9, g: l.p.y - (i < single.length ? 9.7 : 10.7) }));

  // 信号灯：杆 + 臂，灯头三盏灯按相位亮
  const sigPoleGeo = merge([cyl(0.16, 0.2, 6, '#5b6067', 0, 0, 0, 6)]);
  const sp = inst(sigPoleGeo, poleMat, signalPoles, 'signal-poles');
  void sp;
  const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.18, 0.18).translate(0.5, 0, 0), mat({ color: '#5b6067', roughness: 0.6 }), Math.max(1, signalPoles.length));
  signalPoles.forEach((s, i) => {
    q.setFromAxisAngle(up, s.ang);
    m4.compose(s.p.clone().setY(5.9), q, new THREE.Vector3(s.arm, 1, 1));
    armMesh.setMatrixAt(i, m4);
  });
  armMesh.count = signalPoles.length;
  group.add(armMesh);
  const headBox = inst(new THREE.BoxGeometry(0.45, 1.3, 0.35), mat({ color: '#1d1f22', roughness: 0.6 }), heads, 'signal-heads');
  void headBox;
  // 灯：每个灯头三盏（红黄绿），颜色按相位实时改
  const bulbGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const bulbs = new THREE.InstancedMesh(bulbGeo, new THREE.MeshBasicMaterial({ color: '#ffffff' }), Math.max(1, heads.length * 3));
  bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, heads.length * 3) * 3), 3);
  heads.forEach((h, i) => {
    const fx = Math.sin(h.ang) * 0.2;
    const fz = Math.cos(h.ang) * 0.2;
    for (let k = 0; k < 3; k++) {
      m4.makeTranslation(h.p.x + fx, h.p.y + 0.4 - k * 0.4, h.p.z + fz);
      bulbs.setMatrixAt(i * 3 + k, m4);
    }
  });
  bulbs.count = heads.length * 3;
  bulbs.name = 'signal-bulbs';
  group.add(bulbs);

  // 行道树
  const treeGeo = merge([cyl(0.18, 0.24, 2.6, '#6e5236', 0, 0, 0, 5), painted(new THREE.IcosahedronGeometry(2.2, 0).translate(0, 4.2, 0), '#5f8b48')]);
  if (trees.length)
    group.add(
      chunkInstances(
        treeGeo,
        mat({ vertexColors: true, roughness: 0.9, flatShading: true }),
        trees.map((t, i) => ({ m: new THREE.Matrix4().compose(t.p, q.setFromAxisAngle(up, (i * 1.7) % 6.28), new THREE.Vector3(t.s, t.s * (0.9 + (i % 3) * 0.1), t.s)) })),
        'street-trees',
        { cast: true, far: 2600, cell: 600 },
      ),
    );

  // 铁路
  const crossings = railway(net, group);

  const C_RED = new THREE.Color('#ff3b2f');
  const C_AMBER = new THREE.Color('#ffb21a');
  const C_GREEN = new THREE.Color('#34d058');
  const C_OFF = new THREE.Color('#2a2c2f');
  const update = (t: number, trainsNear: (p: V3, r: number) => boolean) => {
    for (const s of signals) {
      // 配时和车流、仿真车辆用的一样（signals.ts）：绿灯、黄灯、红灯
      const local = phaseClock(s, s.phase, t);
      const green = local < GREEN;
      const amber = local >= GREEN && local < GREEN + AMBER;
      bulbs.setColorAt(s.idx * 3, !green && !amber ? C_RED : C_OFF);
      bulbs.setColorAt(s.idx * 3 + 1, amber ? C_AMBER : C_OFF);
      bulbs.setColorAt(s.idx * 3 + 2, green ? C_GREEN : C_OFF);
    }
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    for (const c of crossings) {
      const down = trainsNear(c.pos, 260);
      for (const idx of c.arms) {
        armMeshRef.getMatrixAt(idx, m4);
        const pos = new THREE.Vector3();
        const sc = new THREE.Vector3();
        const rq = new THREE.Quaternion();
        m4.decompose(pos, rq, sc);
        const base = armBase.get(idx) as number;
        const target = down ? 0 : 1.35;
        const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, base, target));
        m4.compose(pos, qq, sc);
        armMeshRef.setMatrixAt(idx, m4);
      }
    }
    armMeshRef.instanceMatrix.needsUpdate = true;
  };
  const armMeshRef = group.getObjectByName('crossing-arms') as THREE.InstancedMesh;
  const armBase = (armMeshRef?.userData.base as Map<number, number>) ?? new Map();
  return { group, signals, crossings, lampMat, update, corridors, lampSpots };
}

function rangePts(line: Line, a: number, b: number): V3[] {
  const pts = slice(line.pts, line.cum, a, b);
  let acc = a;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += Math.hypot((pts[i] as V3).x - (pts[i - 1] as V3).x, (pts[i] as V3).z - (pts[i - 1] as V3).z);
    (pts[i] as V3).y = line.elev(acc);
  }
  return pts;
}

/** 标线：车道分隔虚线、边线、中心线 */
function lineMarks(line: Line, s0: number, s1: number, g: GeoBuilder): void {
  if (s1 - s0 < 4) return;
  const xs = line.xs;
  const pts = rangePts(line, s0, s1);
  const y = ROAD_Y + 0.02;
  const solid = (off: number, color: string, w = 0.15) => {
    g.color(color).strip(pts, off - w / 2, off + w / 2, y);
  };
  const dashed = (off: number, color: string, dash: number, gap: number, w = 0.15) => {
    g.color(color);
    const cum = cumulative(pts);
    const total = cum[cum.length - 1] as number;
    for (let s = 2; s + dash < total; s += dash + gap) g.strip(slice(pts, cum, s, s + dash), off - w / 2, off + w / 2, y);
  };
  const W = '#efefea';
  const Y = '#e8c547';
  const urban = xs.walk > 0;
  if (xs.oneWay) {
    const hw = (xs.inner + xs.lanes * xs.laneW + xs.outer) / 2;
    solid(-hw + xs.inner, W);
    solid(hw - xs.outer, W);
    return;
  }
  for (const side of [-1, 1]) {
    const inner = xs.median / 2 + xs.inner;
    for (let k = 1; k < xs.lanes; k++) dashed(side * (inner + k * xs.laneW), W, urban ? 3 : 6, urban ? 6 : 12);
    if (xs.median > 0) solid(side * inner, xs.median > 2.5 ? Y : W, 0.15);
    if (!urban || line.cls === 'arterial') solid(side * (inner + xs.lanes * xs.laneW), W);
  }
  if (xs.median === 0) {
    if (line.cls === 'local') {
      solid(-0.12, Y, 0.13);
      solid(0.12, Y, 0.13);
    } else dashed(0, Y, 4, 6, 0.14);
  }
}

/** 桥：在高度大于 0.4 米的地方画桥面板侧面和栏杆；高于 3 米的地方每 24 米一对桥墩，低处是实心挡墙 */
function bridge(line: Line, a: number, b: number, hw: number, g: GeoBuilder): void {
  if (b - a < 4) return;
  const pts = rangePts(line, a, b);
  const cum = cumulative(pts);
  const total = cum[cum.length - 1] as number;
  const segs: V3[][] = [];
  let cur: V3[] = [];
  for (const p of pts) {
    if (p.y > 0.4) cur.push(p);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  for (const sp of segs) {
    if (sp.length < 2) continue;
    // 栏杆（混凝土护栏）
    g.color('#d4d1c9').prism(sp, -hw - 0.5, -hw, ROAD_Y, ROAD_Y + 1.0);
    g.color('#d4d1c9').prism(sp, hw, hw + 0.5, ROAD_Y, ROAD_Y + 1.0);
    // 桥面板侧面：从路面往下 1.4 米；矮处一直到地面（挡墙）
    for (const side of [-1, 1] as const) {
      const W = offset(sp, side * (hw + 0.5));
      for (let i = 0; i < sp.length - 1; i++) {
        const p0 = W[i] as V3;
        const p1 = W[i + 1] as V3;
        const low0 = p0.y > 3.2 ? p0.y - 1.4 : -0.1;
        const low1 = p1.y > 3.2 ? p1.y - 1.4 : -0.1;
        const a0 = v3(p0.x, low0, p0.z);
        const a1 = v3(p1.x, low1, p1.z);
        const b0 = v3(p0.x, p0.y + ROAD_Y, p0.z);
        const b1 = v3(p1.x, p1.y + ROAD_Y, p1.z);
        g.color('#c3bfb6');
        if (side > 0) g.quad(a0, a1, b1, b0);
        else g.quad(a1, a0, b0, b1);
      }
    }
    // 桥底（高处）
    const under = sp.filter((p) => p.y > 3.2);
    if (under.length > 1) {
      const U = under.map((p) => p.clone().setY(p.y - 1.4 - ROAD_Y));
      g.color('#a9a59c');
      const L = offset(U, -hw - 0.5);
      const R = offset(U, hw + 0.5);
      for (let i = 0; i < U.length - 1; i++) g.quad(R[i] as V3, L[i] as V3, L[i + 1] as V3, R[i + 1] as V3, new THREE.Vector3(0, -1, 0));
    }
    // 桥墩
    for (let s = 6; s < total; s += 24) {
      const q = sampleAt(pts, cum, s);
      if (q.p.y < 3.2) continue;
      for (const side of [-1, 1]) {
        const o = offset([q.p, q.p.clone().add(new THREE.Vector3(q.dx, 0, q.dz))], side * hw * 0.55)[0] as V3;
        g.color('#bdb9b0').box(o.x, 0, o.z, 1.6, q.p.y - 1.4, 1.6, Math.atan2(q.dx, q.dz));
      }
      g.color('#b5b1a8').box(q.p.x, q.p.y - 2.4, q.p.z, hw * 1.4, 1.0, 1.8, Math.atan2(q.dx, q.dz) + Math.PI / 2);
    }
  }
  void total;
}

/** 环岛：环形车道、外侧路缘、中心岛（草地、树、雕塑） */
function roundabout(j: Junction, asphalt: GeoBuilder, median: GeoBuilder, marks: GeoBuilder): void {
  const R = j.radius as number;
  const ring = (r: number, n = 96) => Array.from({ length: n + 1 }, (_, i) => v3(j.pos.x + Math.cos((i / n) * Math.PI * 2) * r, 0, j.pos.z - Math.sin((i / n) * Math.PI * 2) * r));
  const mid = ring(R);
  asphalt.strip(mid, -6, 6, ROAD_Y + 0.006);
  // 中心岛
  const island: { x: number; z: number }[] = ring(R - 6.2).map((p) => ({ x: p.x, z: p.z }));
  island.pop();
  median.color('#6e9a52').polygon(island, ROAD_Y + 0.25);
  median.color('#cfcbc2').wall(ring(R - 6.2), 0, ROAD_Y, ROAD_Y + 0.25, -1);
  // 环道分隔虚线
  marks.color('#efefea');
  const cum = cumulative(mid);
  const total = cum[cum.length - 1] as number;
  for (let s = 0; s + 3 < total; s += 9) marks.strip(slice(mid, cum, s, s + 3), -0.08, 0.08, ROAD_Y + 0.03);
  // 中心岛：环形步道、纪念碑
  median.color('#d8d2c4').strip(ring(R - 20), -1.2, 1.2, ROAD_Y + 0.27);
  median.color('#e2ddd2').box(j.pos.x, ROAD_Y + 0.25, j.pos.z, 8, 1.2, 8);
  median.color('#d6d0c2').box(j.pos.x, ROAD_Y + 1.45, j.pos.z, 2.6, 18, 2.6);
  median.color('#c9a85a').box(j.pos.x, ROAD_Y + 19.4, j.pos.z, 1.2, 2.2, 1.2);
}

/** 铁路：道砟、轨枕（实例化）、两根钢轨；和本地道路相交处做平交道口（栏杆按火车远近起落） */
function railway(net: RoadNet, group: THREE.Group): LevelCrossing[] {
  const rail = resample(RAIL.map(P), 6);
  const g = new GeoBuilder();
  g.color('#8a8278').prism(rail, -2.8, 2.8, 0, 0.35);
  g.color('#9c9488').strip(rail, -4.2, 4.2, 0.02);
  const rails = new GeoBuilder();
  rails.color('#6b6b6b').prism(rail, -0.79, -0.71, 0.5, 0.68);
  rails.color('#6b6b6b').prism(rail, 0.71, 0.79, 0.5, 0.68);
  const m1 = new THREE.Mesh(g.build(), mat({ vertexColors: true, roughness: 1 }));
  m1.receiveShadow = true;
  m1.name = 'rail-bed';
  const m2 = new THREE.Mesh(rails.build(), mat({ vertexColors: true, roughness: 0.4, metalness: 0.7 }));
  m2.name = 'rails';
  group.add(m1, m2);
  // 轨枕：每 1.6 米一根
  const cum = cumulative(rail);
  const total = cum[cum.length - 1] as number;
  const n = Math.floor(total / 1.6);
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.16, 0.26), mat({ color: '#5a4d40', roughness: 1 }), n);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const smp = sampleAt(rail, cum, i * 1.6);
    q.setFromAxisAngle(up, Math.atan2(smp.dx, smp.dz) + Math.PI / 2);
    m4.compose(smp.p.clone().setY(0.42), q, new THREE.Vector3(1, 1, 1));
    sleepers.setMatrixAt(i, m4);
  }
  sleepers.name = 'sleepers';
  sleepers.receiveShadow = true;
  group.add(sleepers);
  // 平交道口：本地道路、街道和铁路在地面上的交点
  const crossings: LevelCrossing[] = [];
  const armList: { p: V3; ang: number }[] = [];
  const plates = new GeoBuilder();
  for (const line of net.lines) {
    if (line.cls === 'highway' || line.cls === 'ring' || line.cls === 'elevated' || line.cls === 'ramp') continue;
    for (let i = 1; i < line.pts.length; i++)
      for (let k = 1; k < rail.length; k++) {
        const hit = segIntersect(line.pts[i - 1] as V3, line.pts[i] as V3, rail[k - 1] as V3, rail[k] as V3);
        if (!hit) continue;
        const s = (line.cum[i - 1] as number) + hit.t * ((line.cum[i] as number) - (line.cum[i - 1] as number));
        // 这里路已经上桥跨过铁路（干道、桥下的路）：不是平交道口
        if (line.elev(s) > 2) continue;
        const smp = sampleAt(line.pts, line.cum, s);
        const hw = halfRoad(line.xs);
        plates.color('#b9b5ab').strip(slice(line.pts, line.cum, s - 4, s + 4), -hw, hw, ROAD_Y + 0.02);
        const ang = Math.atan2(smp.dx, smp.dz);
        const c: LevelCrossing = { pos: smp.p.clone(), ang, arms: [] };
        for (const side of [-1, 1]) {
          const along = { x: smp.dx * 7 * side, z: smp.dz * 7 * side };
          const r = { x: -smp.dz, z: smp.dx };
          c.arms.push(armList.length);
          armList.push({ p: v3(smp.p.x + along.x + r.x * (hw + 0.6) * side, 1.1, smp.p.z + along.z + r.z * (hw + 0.6) * side), ang: ang + (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
        }
        crossings.push(c);
        net.crossings.push({ pos: smp.p.clone(), ang, line: line.id, s });
      }
  }
  if (!plates.empty) {
    const pm = new THREE.Mesh(plates.build(), mat({ vertexColors: true, roughness: 0.9 }));
    pm.name = 'crossing-plates';
    group.add(pm);
  }
  // 栏杆：红白相间的杆（几何体沿 +x，绕 z 轴转抬起）
  const armGeo = merge([part(7, 0.18, 0.18, '#f2f2f0', 3.5, -0.09, 0), part(1.2, 0.2, 0.2, '#d83b2f', 1.2, -0.1, 0), part(1.2, 0.2, 0.2, '#d83b2f', 3.6, -0.1, 0), part(1.2, 0.2, 0.2, '#d83b2f', 6, -0.1, 0)]);
  const arms = new THREE.InstancedMesh(armGeo, mat({ vertexColors: true, roughness: 0.6 }), Math.max(1, armList.length));
  const base = new Map<number, number>();
  armList.forEach((a, i) => {
    base.set(i, a.ang);
    m4.compose(a.p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a.ang, 1.35)), new THREE.Vector3(1, 1, 1));
    arms.setMatrixAt(i, m4);
  });
  arms.count = armList.length;
  arms.name = 'crossing-arms';
  arms.userData.base = base;
  group.add(arms);
  // 道口立柱
  const posts = new THREE.InstancedMesh(merge([cyl(0.12, 0.12, 3, '#d8d8d4', 0, 0, 0, 6), part(0.6, 0.6, 0.1, '#d83b2f', 0, 2.4, 0.1)]), mat({ vertexColors: true }), Math.max(1, armList.length));
  armList.forEach((a, i) => {
    m4.compose(a.p.clone().setY(0), new THREE.Quaternion().setFromAxisAngle(up, a.ang), new THREE.Vector3(1, 1, 1));
    posts.setMatrixAt(i, m4);
  });
  posts.count = armList.length;
  group.add(posts);
  void dirOf;
  return crossings;
}

/** 给几何体加顶点颜色（和 StoreX 的零件一样带 position / normal / uv / color，才能合并） */
export function painted(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}
