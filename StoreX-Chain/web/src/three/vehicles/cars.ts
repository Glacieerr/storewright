import * as THREE from 'three';
import { coarseWheel, loft, MeshBuilder, pw, smooth01, stations, type Mat, type QuadInfo, type Section } from './builder';
import { MODEL_SPECS, type ModelKey } from './specs';

/**
 * 乘用车（轿车、两厢车、SUV、MPV、皮卡；第一部分 Storewright 的放样车身）：按常见车型的公开外形尺寸
 * （车长、轴距、前后悬、腰线、风挡倾角、车顶高度）放样出车身；截面固定 13 个点（右半边）：
 *   0 底部中点 · 1 底板边 · 2 轮罩顶 · 3 门槛外沿 · 4 车身最宽处 · 5 上部侧面 · 6 腰线（肩线）
 *   7–9 车窗侧壁（向内倾斜）· 10 车顶边 · 11 车顶中部 · 12 顶部中点
 * 没有座舱的位置（发动机盖、行李箱盖）7–12 点落在腰线高度，成为盖板的弧面。
 * 分类：0–2 段是底盘和轮罩（深色），7–8 段在车窗范围内是侧窗玻璃，10–11 段在风挡 / 后窗范围内是玻璃，
 * 门缝处是一道细细的深色线；SUV 和皮卡的轮拱、门槛有黑色护板。建模坐标：车头朝 +Z，原点在车身中心。
 */

export interface CarSpec {
  L: number;
  W: number;
  axles: number[];
  wheelR: number;
  archR: number;
  yB: number;
  sill: number;
  /** 腰线 / 盖板高度（z, y），从车尾到车头 */
  belt: Array<[number, number]>;
  /** 车头 / 车尾：平面上开始收圆的位置与收圆程度；侧面上盖板前沿向下圆滑地落下 drop 米（在最后 len 米内） */
  nose: { z: number; round: number; drop: number; len?: number };
  tail: { z: number; round: number; drop: number; len?: number };
  /** 座舱：后窗下沿、车顶后沿、车顶前沿、风挡下沿（z 从小到大），车顶高度、车顶半宽、车顶拱高 */
  cabin?: { zr0: number; zr1: number; zf1: number; zf0: number; roof: number; roofHW: number; crown: number; rearCurve?: number };
  windows: Array<[number, number]>;
  seams: number[];
  /** 盖板上的接缝（发动机盖后沿、行李箱盖前沿） */
  topSeams?: number[];
  cladding?: boolean;
  hoodCrown?: number;
  sunroof?: [number, number];
  /** 放样范围（皮卡只放样驾驶室和车头，货箱单独建） */
  zMin?: number;
  zMax?: number;
  bumperLip?: boolean;
}

export function beltAt(s: CarSpec, z: number): number {
  let y = pw(s.belt, z);
  const half = s.L / 2;
  // 圆弧形的前后沿：越靠近端部落得越快
  const nl = s.nose.len ?? 0.2;
  const tl = s.tail.len ?? 0.2;
  const un = Math.min(1, Math.max(0, (z - (half - nl)) / nl));
  const ut = Math.min(1, Math.max(0, (-half + tl - z) / tl));
  y -= s.nose.drop * (1 - Math.sqrt(1 - un * un));
  y -= s.tail.drop * (1 - Math.sqrt(1 - ut * ut));
  return y;
}

export function hwAt(s: CarSpec, z: number): number {
  const half = s.L / 2;
  let hw = s.W / 2;
  if (z > s.nose.z) hw *= 1 - s.nose.round * Math.pow((z - s.nose.z) / (half - s.nose.z), 2.2);
  if (z < s.tail.z) hw *= 1 - s.tail.round * Math.pow((s.tail.z - z) / (s.tail.z + half), 2.2);
  return hw;
}

export function sideBottom(s: CarSpec, z: number): number {
  let y = s.sill;
  for (const az of s.axles) {
    const d = Math.abs(z - az);
    if (d < s.archR) y = Math.max(y, s.wheelR + Math.sqrt(s.archR * s.archR - d * d) * 0.97);
  }
  const half = s.L / 2;
  // 保险杠下沿向两端略微抬起
  y += 0.07 * smooth01((Math.abs(z) - (half - 0.25)) / 0.25);
  return y;
}

/** 座舱顶部高度（没有座舱时为 undefined） */
function cabinTop(s: CarSpec, z: number): number | undefined {
  const c = s.cabin;
  if (!c || z <= c.zr0 || z >= c.zf0) return undefined;
  if (z < c.zr1) {
    const f = (z - c.zr0) / (c.zr1 - c.zr0);
    const y0 = beltAt(s, c.zr0);
    return y0 + (c.roof - y0) * (1 - Math.pow(1 - f, c.rearCurve ?? 1.6));
  }
  if (z <= c.zf1) return c.roof + 0.012 * Math.sin((Math.PI * (z - c.zr1)) / Math.max(0.01, c.zf1 - c.zr1));
  const f = (c.zf0 - z) / (c.zf0 - c.zf1);
  const y0 = beltAt(s, c.zf0);
  return y0 + (c.roof - y0) * (1 - Math.pow(1 - f, 1.45));
}

export function cabinH(s: CarSpec, z: number): number {
  const t = cabinTop(s, z);
  return t === undefined ? 0 : Math.max(0, t - beltAt(s, z));
}

function sectionAt(s: CarSpec, z: number): Section {
  const hw = hwAt(s, z);
  const half = s.L / 2;
  const endK = Math.max(smooth01((z - (half - 0.12)) / 0.12), smooth01((-half + 0.12 - z) / 0.12));
  const yB = s.yB + 0.08 * endK;
  const ySide = sideBottom(s, z);
  const yBelt = beltAt(s, z);
  const hC = cabinH(s, z);
  const roofHW = s.cabin?.roofHW ?? hw * 0.8;
  const crown = (s.hoodCrown ?? 0.035) + ((s.cabin?.crown ?? 0.035) - (s.hoodCrown ?? 0.035)) * smooth01(hC / 0.25);
  const hB = hw * 0.925;
  const hT = Math.min(roofHW, hB);
  const pts: Array<[number, number]> = [
    [0, yB],
    [hw * 0.84, yB],
    [hw * 0.84, ySide],
    [hw * 0.965, ySide],
    [hw, ySide + 0.3 * (yBelt - ySide)],
    [hw * 0.992, ySide + 0.72 * (yBelt - ySide)],
    [hw * 0.95, yBelt],
  ];
  for (const f of [0.1, 0.5, 0.88]) pts.push([hB + (hT - hB) * f, yBelt + f * hC + 0.004 * (1 - f)]);
  pts.push([hT * 0.93, yBelt + hC + crown * 0.4], [hT * 0.52, yBelt + hC + crown * 0.88], [0, yBelt + hC + crown]);
  return { z, pts };
}

function nearArch(s: CarSpec, z: number, extra: number): boolean {
  return s.axles.some((az) => Math.abs(z - az) < s.archR + extra);
}

export function carClassifier(s: CarSpec): (q: QuadInfo) => Mat {
  return (q) => {
    const b = q.band;
    if (b <= 2) return 'trim';
    const hC = cabinH(s, q.zc);
    const seam = (list?: number[]) => !!list?.some((sz) => Math.abs(q.zc - sz) < 0.013);
    if (b >= 3 && b <= 6) {
      if (s.cladding && b === 3) return 'trim';
      if (s.cladding && b === 4 && nearArch(s, q.zc, 0.09)) return 'trim';
      if (s.bumperLip && b === 3 && Math.abs(q.zc) > s.L / 2 - 0.4) return 'trim';
      if (seam(s.seams)) return 'trim';
      return 'paint';
    }
    if (b === 7 || b === 8) {
      if (hC > 0.12 && s.windows.some(([a, c]) => q.zc > a && q.zc < c)) return 'glass';
      if (hC > 0.12 && seam(s.seams)) return 'trim';
      return 'paint';
    }
    if (b === 9) return 'paint';
    // 10–11：车顶 / 风挡 / 后窗 / 盖板
    const c = s.cabin;
    if (c && hC > 0.05) {
      if (q.zc > c.zf1 + 0.02 && q.zc < c.zf0 - 0.035) return 'glass';
      if (q.zc > c.zr0 + 0.035 && q.zc < c.zr1 - 0.02) return 'glass';
      if (s.sunroof && b === 11 && q.zc > s.sunroof[0] && q.zc < s.sunroof[1]) return 'glass';
    }
    if (seam(s.topSeams)) return 'trim';
    return 'paint';
  };
}

/** 放样车身（含车窗、门缝、轮拱） */
export function carBody(b: MeshBuilder, s: CarSpec, caps: { rear?: Mat; front?: Mat } = { rear: 'paint', front: 'paint' }): void {
  const z0 = s.zMin ?? -s.L / 2;
  const z1 = s.zMax ?? s.L / 2;
  const c = s.cabin;
  const keys = [...s.seams, ...(s.topSeams ?? []), ...s.windows.flat(), ...s.axles.flatMap((a) => [a - s.archR, a - s.archR * 0.6, a, a + s.archR * 0.6, a + s.archR]), ...(c ? [c.zr0, c.zr1, c.zf1, c.zf0] : []), ...(s.sunroof ?? [])];
  const zs = stations(z0, z1, 0.15, keys);
  // 两端加密，保险杠的圆角更顺
  for (const e of [z0 + 0.03, z0 + 0.07, z1 - 0.07, z1 - 0.03]) if (!zs.includes(e)) zs.push(e);
  zs.sort((a, bb) => a - bb);
  b.glassY0 = beltAt(s, 0);
  b.glassY1 = c?.roof ?? b.glassY0 + 0.5;
  loft(
    b,
    zs.map((z) => sectionAt(s, z)),
    carClassifier(s),
    caps,
  );
}

/** 车灯、格栅、车牌、后视镜、门把手 */
export function carDetails(b: MeshBuilder, s: CarSpec, opts: { grille?: 'wide' | 'tall' | 'slim'; tail?: 'wide' | 'corner'; mirrors?: boolean; handles?: boolean; plateFront?: boolean; rear?: boolean } = {}): void {
  const half = s.L / 2;
  const zf = s.zMax ?? half;
  const zr = s.zMin ?? -half;
  const hwF = hwAt(s, zf - 0.08);
  const yF = beltAt(s, zf - 0.04);
  const hwR = hwAt(s, zr + 0.08);
  const yR = beltAt(s, zr + 0.04);
  // 前大灯：贴着车头两角的弧面，随车头的弧度向后掠（不凸出车身）
  const surfaceZ = (x: number) => {
    let lo = zf - 0.9;
    let hi = zf;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (hwAt(s, mid) > x) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  for (const sx of [-1, 1]) {
    const xi = hwF - 0.5;
    const xo = hwF - 0.04;
    const zi = Math.min(zf - 0.01, surfaceZ(xi));
    const zo = surfaceZ(xo);
    const len = Math.hypot(xo - xi, zo - zi);
    const th = Math.atan2(-(zo - zi), xo - xi);
    const nx = Math.sin(th);
    const nz = Math.cos(th);
    const cx = (xi + xo) / 2 - nx * 0.045;
    const cz = (zi + zo) / 2 - nz * 0.045;
    b.box('light', len, 0.12, 0.1, sx * cx, yF - 0.1, cz, { r: 0.035, ry: sx * th });
    b.box('chrome', len + 0.02, 0.025, 0.1, sx * cx, yF - 0.17, cz - nz * 0.005, { ry: sx * th });
  }
  // 格栅与下进气口
  const gw = Math.max(0.5, 2 * (hwF - 0.6));
  if (opts.grille === 'tall') b.box('chrome', gw * 0.9, 0.34, 0.06, 0, yF - 0.26, zf + 0.005, { r: 0.03 });
  else b.box('trim', gw, opts.grille === 'slim' ? 0.08 : 0.15, 0.05, 0, yF - 0.13, zf + 0.004, { r: 0.025 });
  b.box('trim', gw * 1.2, 0.12, 0.05, 0, s.sill + 0.12, zf - 0.005, { r: 0.03 });
  // 车牌位置只是一块空白的浅色板（不写字）
  if (opts.plateFront !== false) b.box('plate', 0.44, 0.14, 0.02, 0, s.sill + 0.28, zf + 0.012);
  // 尾灯：车尾两角（贯穿式时中间再加一条细灯带）；皮卡的车尾在货箱上（pickupBed）
  if (opts.rear !== false) {
    for (const sx of [-1, 1]) {
      b.box('tail', opts.tail === 'corner' ? 0.16 : 0.4, opts.tail === 'corner' ? 0.42 : 0.13, 0.08, sx * (hwR - (opts.tail === 'corner' ? 0.1 : 0.24)), opts.tail === 'corner' ? yR - 0.05 + 0.15 : yR - 0.09, zr + 0.02, { r: 0.025 });
    }
    if (opts.tail === 'wide') b.box('tail', 2 * (hwR - 0.45), 0.035, 0.05, 0, yR - 0.08, zr + 0.01);
    b.box('plate', 0.44, 0.14, 0.02, 0, (s.sill + yR) / 2 + 0.06, zr - 0.012);
    b.box('trim', 2 * hwR * 0.85, 0.1, 0.06, 0, s.sill + 0.1, zr + 0.01, { r: 0.03 });
  }
  // 后视镜：风挡下沿附近
  const c = s.cabin;
  if (opts.mirrors !== false && c) {
    const zm = c.zf0 - 0.25;
    const ym = beltAt(s, zm) + 0.1;
    const hw = hwAt(s, zm);
    for (const sx of [-1, 1]) {
      b.box('paint', 0.2, 0.13, 0.1, sx * (hw + 0.08), ym, zm, { r: 0.04 });
      b.box('trim', 0.12, 0.04, 0.05, sx * (hw + 0.01), ym - 0.04, zm + 0.03);
    }
  }
  // 门把手：每扇门后部
  if (opts.handles !== false) {
    const seams = [...s.seams].sort((a, bb) => a - bb);
    for (let i = 1; i < seams.length; i++) {
      const zh = (seams[i] as number) - 0.28;
      if (zh < (seams[i - 1] as number) + 0.3) continue;
      const yh = beltAt(s, zh) - 0.1;
      const hw = hwAt(s, zh);
      for (const sx of [-1, 1]) b.box('chrome', 0.03, 0.035, 0.16, sx * (hw * 0.995), yh, zh, { r: 0.012 });
    }
  }
}

// ---------------- 具体车型 ----------------

/** 中型轿车：长 4.85、宽 1.84、高 1.44、轴距 2.83 米 */
export const SEDAN: CarSpec = {
  L: 4.85,
  W: 1.84,
  axles: [-1.41, 1.42],
  wheelR: 0.33,
  archR: 0.41,
  yB: 0.16,
  sill: 0.29,
  belt: [
    [-2.43, 0.8],
    [-2.25, 0.97],
    [-1.75, 1.01],
    [-1.2, 1.0],
    [0, 0.95],
    [1.15, 0.9],
    [1.75, 0.84],
    [2.25, 0.77],
    [2.43, 0.7],
  ],
  nose: { z: 1.55, round: 0.3, drop: 0.15, len: 0.42 },
  tail: { z: -1.65, round: 0.2, drop: 0.1, len: 0.3 },
  cabin: { zr0: -1.62, zr1: -0.78, zf1: 0.32, zf0: 1.22, roof: 1.44, roofHW: 0.66, crown: 0.035, rearCurve: 1.5 },
  windows: [
    [-1.34, -0.11],
    [0.03, 1.12],
  ],
  seams: [-1.08, -0.04, 1.02],
  topSeams: [1.32, -1.7],
  bumperLip: true,
};

/** 两厢车：长 4.3、宽 1.8、高 1.46、轴距 2.65 米 */
export const HATCH: CarSpec = {
  L: 4.3,
  W: 1.8,
  axles: [-1.37, 1.28],
  wheelR: 0.31,
  archR: 0.38,
  yB: 0.15,
  sill: 0.28,
  belt: [
    [-2.15, 0.84],
    [-2.0, 0.99],
    [-1.4, 1.0],
    [0, 0.96],
    [1.0, 0.9],
    [1.6, 0.83],
    [2.15, 0.72],
  ],
  nose: { z: 1.35, round: 0.3, drop: 0.14, len: 0.38 },
  tail: { z: -1.75, round: 0.16, drop: 0.06, len: 0.2 },
  cabin: { zr0: -2.06, zr1: -1.62, zf1: 0.22, zf0: 1.08, roof: 1.46, roofHW: 0.64, crown: 0.03, rearCurve: 1.1 },
  windows: [
    [-1.78, -0.22],
    [-0.07, 0.96],
  ],
  seams: [-1.3, -0.14, 0.92],
  topSeams: [1.18],
  bumperLip: true,
};

/** 紧凑型 SUV：长 4.62、宽 1.86、高 1.68、轴距 2.69 米 */
export const SUV: CarSpec = {
  L: 4.62,
  W: 1.86,
  axles: [-1.32, 1.37],
  wheelR: 0.36,
  archR: 0.45,
  yB: 0.2,
  sill: 0.4,
  belt: [
    [-2.31, 0.98],
    [-2.16, 1.08],
    [-1.5, 1.11],
    [0, 1.07],
    [1.0, 1.03],
    [1.7, 0.98],
    [2.31, 0.85],
  ],
  nose: { z: 1.55, round: 0.26, drop: 0.14, len: 0.4 },
  tail: { z: -1.85, round: 0.14, drop: 0.06, len: 0.22 },
  cabin: { zr0: -2.2, zr1: -1.95, zf1: 0.18, zf0: 1.16, roof: 1.68, roofHW: 0.73, crown: 0.03, rearCurve: 1.05 },
  windows: [
    [-1.86, -1.16],
    [-1.06, -0.13],
    [0.02, 1.02],
  ],
  seams: [-1.1, -0.07, 1.06],
  topSeams: [1.25],
  cladding: true,
  sunroof: [-0.5, 0.2],
};

/** MPV（七座）：长 4.95、宽 1.85、高 1.75、轴距 3.0 米；长座舱、后部近乎竖直，侧滑门的门缝 */
export const MPV: CarSpec = {
  L: 4.95,
  W: 1.85,
  axles: [-1.575, 1.425],
  wheelR: 0.34,
  archR: 0.42,
  yB: 0.17,
  sill: 0.34,
  belt: [
    [-2.47, 0.94],
    [-2.33, 1.03],
    [-1.5, 1.05],
    [0, 1.0],
    [1.0, 0.96],
    [1.6, 0.92],
    [2.2, 0.84],
    [2.47, 0.74],
  ],
  nose: { z: 1.75, round: 0.28, drop: 0.14, len: 0.4 },
  tail: { z: -1.95, round: 0.14, drop: 0.05, len: 0.2 },
  cabin: { zr0: -2.4, zr1: -2.18, zf1: 0.55, zf0: 1.5, roof: 1.75, roofHW: 0.74, crown: 0.03, rearCurve: 1.05 },
  windows: [
    [-2.12, -1.22],
    [-1.12, 0.02],
    [0.14, 1.38],
  ],
  seams: [-1.17, 0.08, 1.44],
  topSeams: [1.58],
};

/** 全尺寸皮卡（四门、短货箱）：长 5.88、宽 2.03、高 1.95、轴距 3.68 米；放样到驾驶室后沿，货箱单独建 */
export const PICKUP: CarSpec = {
  L: 5.88,
  W: 2.03,
  axles: [-1.65, 2.03],
  wheelR: 0.41,
  archR: 0.52,
  yB: 0.28,
  sill: 0.5,
  belt: [
    [-0.35, 1.24],
    [0.4, 1.23],
    [1.4, 1.2],
    [2.2, 1.17],
    [2.75, 1.1],
    [2.94, 1.02],
  ],
  nose: { z: 2.3, round: 0.12, drop: 0.09, len: 0.26 },
  tail: { z: -0.4, round: 0, drop: 0 },
  cabin: { zr0: -0.34, zr1: -0.27, zf1: 0.82, zf0: 1.55, roof: 1.95, roofHW: 0.82, crown: 0.025, rearCurve: 1.0 },
  windows: [
    [-0.2, 0.62],
    [0.77, 1.46],
  ],
  seams: [-0.24, 0.7, 1.5],
  topSeams: [1.62],
  cladding: true,
  hoodCrown: 0.03,
  zMin: -0.35,
};

/** 皮卡的货箱：箱底、两侧板（带护板顶）、尾门、箱内轮罩 */
export function pickupBed(b: MeshBuilder, s: CarSpec): void {
  const z0 = -s.L / 2;
  const z1 = (s.zMin ?? -0.35) - 0.02;
  const hw = s.W / 2;
  const top = 1.22;
  const floor = 0.82;
  const len = z1 - z0;
  b.box('trim', 2 * hw - 0.16, 0.05, len, 0, floor, (z0 + z1) / 2);
  // 侧板：侧面轮廓（后轮处挖出轮拱）沿车宽拉伸 8 厘米，与车身同色、和驾驶室的腰线齐平
  const az = s.axles[0] as number;
  const side = new THREE.Shape();
  side.moveTo(z0 + 0.05, s.sill + 0.05);
  side.lineTo(az - s.archR, s.sill);
  side.absarc(az, s.wheelR, s.archR, Math.PI - Math.asin((s.sill - s.wheelR) / s.archR), Math.asin((s.sill - s.wheelR) / s.archR), true);
  side.lineTo(z1, s.sill);
  side.lineTo(z1, top);
  side.lineTo(z0 + 0.04, top);
  side.quadraticCurveTo(z0, top, z0, top - 0.05);
  side.lineTo(z0, s.sill + 0.1);
  side.closePath();
  for (const sx of [-1, 1]) {
    b.extrudeZY('paint', side, 0.08, sx > 0 ? hw - 0.09 : -hw + 0.01, { bevel: 0.01, curve: 14 });
    b.box('trim', 0.12, 0.04, len, sx * (hw - 0.06), top + 0.02, (z0 + z1) / 2);
    // 箱内轮罩
    b.box('trim', 0.28, 0.32, 0.9, sx * (hw - 0.22), floor + 0.16, az, { r: 0.08 });
  }
  b.box('paint', 2 * hw - 0.02, top - s.sill - 0.04, 0.08, 0, (top + s.sill) / 2, z0 + 0.04, { r: 0.03 });
  b.box('trim', 0.3, 0.06, 0.02, 0, top - 0.12, z0 - 0.005);
  for (const sx of [-1, 1]) b.box('tail', 0.12, 0.38, 0.06, sx * (hw - 0.07), top - 0.24, z0 + 0.01, { r: 0.02 });
  b.box('chrome', 2 * hw - 0.06, 0.18, 0.16, 0, s.sill + 0.02, z0 - 0.02, { r: 0.04 });
  b.box('plate', 0.44, 0.14, 0.02, 0, s.sill + 0.04, z0 - 0.105);
  // 驾驶室后壁下面的车架与货箱之间的缝
  b.box('trim', 2 * hw - 0.2, 0.42, 0.04, 0, (s.sill + top) / 2, z1 + 0.01);
}

/** SUV 车顶行李架 */
export function roofRails(b: MeshBuilder, s: CarSpec): void {
  const c = s.cabin;
  if (!c) return;
  for (const sx of [-1, 1]) {
    const pts = [c.zr1 + 0.05, (c.zr1 + c.zf1) / 2, c.zf1 - 0.05].map((z) => new THREE.Vector3(sx * c.roofHW * 0.86, c.roof + 0.07, z));
    b.tube('trim', pts, 0.022, 6);
    for (const z of [c.zr1 + 0.08, c.zf1 - 0.08]) b.box('trim', 0.05, 0.07, 0.08, sx * c.roofHW * 0.86, c.roof + 0.035, z);
  }
}

/** 鲨鱼鳍天线 */
export function antenna(b: MeshBuilder, s: CarSpec): void {
  const c = s.cabin;
  if (!c) return;
  b.box('trim', 0.06, 0.06, 0.18, 0, c.roof + 0.05, c.zr1 + 0.12, { r: 0.025 });
}

// ---------------- 简模（远处）----------------

/**
 * 远处的乘用车：侧面轮廓（沿腰线、两头收圆）拉成下车身，座舱是梯形棱柱（深色玻璃）、车顶一块车漆，车灯和车轮合在车身里。
 * 约 300 个三角形，远看轮廓和精模一样。
 */
export function carCoarse(b: MeshBuilder, s: CarSpec, opts: { bedTop?: number } = {}): void {
  b.coarse = true;
  const z0 = -s.L / 2;
  const z1 = s.L / 2;
  // 下车身：侧面轮廓（车底 → 车尾 → 腰线 → 车头 → 车底）
  const sh = new THREE.Shape();
  sh.moveTo(z0 + 0.12, s.yB + 0.08);
  sh.lineTo(z0, s.yB + 0.25);
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const z = z0 + 0.02 + ((z1 - z0 - 0.04) * i) / n;
    sh.lineTo(z, beltAt(s, z));
  }
  sh.lineTo(z1, s.yB + 0.25);
  sh.lineTo(z1 - 0.12, s.yB + 0.08);
  sh.closePath();
  b.extrudeZY('paint', sh, s.W * 0.97, (-s.W * 0.97) / 2);
  const c = s.cabin;
  if (c) {
    const yr = beltAt(s, c.zr0);
    const yf = beltAt(s, c.zf0);
    const cab = new THREE.Shape();
    cab.moveTo(c.zr0, yr - 0.02);
    cab.lineTo(c.zr1, c.roof - 0.03);
    cab.lineTo(c.zf1, c.roof - 0.03);
    cab.lineTo(c.zf0, yf - 0.02);
    cab.closePath();
    const w = (c.roofHW + s.W / 2 * 0.92) * 0.98;
    b.extrudeZY('glass', cab, w, -w / 2);
    b.box('paint', c.roofHW * 2, 0.05, c.zf1 - c.zr1, 0, c.roof - 0.02, (c.zr1 + c.zf1) / 2);
  }
  if (opts.bedTop !== undefined) {
    // 皮卡货箱：两侧板和尾门
    const zb1 = (s.zMin ?? -0.35) - 0.02;
    b.box('paint', s.W * 0.97, opts.bedTop - s.sill, zb1 - z0, 0, (opts.bedTop + s.sill) / 2, (z0 + zb1) / 2);
    b.box('trim', s.W * 0.85, 0.04, zb1 - z0 - 0.2, 0, opts.bedTop + 0.01, (z0 + zb1) / 2);
  }
  // 车灯
  const yF = beltAt(s, z1 - 0.05) - 0.1;
  const yR = beltAt(s, z0 + 0.05) - 0.08;
  for (const sx of [-1, 1]) {
    b.box('light', 0.36, 0.1, 0.06, sx * (s.W / 2 - 0.3), yF, z1 - 0.02);
    b.box('tail', 0.34, 0.1, 0.06, sx * (s.W / 2 - 0.28), opts.bedTop ?? yR, z0 + 0.02);
  }
  for (const az of s.axles) for (const sx of [-1, 1]) coarseWheel(b, sx * (s.W / 2 - 0.13), az, s.wheelR, 0.22);
}

/** 乘用车的建模参数 */
export const CAR_SPECS: Partial<Record<ModelKey, CarSpec>> = { car: SEDAN, hatch: HATCH, suv: SUV, mpv: MPV, pickup: PICKUP };

/** 一辆乘用车的几何体（零件坐标）：精模或简模 */
export function carModel(key: 'car' | 'hatch' | 'suv' | 'mpv' | 'pickup', coarse: boolean): THREE.BufferGeometry {
  const s = CAR_SPECS[key] as CarSpec;
  const b = new MeshBuilder();
  if (coarse) {
    carCoarse(b, s, key === 'pickup' ? { bedTop: 1.22 } : {});
    return b.finish(-s.L / 2);
  }
  switch (key) {
    case 'car':
      carBody(b, s);
      carDetails(b, s, { grille: 'wide', tail: 'wide' });
      antenna(b, s);
      break;
    case 'hatch':
      carBody(b, s);
      carDetails(b, s, { grille: 'slim', tail: 'corner' });
      antenna(b, s);
      break;
    case 'suv':
      carBody(b, s);
      carDetails(b, s, { grille: 'wide', tail: 'wide' });
      roofRails(b, s);
      antenna(b, s);
      break;
    case 'mpv':
      carBody(b, s);
      carDetails(b, s, { grille: 'wide', tail: 'corner' });
      // 侧滑门的滑轨（后窗下方一道细槽）
      for (const sx of [-1, 1]) b.box('trim', 0.02, 0.03, 1.1, sx * (s.W / 2 - 0.035), beltAt(s, -1.2) - 0.06, -1.7);
      antenna(b, s);
      break;
    case 'pickup':
      carBody(b, s, { rear: 'paint', front: 'paint' });
      carDetails(b, s, { grille: 'tall', rear: false });
      pickupBed(b, s);
      // 拖车钩座
      b.box('trim', 0.08, 0.08, 0.32, 0, 0.5, -s.L / 2 - 0.1);
      b.cyl('chrome', 0.035, 0.035, 0.07, 0, 0.58, -s.L / 2 - 0.24, 'y', 8);
      break;
  }
  return b.finish(-s.L / 2);
}

/** 检查用：建模参数和尺寸表一致（车长、车轴） */
export function carSpecMatches(key: 'car' | 'hatch' | 'suv' | 'mpv' | 'pickup'): boolean {
  const s = CAR_SPECS[key] as CarSpec;
  const m = MODEL_SPECS[key];
  return Math.abs(s.L - m.length) < 0.01 && s.axles.every((z) => m.axles.some((a) => Math.abs(a.x - (z + s.L / 2)) < 0.02));
}
