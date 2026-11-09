import * as THREE from 'three';
import { cyl, merge, type Part } from '../../../../../StoreX/web/src/three/models';
import { AISLE_W, FLARE, GATE_W, MEDIAN_W, SPOT_D, SPOT_W, type Rect, type Stall } from '../../../../src/site/lot';
import { GeoBuilder } from '../geo';
import type { LightSpot } from '../lamps';
import { EXT, toWorld, TRUCK_X, type Site } from '../stores';
import { tx } from '../../i18n';

/**
 * 综合店站点的静态部分（门店本地坐标，整组按站点的位置、朝向摆）：店前停车场、西侧的即时取货区、门前路和出入口、
 * 店后收货场的地面和标线（收货场引擎排的车道线、箭头、待命车位框、甩挂车位、「货车入口」牌）。
 *
 * - 地面：沥青（停车场、取货区、门前路、收货场）、水泥（店门前和西墙外的人行道、收货口前的地坪），路缘石围起来的绿岛种树；
 * - 标线：车位线（背靠背的双排中间一条线）、无障碍车位（蓝底、轮椅标志，旁边 1.2 米的斜线通道）、充电车位（绿底、闪电，
 *   车头前的充电桩）、即时取货车位（橙底、白色编号）、配送车装车位、免下车取货位的停止线和编号、消防车道的黄线和斜线、
 *   斑马线、出入口的进出箭头和停车线、门前路的双黄线；
 * - 设施：灯杆（夜里灯头亮，地上一圈光由 NightLights 画）、购物车回收栏、免下车取货的雨棚和取货口、指示牌（画布文字）、
 *   店门前的防撞柱。
 * 都只是画面；车位、车道的位置来自 src/site/lot.ts，车按它在 store/cars.ts 里走。
 */

const Y = 0.3;
const MK = 0.318;
const WALK_Y = 0.42;
const CURB_Y = 0.46;
const WHITE = '#eceae4';
/** 消防车道的黄线从环形车道里面开始（两头让出环形车道） */
const PERIM_FIRE_INSET = 7;
const YELLOW = '#e8c33a';

export interface LotView {
  /** 整组（站点坐标系） */
  group: THREE.Group;
  /** 地面（沥青、水泥、标线）：交给天气（下雨变湿、积水） */
  surface: THREE.Group;
  /** 灯杆灯头的位置（世界坐标）：交给 NightLights 画光晕和地上的光圈 */
  lamps: LightSpot[];
  setNight(k: number): void;
}

/** 画布上写字的贴图（指示牌、地面上的字） */
function textTexture(raw: string, bg: string, fg: string, w = 512, h = 128, font = 64): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return undefined;
  // 英文界面按字典翻译（「即时取货 · {n} 个车位」这种按句式翻）
  const text = tx(raw);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = `600 ${font}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = font;
  while (ctx.measureText(text).width > w * 0.92 && size > 12) {
    size -= 4;
    ctx.font = `600 ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  }
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 七段数码管式的数字（地上的车位编号）：中心 (x, z)，字高 h，字头朝 heading（atan2(dx, dz)，读的人面朝这个方向） */
function digit(g: GeoBuilder, n: number, x: number, z: number, h: number, heading: number): void {
  const SEG: Record<number, string> = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
  const w = h * 0.55;
  const t = h * 0.13;
  // 字的本地坐标：v 向上（字头方向），u 向右（读的人的右手方向）
  const vx = Math.sin(heading);
  const vz = Math.cos(heading);
  const ux = -vz;
  const uz = vx;
  const P = (u: number, v: number) => ({ x: x + u * ux + v * vx, z: z + u * uz + v * vz });
  const bar = (u0: number, v0: number, u1: number, v1: number) => {
    const a = P(u0, v0);
    const b = P(u1, v1);
    const len = Math.hypot(b.x - a.x, b.z - a.z) + t;
    g.box((a.x + b.x) / 2, MK, (a.z + b.z) / 2, t, 0.012, len, Math.atan2(b.x - a.x, b.z - a.z));
  };
  const segs = SEG[n % 10] ?? '';
  const hw = w / 2;
  const hh = h / 2;
  if (segs.includes('a')) bar(-hw, hh, hw, hh);
  if (segs.includes('g')) bar(-hw, 0, hw, 0);
  if (segs.includes('d')) bar(-hw, -hh, hw, -hh);
  if (segs.includes('f')) bar(-hw, 0, -hw, hh);
  if (segs.includes('b')) bar(hw, 0, hw, hh);
  if (segs.includes('e')) bar(-hw, -hh, -hw, 0);
  if (segs.includes('c')) bar(hw, -hh, hw, 0);
}

/** 地上的行车方向箭头（白色）：箭杆加两片箭翼，箭头朝 heading（atan2(dx, dz)） */
function arrow(g: GeoBuilder, x: number, z: number, heading: number, len = 4.2): void {
  const dx = Math.sin(heading);
  const dz = Math.cos(heading);
  const nx = -dz;
  const nz = dx;
  const bar = (ax: number, az: number, bx: number, bz: number, w: number) => g.box((ax + bx) / 2, MK, (az + bz) / 2, w, 0.012, Math.hypot(bx - ax, bz - az), Math.atan2(bx - ax, bz - az));
  const tipX = x + (dx * len) / 2;
  const tipZ = z + (dz * len) / 2;
  bar(x - (dx * len) / 2, z - (dz * len) / 2, tipX - dx * 0.3, tipZ - dz * 0.3, 0.3);
  for (const s of [-1, 1]) bar(tipX, tipZ, tipX - dx * 1.0 + s * nx * 0.62, tipZ - dz * 1.0 + s * nz * 0.62, 0.26);
}

/** 一条细线（标线）：从 a 到 b，宽 w */
function line(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, w = 0.12): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.05) return;
  g.box((ax + bx) / 2, MK, (az + bz) / 2, w, 0.01, len, Math.atan2(bx - ax, bz - az));
}

/** 喇叭口：路缘圆弧（半径 r）和两条直边围成的那一小块路面；corner 是两条边的交点，ux / uz 指向两条边各自离开拐角的方向 */
function flare(corner: { x: number; z: number }, ux: { x: number; z: number }, uz: { x: number; z: number }, r: number, steps = 10): { x: number; z: number }[] {
  const cx = corner.x + (ux.x + uz.x) * r;
  const cz = corner.z + (ux.z + uz.z) * r;
  const a0 = Math.atan2(-uz.z, -uz.x);
  const a1 = Math.atan2(-ux.z, -ux.x);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const pts = [{ ...corner }];
  for (let k = 0; k <= steps; k++) pts.push({ x: cx + r * Math.cos(a0 + (da * k) / steps), z: cz + r * Math.sin(a0 + (da * k) / steps) });
  return pts;
}

const circle = (c: { x: number; z: number }, r: number, n = 36) => Array.from({ length: n }, (_, k) => ({ x: c.x + Math.cos((k / n) * 2 * Math.PI) * r, z: c.z + Math.sin((k / n) * 2 * Math.PI) * r }));
const rectPoly = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

/** 树：圆锥树冠和树干（和城区的树一个样子） */
function tree(parts: Part[], x: number, z: number, s = 1): void {
  parts.push(cyl(0.18 * s, 0.24 * s, 1.6 * s, '#7a5a3a', x, CURB_Y, z, 6));
  parts.push(cyl(0, 2.1 * s, 4.6 * s, '#5e8f4e', x, CURB_Y + 1.3 * s, z, 7));
}

export function buildLotView(site: Site): LotView {
  const lot = site.lot;
  const group = new THREE.Group();
  group.name = 'store-site';
  group.position.copy(site.center).setY(0);
  group.rotation.y = site.rot;
  const surface = new THREE.Group();
  surface.name = 'store-site-surface';
  surface.position.copy(group.position);
  surface.rotation.y = group.rotation.y;

  const asphalt = new GeoBuilder();
  const concrete = new GeoBuilder();
  const marks = new GeoBuilder();
  const curbs = new GeoBuilder();
  const props = new GeoBuilder();
  const heads = new GeoBuilder();
  const treeParts: Part[] = [];
  const signs: Array<{ x: number; z: number; heading: number; text: string; kind: 'truck' }> = [];
  const W = lot.west;

  // —— 沥青 ——
  asphalt.color('#4d5055').polygon(rectPoly(lot.x0, lot.frontZ, lot.x1, lot.edgeZ), Y);
  asphalt.color('#4d5055').polygon(rectPoly(W.outerX - 2, W.zNorth, W.walkX, lot.frontZ + 0.01), Y - 0.001);
  asphalt.color('#4d5055').polygon(circle(W.bulb.c, W.bulb.pave), Y - 0.002);
  // 免下车取货车道颜色深一点（新铺的）
  asphalt.color('#45484d').polygon(rectPoly(W.driveX0, W.driveZ[0], W.driveX1, W.driveZ[1]), Y + 0.002);
  // 门前路和出入口（喇叭口）
  const F = lot.frontage;
  asphalt.color('#505358').polygon(rectPoly(F.x0, F.z - F.half, F.x1, F.z + F.half), Y + 0.001);
  const gateZ0 = lot.edgeZ;
  const gateZ1 = F.z - F.half;
  for (const g of lot.gates) {
    asphalt.color('#4d5055').polygon(rectPoly(g.x - GATE_W / 2, gateZ0 - 0.01, g.x + GATE_W / 2, gateZ1 + 0.01), Y);
    asphalt.polygon(flare({ x: g.x - GATE_W / 2, z: gateZ1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, FLARE), Y + 0.001);
    asphalt.polygon(flare({ x: g.x + GATE_W / 2, z: gateZ1 }, { x: 1, z: 0 }, { x: 0, z: -1 }, FLARE), Y + 0.001);
  }

  // —— 水泥人行道（高出沥青 12 厘米）：店门前、西墙外、停车场外沿 ——
  concrete.color('#c9c6bd');
  concrete.box((EXT.x0 + EXT.x1) / 2, Y - 0.05, (lot.front + lot.frontZ) / 2, EXT.x1 - EXT.x0 + 0.4, WALK_Y - Y + 0.05, lot.frontZ - lot.front);
  concrete.box((W.walkX + W.wallX) / 2, Y - 0.05, (W.zNorth + lot.frontZ) / 2, W.wallX - W.walkX, WALK_Y - Y + 0.05, lot.frontZ - W.zNorth);
  const edgeWalk = (x0: number, x1: number) => concrete.box((x0 + x1) / 2, Y - 0.05, lot.edgeZ + 3, x1 - x0, WALK_Y - Y + 0.05, 2);
  const gx = lot.gates.map((g) => g.x).sort((a, b) => a - b);
  edgeWalk(lot.x0, (gx[0] as number) - GATE_W / 2);
  edgeWalk((gx[0] as number) + GATE_W / 2, (gx[1] as number) - GATE_W / 2);
  edgeWalk((gx[1] as number) + GATE_W / 2, lot.x1);
  // 人行道和停车场之间的绿化带（2 米，灌木）
  const edgeGreen = (x0: number, x1: number) => {
    curbs.color('#7da35d').box((x0 + x1) / 2, Y - 0.05, lot.edgeZ + 1, x1 - x0, CURB_Y - Y, 2);
    for (let x = x0 + 2; x < x1 - 1.5; x += 4.5) treeParts.push(cyl(0.8, 0.95, 1.0, '#5f8f4a', x, CURB_Y, lot.edgeZ + 1, 7));
  };
  edgeGreen(lot.x0, (gx[0] as number) - GATE_W / 2 - 0.4);
  edgeGreen((gx[0] as number) + GATE_W / 2 + 0.4, (gx[1] as number) - GATE_W / 2 - 0.4);
  edgeGreen((gx[1] as number) + GATE_W / 2 + 0.4, lot.x1);

  // —— 绿岛（路缘石 + 草 + 树）——
  const island = (r: Rect, withTree: boolean) => {
    curbs.color('#b9b6ad').box(r.x, Y - 0.04, r.z, r.w, CURB_Y - Y + 0.02, r.d);
    curbs.color('#78a05a').box(r.x, CURB_Y - 0.02, r.z, Math.max(0.1, r.w - 0.3), 0.03, Math.max(0.1, r.d - 0.3));
    if (withTree) tree(treeParts, r.x, r.z, Math.min(1, r.w / 2.4) * 0.9 + 0.1);
  };
  for (const i of lot.islands) island(i, i.tree);
  // 取货区中间的绿化带、回车场的绿岛、两条车道之间的路缘岛
  const med: Rect = { x: (W.medianX[0] + W.medianX[1]) / 2, z: (W.zNorth + 3 + lot.frontZ - 1.5) / 2, w: W.medianX[1] - W.medianX[0], d: lot.frontZ - 1.5 - (W.zNorth + 3) };
  island(med, false);
  for (let z = med.z - med.d / 2 + 4; z < med.z + med.d / 2 - 2; z += 9) tree(treeParts, med.x, z, 0.85);
  curbs.color('#b9b6ad').polygon(circle(W.bulb.c, W.bulb.island + 0.2), CURB_Y - 0.01);
  curbs.color('#78a05a').polygon(circle(W.bulb.c, W.bulb.island), CURB_Y);
  tree(treeParts, W.bulb.c.x, W.bulb.c.z, 1.1);
  island(W.curb, false);
  // 出入口中间的隔离岛
  for (const g of lot.gates) island({ x: g.x, z: (gateZ0 + gateZ1) / 2 - 0.3, w: MEDIAN_W, d: gateZ1 - gateZ0 - 0.6 }, false);
  // 停车场东侧到货车通道之间的绿化带（树）
  const ex0 = lot.x1 + 1;
  const ex1 = TRUCK_X - 6;
  curbs.color('#86a866').box((ex0 + ex1) / 2, Y - 0.08, (EXT.z0 + F.z) / 2, ex1 - ex0, 0.12, F.z - EXT.z0);
  for (let z = EXT.z0 + 6; z < F.z - 4; z += 11) for (const x of [ex0 + 3, ex1 - 3]) tree(treeParts, x, z, 1.05);

  // —— 车位标线 ——
  marks.color(WHITE);
  const sideLines = new Set<string>();
  const stallLines = (s: Stall) => {
    // 车位两边的线：从车道一侧（车尾）往车头方向，长度 = 车位深 − 0.3
    const along = { x: Math.sin(s.heading), z: Math.cos(s.heading) };
    const across = { x: Math.cos(s.heading), z: -Math.sin(s.heading) };
    for (const k of [-1, 1]) {
      const cx = s.x + (across.x * k * s.w) / 2;
      const cz = s.z + (across.z * k * s.w) / 2;
      const key = `${cx.toFixed(1)},${cz.toFixed(1)}`;
      if (sideLines.has(key)) continue;
      sideLines.add(key);
      line(marks, cx - (along.x * (s.d - 0.3)) / 2, cz - (along.z * (s.d - 0.3)) / 2, cx + (along.x * (s.d - 0.3)) / 2, cz + (along.z * (s.d - 0.3)) / 2);
    }
  };
  for (const i of lot.frontStalls) stallLines(lot.stalls[i] as Stall);
  // 双排中间的背靠背线、第一排车头的线（消防车道边）
  const rows = lot.aisles.length - 1;
  for (let r = 0; r < rows; r++) {
    const zc = (lot.aisles[r] as number) + AISLE_W / 2 + SPOT_D;
    line(marks, lot.rowX0, zc, lot.rowX0 + lot.perRow * SPOT_W, zc);
  }
  // 消防车道：两边黄线、两头斜线、地上写「消防车道」
  marks.color(YELLOW);
  for (const z of [lot.fireLane[0] + 0.15, lot.fireLane[1] - 0.15]) line(marks, lot.x0 + PERIM_FIRE_INSET, z, lot.x1 - PERIM_FIRE_INSET, z, 0.15);
  for (const x0 of [lot.x0 + 7.5, lot.x1 - 13.5]) for (let k = 0; k < 6; k++) line(marks, x0 + k * 1.1, lot.fireLane[0] + 0.4, x0 + k * 1.1 + 2.2, lot.fireLane[1] - 0.4, 0.14);
  // 无障碍车位（蓝底 + 轮椅）、斜线通道
  for (const s of lot.stalls) {
    if (s.kind === 'accessible') {
      marks.color('#2f6fb8').box(s.x, Y + 0.008, s.z, s.w - 0.2, 0.004, s.d - 0.4);
      marks.color(WHITE);
      // 轮椅：坐垫、靠背、轮子（简化）
      marks.box(s.x, MK + 0.004, s.z + 0.2, 0.9, 0.006, 0.18);
      marks.box(s.x - 0.35, MK + 0.004, s.z - 0.15, 0.18, 0.006, 0.9);
      marks.polygon(circle({ x: s.x + 0.15, z: s.z + 0.55 }, 0.42, 14), MK + 0.002);
      marks.color('#2f6fb8').polygon(circle({ x: s.x + 0.15, z: s.z + 0.55 }, 0.28, 14), MK + 0.004);
    } else if (s.kind === 'ev') {
      marks.color('#3f8a5a').box(s.x, Y + 0.008, s.z, s.w - 0.2, 0.004, s.d - 0.4);
      marks.color(WHITE);
      // 闪电
      marks.box(s.x + 0.12, MK + 0.004, s.z + 0.35, 0.22, 0.006, 0.9, 0.45);
      marks.box(s.x - 0.12, MK + 0.004, s.z - 0.35, 0.22, 0.006, 0.9, 0.45);
      marks.box(s.x, MK + 0.004, s.z, 0.6, 0.006, 0.2);
      // 车头前的充电桩
      const nose = { x: s.x + Math.sin(s.heading) * (s.d / 2 + 0.25), z: s.z + Math.cos(s.heading) * (s.d / 2 + 0.25) };
      props.color('#e9ecef').box(nose.x, Y, nose.z, 0.45, 1.5, 0.32, s.heading);
      props.color('#3f8a5a').box(nose.x, Y + 1.1, nose.z, 0.47, 0.25, 0.34, s.heading);
    }
  }
  marks.color(WHITE);
  for (const h of lot.hatches) {
    line(marks, h.x - h.w / 2, h.z - h.d / 2, h.x - h.w / 2, h.z + h.d / 2, 0.1);
    line(marks, h.x + h.w / 2, h.z - h.d / 2, h.x + h.w / 2, h.z + h.d / 2, 0.1);
    for (let k = 0; k < Math.floor(h.d / 0.8); k++) {
      const z = h.z - h.d / 2 + 0.4 + k * 0.8;
      line(marks, h.x - h.w / 2 + 0.05, z - 0.35, h.x + h.w / 2 - 0.05, z + 0.35, 0.1);
    }
  }
  // 斑马线（人行通道穿过车道和消防车道）
  for (const c of lot.crossings) {
    const n = Math.floor(c.d / 0.9);
    for (let k = 0; k < n; k++) marks.box(c.x, MK, c.z - c.d / 2 + 0.45 + k * 0.9, c.w, 0.01, 0.45);
  }
  // 人行通道（铺装，高出车位）
  for (let r = 0; r < rows; r++) {
    const zc = (lot.aisles[r] as number) + AISLE_W / 2 + SPOT_D;
    concrete.color('#cfcac0').box(lot.walkX, Y - 0.05, zc, SPOT_W - 1.0, WALK_Y - Y + 0.05, SPOT_D * 2 - 0.6);
  }
  concrete.box(lot.walkX, Y - 0.05, (lot.fireLane[1] + (lot.aisles[0] as number) - AISLE_W / 2) / 2, SPOT_W - 1.0, WALK_Y - Y + 0.05, SPOT_D - 0.4);

  // 出入口：进出箭头、出口停车线；门前路的双黄线、两边白线
  for (const g of lot.gates) {
    arrow(marks, g.inX, (gateZ0 + gateZ1) / 2 + 0.4, Math.PI, 3.6);
    arrow(marks, g.outX, (gateZ0 + gateZ1) / 2 - 0.4, 0, 3.6);
    marks.color(WHITE).box(g.outX, MK, gateZ1 - 0.4, 3.0, 0.01, 0.4);
    // 环形车道上的箭头（进场的往北、出场的往南）
    arrow(marks, g.inX, (lot.aisles[0] as number) + 4, Math.PI);
    arrow(marks, g.outX, (lot.aisles[rows] as number) - 4, 0);
  }
  marks.color(YELLOW);
  const t0 = -6;
  const t1 = 6;
  for (const dz of [-0.15, 0.15]) {
    line(marks, F.x0 + 2, F.z + dz, t0, F.z + dz, 0.11);
    line(marks, t1, F.z + dz, F.x1 - 2, F.z + dz, 0.11);
  }
  marks.color(WHITE);
  // 消防车道东西两头：取货区的出口停车线（服务车道、免下车车道往南出来）
  marks.box(W.serviceX, MK, lot.frontZ - 0.6, W.serviceHalf * 2 - 0.4, 0.01, 0.4);
  marks.box(W.driveLaneX, MK, lot.frontZ - 0.6, W.driveX1 - W.driveX0 - 0.4, 0.01, 0.4);

  // —— 西侧即时取货区 ——
  // 车道方向箭头：外侧车道往北、服务车道往南、免下车车道往南
  for (let z = W.zNorth + 8; z < lot.frontZ - 4; z += 14) {
    arrow(marks, W.outerX, z, Math.PI);
    arrow(marks, W.serviceX, z + 6, 0);
  }
  arrow(marks, W.driveLaneX, W.driveZ[0] + 1.2, 0, 3.4);
  // 即时取货车位：橙底、白框、编号
  for (const i of lot.pickup) {
    const s = lot.stalls[i] as Stall;
    marks.color('#d9822b').box(s.x, Y + 0.008, s.z, s.d - 0.3, 0.004, s.w - 0.25);
    marks.color(WHITE);
    line(marks, s.x - s.d / 2, s.z - s.w / 2, s.x + s.d / 2, s.z - s.w / 2, 0.12);
    line(marks, s.x - s.d / 2, s.z + s.w / 2, s.x + s.d / 2, s.z + s.w / 2, 0.12);
    digit(marks, Number(s.id), s.x - 0.9, s.z, 1.5, Math.PI / 2);
  }
  // 配送车装车位
  for (const i of lot.vans) {
    const s = lot.stalls[i] as Stall;
    marks.color('#5c7c9c').box(s.x, Y + 0.008, s.z, s.d - 0.3, 0.004, s.w - 0.25);
    marks.color(WHITE);
    line(marks, s.x - s.d / 2, s.z - s.w / 2, s.x + s.d / 2, s.z - s.w / 2, 0.12);
    line(marks, s.x - s.d / 2, s.z + s.w / 2, s.x + s.d / 2, s.z + s.w / 2, 0.12);
  }
  // 免下车取货位：车道两边黄线、每个取货位车头前的停止线和编号
  marks.color(YELLOW);
  line(marks, W.driveX0 + 0.1, W.driveZ[0] + 0.5, W.driveX0 + 0.1, W.driveZ[1] - 0.5, 0.14);
  marks.color(WHITE);
  lot.drive.forEach((d, k) => {
    marks.box(d.x, MK, d.z + 2.6, W.driveX1 - W.driveX0 - 0.6, 0.01, 0.35);
    digit(marks, k + 1, d.x, d.z + 1.2, 1.1, 0);
  });
  // 雨棚（立柱在路缘岛上）、取货口（墙上的窗口、上方的灯箱）
  const cp = W.canopy;
  props.color('#e3e6ea').box(cp.x, 4.6, cp.z, cp.w + 0.6, 0.35, cp.d);
  props.color('#d9822b').box(cp.x - cp.w / 2 - 0.3, 4.35, cp.z, 0.08, 0.7, cp.d);
  for (const z of [cp.z - cp.d / 2 + 0.8, cp.z, cp.z + cp.d / 2 - 0.8]) props.color('#7d8288').box(W.curb.x, CURB_Y, z, 0.3, 4.6 - CURB_Y, 0.3);
  props.color('#3b4148').box(W.hatch.x - 0.12, 0.95, W.hatch.z, 0.3, 1.4, 1.8);
  props.color('#9fc1dd').box(W.hatch.x - 0.28, 1.05, W.hatch.z, 0.06, 1.1, 1.5);

  // —— 购物车回收栏：两边、后面的栏杆，顶上一块牌子 ——
  for (const c of lot.corrals) {
    props.color('#9aa0a6');
    for (const k of [-1, 1]) {
      props.box(c.x + (k * c.w) / 2, Y + 0.85, c.z, 0.06, 0.06, c.d);
      props.box(c.x + (k * c.w) / 2, Y + 0.35, c.z, 0.06, 0.06, c.d);
      for (const e of [-1, 0, 1]) props.box(c.x + (k * c.w) / 2, Y, c.z + (e * c.d) / 2.05, 0.08, 0.9, 0.08);
    }
    props.box(c.x, Y + 0.85, c.z - c.d / 2, c.w, 0.06, 0.06);
    props.color('#2a78d6').box(c.x, Y + 1.6, c.z - c.d / 2 + 0.1, 1.2, 0.5, 0.06);
    props.color('#9aa0a6').box(c.x, Y, c.z - c.d / 2 + 0.1, 0.08, 1.6, 0.08);
  }

  // —— 店门前的防撞柱（斑马线那一段让开）——
  props.color('#d9b23a');
  for (let x = EXT.x0 + 2; x < EXT.x1 - 1; x += 2.4) {
    if (Math.abs(x - lot.walkX) < 2.2) continue;
    props.box(x, WALK_Y, lot.frontZ - 0.35, 0.22, 0.85, 0.22);
  }

  // —— 灯杆：杆、臂、灯头（灯头夜里亮）——
  const lamps: LightSpot[] = [];
  const pole = (x: number, z: number, h = 9, arms = 2) => {
    props.color('#7a8087').box(x, Y, z, 0.24, h, 0.24);
    for (let a = 0; a < arms; a++) {
      const dx = arms === 1 ? 0 : a === 0 ? -1 : 1;
      props.color('#7a8087').box(x + dx * 0.7, Y + h - 0.15, z, 1.4, 0.12, 0.14);
      heads.color('#fff3d6').box(x + dx * 1.3, Y + h - 0.35, z, 0.7, 0.2, 0.42);
      const w = toWorld(site, x + dx * 1.3, z, Y + h - 0.4);
      lamps.push({ x: w.x, y: w.y, z: w.z, r: 11, g: Y });
    }
  };
  for (const p of lot.poles) pole(p.x, p.z);
  for (const x of [F.x0 + 10, -24, 24, F.x1 - 8]) pole(x, F.z + F.half + 1.6, 8, 1);

  // —— 货车通道：中心双黄线，从进店路分出去的路口两边是半径 15 米的喇叭口 ——
  const tp = site.truck?.pts ?? [];
  marks.color(YELLOW);
  for (let i = 2; i < tp.length; i++) {
    const a = tp[i - 1] as { x: number; z: number };
    const b = tp[i] as { x: number; z: number };
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    for (const off of [-0.15, 0.15]) line(marks, a.x + nx * off, a.z + nz * off, b.x + nx * off, b.z + nz * off, 0.11);
  }
  const zs = site.access.zSplit;
  asphalt.color('#505358');
  asphalt.polygon(flare({ x: 3.6, z: zs + 4.5 }, { x: 1, z: 0 }, { x: 0, z: 1 }, 15, 14), Y + 0.002);
  asphalt.polygon(flare({ x: 3.6, z: zs - 4.5 }, { x: 1, z: 0 }, { x: 0, z: -1 }, 15, 14), Y + 0.002);

  // —— 收货场：沥青、收货口前的水泥地坪、引擎排的标线和牌子、甩挂车位上停着的空挂车、灯杆 ——
  const yard = site.yard;
  if (yard) {
    const p = yard.plan;
    // 引擎本地 (xk, zk) → 门店本地：x = −xk，z = 收货口那面墙 − zk
    const L = (q: { x: number; z: number }) => ({ x: -q.x, z: EXT.z0 - q.z });
    asphalt.color('#55585c').polygon([L({ x: p.x0, z: 0 }), L({ x: p.x1, z: 0 }), L({ x: p.x1, z: p.z1 }), L({ x: p.x0, z: p.z1 })], Y);
    const xs = p.doors.map((d) => d.x);
    const ax0 = Math.min(...xs) - 9;
    const ax1 = Math.max(...xs) + 9;
    concrete.color('#b4b2ab').polygon([L({ x: ax0, z: 0.01 }), L({ x: ax1, z: 0.01 }), L({ x: ax1, z: p.apronZ }), L({ x: ax0, z: p.apronZ })], Y + 0.004);
    for (const m of p.marks) {
      if (m.kind === 'line') {
        marks.color(m.color === 'yellow' ? YELLOW : WHITE);
        for (let i = 1; i < m.pts.length; i++) {
          const a = L(m.pts[i - 1] as { x: number; z: number });
          const b = L(m.pts[i] as { x: number; z: number });
          if (!m.dashed) line(marks, a.x, a.z, b.x, b.z, m.width);
          else {
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            for (let s = 0; s + 3 <= len; s += 6) line(marks, a.x + ((b.x - a.x) * s) / len, a.z + ((b.z - a.z) * s) / len, a.x + ((b.x - a.x) * (s + 3)) / len, a.z + ((b.z - a.z) * (s + 3)) / len, m.width);
          }
        }
      } else if (m.kind === 'arrow') {
        const q = L(m.at);
        marks.color(WHITE);
        arrow(marks, q.x, q.z, m.heading + Math.PI, 5);
      } else if (m.kind === 'stop') {
        const a = L(m.a);
        const b = L(m.b);
        marks.color(WHITE);
        line(marks, a.x, a.z, b.x, b.z, 0.45);
      } else if (m.kind === 'box') {
        const q = L(m.at);
        const h = m.heading + Math.PI;
        const ca = Math.cos(h);
        const sa = Math.sin(h);
        // 框的四条边（框沿 heading 长 d、横向宽 w）
        const corner = (u: number, v: number) => ({ x: q.x + u * ca + v * sa, z: q.z - u * sa + v * ca });
        const c = [corner(-m.w / 2, -m.d / 2), corner(m.w / 2, -m.d / 2), corner(m.w / 2, m.d / 2), corner(-m.w / 2, m.d / 2)];
        marks.color(WHITE);
        for (let k = 0; k < 4; k++) line(marks, (c[k] as { x: number }).x, (c[k] as { z: number }).z, (c[(k + 1) % 4] as { x: number }).x, (c[(k + 1) % 4] as { z: number }).z, 0.12);
      } else if (m.kind === 'sign') {
        signs.push({ ...L(m.at), heading: m.heading + Math.PI, text: m.text, kind: 'truck' });
      }
    }
    // 甩挂车位上停着一辆空挂车（另一个空着）
    const st = p.stalls[0];
    if (st) {
      const q = L(st);
      const h = st.heading + Math.PI;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      // 挂车车轴组中心 → 车身中心在车头方向 5 米处
      props.color('#e7e9eb').box(q.x + fx * 5.2, Y + 1.15, q.z + fz * 5.2, 2.55, 2.85, 13.6, h);
      props.color('#3a3f45').box(q.x, Y, q.z, 2.2, 1.15, 3.2, h);
      props.color('#7a8087').box(q.x + fx * 10.5, Y, q.z + fz * 10.5, 2.0, 1.15, 0.25, h);
    }
    for (const xk of [p.x0 + 6, (p.x0 + p.x1) / 2, p.x1 - 6]) {
      const q = L({ x: xk, z: p.z1 - 2 });
      pole(q.x, q.z, 12, 2);
    }
  }

  // —— 指示牌：立杆 + 画布文字的牌面（两面），夜里牌面亮 ——
  const signMats: THREE.MeshStandardMaterial[] = [];
  const signGroup = new THREE.Group();
  const signList: Array<{ x: number; z: number; heading: number; text: string; kind: 'pickup' | 'drive' | 'fire' | 'truck' | 'gate' }> = [
    ...lot.signs.map((s) => ({ ...s, kind: s.text.startsWith('免下车') ? ('drive' as const) : s.text.startsWith('消防') ? ('fire' as const) : ('pickup' as const) })),
    ...signs,
    ...lot.gates.map((g, k) => ({ x: g.x + (k === 0 ? -GATE_W / 2 - 1.2 : GATE_W / 2 + 1.2), z: lot.edgeZ + 2.6, heading: 0, text: '入口 · 出口', kind: 'gate' as const })),
    // 进店路上：货车在前面右转进货车通道；顾客的车直走到门前路
    { x: 6.2, z: site.access.zSplit + 10, heading: 0, text: '货车入口 → 收货场', kind: 'truck' as const },
    { x: -6.2, z: lot.frontage.z + lot.frontage.half + 5, heading: 0, text: '顾客停车场 · 即时取货', kind: 'gate' as const },
  ];
  const COLORS = { pickup: ['#d9822b', '#ffffff'], drive: ['#d9822b', '#ffffff'], fire: ['#c0392b', '#ffffff'], truck: ['#1f5fa8', '#ffffff'], gate: ['#1f5fa8', '#ffffff'] } as const;
  for (const sgn of signList) {
    const [bg, fg] = COLORS[sgn.kind];
    const wide = sgn.text.length > 8;
    const pw = wide ? 4.2 : 2.6;
    const ph = wide ? 1.0 : 0.9;
    const tex = textTexture(sgn.text, bg, fg, wide ? 768 : 512, 128, 64);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: tex ?? null, roughness: 0.6, emissive: new THREE.Color('#ffffff'), emissiveMap: tex ?? null, emissiveIntensity: 0 });
    signMats.push(mat);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
    const yTop = sgn.kind === 'fire' ? 1.7 : 2.6;
    panel.position.set(sgn.x, Y + yTop, sgn.z);
    back.position.copy(panel.position);
    // 牌面朝 heading（atan2(dx, dz)）：平面的法线是本地 +z
    panel.rotation.y = sgn.heading;
    back.rotation.y = sgn.heading + Math.PI;
    signGroup.add(panel, back);
    props.color('#7a8087').box(sgn.x, Y, sgn.z, 0.1, yTop - ph / 2 + 0.05, 0.1);
  }
  group.add(signGroup);

  // —— 组装 ——
  const vc = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, ...o });
  const mk = (g: GeoBuilder, mat: THREE.Material, name: string, shadow = false) => {
    const m = new THREE.Mesh(g.build(), mat);
    m.name = name;
    m.receiveShadow = true;
    m.castShadow = shadow;
    return m;
  };
  const asphaltMat = vc({ roughness: 0.93 });
  const concreteMat = vc({ roughness: 0.85 });
  const markMat = vc({ roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  surface.add(mk(asphalt, asphaltMat, 'store-asphalt'), mk(concrete, concreteMat, 'store-concrete'), mk(marks, markMat, 'store-markings'));
  group.add(mk(curbs, vc({ roughness: 0.88 }), 'store-islands', true), mk(props, vc({ roughness: 0.6, metalness: 0.15 }), 'store-props', true));
  const headMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, emissive: new THREE.Color('#ffe6b0'), emissiveIntensity: 0 });
  group.add(mk(heads, headMat, 'store-lamp-heads'));
  if (treeParts.length) {
    const t = new THREE.Mesh(merge(treeParts), vc({ roughness: 0.85 }));
    t.name = 'store-trees';
    t.castShadow = true;
    group.add(t);
  }
  return {
    group,
    surface,
    lamps,
    setNight: (k) => {
      headMat.emissiveIntensity = 1.6 * k;
      for (const m of signMats) m.emissiveIntensity = 0.55 * k;
    },
  };
}
