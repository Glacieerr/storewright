import * as THREE from 'three';
import { arches, coarseWheel, inRect, loft, MeshBuilder, pw, roofBand, sideBand, smooth01, stations, tallSection, type Mat, type Rect } from './builder';
import { MODEL_SPECS, type AxleSpec, type ModelKey } from './specs';

/**
 * 大型载具（按公开的常见外形和尺寸，都是通用外形，不写字、不带标志）：
 * 高顶厢式车、平头厢式货车、电动厢式冷藏车、平头牵引车（高顶卧铺 / 日间驾驶室）、长头卧铺牵引车、13.6 米厢式 / 冷藏挂车、
 * 40 / 20 尺集装箱骨架车和集装箱、12 米低地板城市公交、A 型自行式房车、拖挂式房车、船拖车（带快艇）、小型平板拖车、
 * 港口场内拖车、配送中心场内牵引车。车身用圆角矩形截面放样（第一部分 Storewright 的做法）：车窗、门缝、彩条按位置分类出来，
 * 灯、格栅、油箱、排气管、支腿等是单独的部件。每种车还有一个远处用的简模（方块拼的轮廓，车轮合在车身里）。
 *
 * 建模坐标：车头朝 +Z、y 向上；各车型的原点见各函数（车身中心、牵引销、挂钩球头或车尾），finish(zRear) 换成零件坐标。
 */

type Geo = THREE.BufferGeometry;
const COLOR = (c: string) => new THREE.Color(c);

/** 简模里合进车身的车轮（零件坐标的 x 换成建模坐标的 z：z = x + zRear） */
function coarseAxles(b: MeshBuilder, axles: readonly AxleSpec[], zRear: number): void {
  for (const a of axles) for (const sx of [-1, 1]) coarseWheel(b, sx * a.half, a.x + zRear, a.r, a.dual ? 0.26 : 0.3, a.dual);
}

/** 挡泥板（橡胶）：车轴后面一对 */
function mudflaps(b: MeshBuilder, z: number, half: number, y = 0.5, w = 0.55): void {
  for (const sx of [-1, 1]) b.box('rubber', w, 0.6, 0.03, sx * half, y, z);
}

/** 侧面的琥珀色示廓灯 */
function sideMarkers(b: MeshBuilder, z0: number, z1: number, y: number, half: number, step = 3): void {
  for (let z = z0; z <= z1 + 1e-6; z += step) for (const sx of [-1, 1]) b.box('amber', 0.03, 0.06, 0.1, sx * (half + 0.015), y, z);
}

/** 车尾的组合灯（尾灯 / 刹车灯、转向灯、倒车灯）：左右各一组 */
function rearCluster(b: MeshBuilder, z: number, y: number, half: number, w = 0.42): void {
  for (const sx of [-1, 1]) {
    b.box('trim', w + 0.04, 0.2, 0.05, sx * half, y, z + 0.01);
    b.box('tail', w * 0.45, 0.14, 0.05, sx * (half + w * 0.18), y, z - 0.005);
    b.box('amber', w * 0.22, 0.14, 0.05, sx * (half - w * 0.02 + w * 0.36), y, z - 0.006);
    b.box('light', w * 0.22, 0.14, 0.05, sx * (half - w * 0.3), y, z - 0.006);
  }
}

// ---------------- 高顶厢式车（6 米） ----------------

/** 高顶厢式车（货运版）：长 6.0、宽 2.05、高 2.55、轴距 3.7 米；原点在车身中心。stripe：侧面彩条（自有配送车） */
export function van(stripe: string | undefined, coarse: boolean): Geo {
  const b = new MeshBuilder();
  const L = 6.0;
  const half = L / 2;
  const s = MODEL_SPECS.van;
  const axles = s.axles.map((a) => a.x - half).sort((a, c) => a - c);
  if (stripe) b.custom.set('stripe', COLOR(stripe));
  if (coarse) {
    b.coarse = true;
    b.box('paint', 2.05, 2.13, 4.25, 0, 0.42 + 1.065, -half + 2.125);
    b.box('paint', 2.0, 0.9, 1.85, 0, 0.42 + 0.45, 1.25 + 0.92);
    const ws = new THREE.Shape();
    ws.moveTo(1.25, 1.3);
    ws.lineTo(1.25, 2.5);
    ws.lineTo(2.2, 1.3);
    ws.closePath();
    b.extrudeZY('glass', ws, 1.96, -0.98);
    b.box('glass', 2.07, 0.6, 0.75, 0, 1.7, 1.6);
    if (stripe) b.box('stripe', 2.07, 0.17, 4.1, 0, 1.53, -half + 2.1);
    for (const sx of [-1, 1]) {
      b.box('light', 0.36, 0.18, 0.06, sx * 0.72, 1.0, half - 0.02);
      b.box('tail', 0.12, 0.4, 0.05, sx * 0.94, 1.25, -half + 0.01);
    }
    coarseAxles(b, s.axles, -half);
    return b.finish(-half);
  }
  const top = (z: number) =>
    pw(
      [
        [-half, 2.4],
        [-half + 0.12, 2.52],
        [1.05, 2.55],
        [1.3, 2.45],
        [2.2, 1.3],
        [2.45, 1.2],
        [2.9, 1.06],
        [half, 0.92],
      ],
      z,
    );
  const hw = (z: number) => 1.025 * (1 - 0.1 * Math.pow(Math.max(0, z - 2.25) / (half - 2.25), 2)) * (1 - 0.03 * smooth01((-half + 0.15 - z) / 0.15));
  const levels = [0.62, 0.95, 1.36, 1.45, 1.62, 2.12, 2.3];
  const zs = stations(-half, half, 0.12, [...axles.flatMap((a) => [a - 0.46, a, a + 0.46]), 1.1, 1.27, 1.3, 2.01, 2.2, 1.23, 2.07, 0.0, 1.0, -half + 0.05]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.25 + 0.07 * smooth01((Math.abs(z) - half + 0.2) / 0.2), arches(axles, 0.37, 0.46, 0.42, z), top(z), z > 1.25 ? 0.12 : 0.2, 0.03, levels));
  const doorWin: Rect = { z0: 1.27, z1: 2.01, y0: 1.36, y1: 2.12 };
  b.glassY0 = 1.3;
  b.glassY1 = 2.4;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      // 前风挡：车头斜面上两根 A 柱之间
      if (roofBand(q, levels) && q.zc > 1.32 && q.zc < 2.18) return 'glass';
      if (sideBand(q, levels)) {
        if (q.yc < 0.62) return 'trim';
        if (inRect(q, doorWin)) return 'glass';
        if (stripe && q.yc > 1.45 && q.yc < 1.62 && q.zc < 1.15) return 'stripe';
        // 车门缝：前门前后沿；侧滑门在右侧（建模坐标 −X）
        if (q.yc < 2.15 && [1.23, 2.07].some((sz) => Math.abs(q.zc - sz) < 0.013)) return 'trim';
        if (!q.right && q.yc < 2.15 && [0.0, 1.0].some((sz) => Math.abs(q.zc - sz) < 0.013)) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  for (const sx of [-1, 1]) {
    b.box('light', 0.38, 0.2, 0.12, sx * 0.72, 1.0, half - 0.05, { r: 0.04, ry: sx * 0.25 });
    b.box('tail', 0.12, 0.42, 0.06, sx * 0.94, 1.25, -half + 0.01, { r: 0.02 });
    b.box('glass', 0.62, 0.5, 0.02, sx * 0.42, 1.85, -half - 0.005);
    b.box('trim', 0.08, 0.36, 0.2, sx * 1.16, 1.75, 1.97, { r: 0.03 });
    b.box('trim', 0.14, 0.04, 0.04, sx * 1.08, 1.85, 2.03);
  }
  b.box('trim', 0.9, 0.28, 0.05, 0, 0.95, half - 0.01, { r: 0.04 });
  b.box('trim', 2.0, 0.22, 0.2, 0, 0.55, half - 0.04, { r: 0.05 });
  b.box('trim', 2.0, 0.2, 0.16, 0, 0.55, -half + 0.03, { r: 0.05 });
  b.box('trim', 0.02, 1.7, 0.02, 0, 1.4, -half - 0.006);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.82, -half - 0.012);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.62, half + 0.012);
  return b.finish(-half);
}

// ---------------- 平头厢式货车（7.6 米） ----------------

/** 平头（驾驶室在发动机上方）厢式货车：长 7.6、货厢宽 2.3、高 3.4 米；原点在车身中心。驾驶室车漆按实例着色，货厢白色 */
export function boxTruck(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const L = 7.6;
  const half = L / 2;
  const s = MODEL_SPECS.boxTruck;
  const axles = s.axles.map((a) => a.x - half).sort((a, c) => a - c);
  const bz0 = -half;
  const bz1 = 1.85;
  const bw = 2.3;
  if (coarse) {
    b.coarse = true;
    b.box('white', bw, 2.42, bz1 - bz0, 0, 0.95 + 1.21, (bz0 + bz1) / 2);
    b.box('paint', 2.06, 1.8, half - 1.95, 0, 0.62 + 0.9, (1.95 + half) / 2);
    b.box('glass', 1.9, 0.62, 0.1, 0, 1.86, half - 0.02);
    b.box('glass', 2.08, 0.55, 1.0, 0, 1.85, 2.9);
    b.box('trim', 2.1, 0.28, 0.24, 0, 0.62, half - 0.04);
    for (const sx of [-1, 1]) {
      b.box('light', 0.32, 0.18, 0.06, sx * 0.75, 1.0, half);
      b.box('tail', 0.12, 0.3, 0.05, sx * 1.02, 1.25, bz0 - 0.01);
    }
    b.box('trim', 1.1, 0.24, L - 1.4, 0, 0.78, -0.3);
    coarseAxles(b, s.axles, -half);
    return b.finish(-half);
  }
  const z0 = 1.95;
  const top = (z: number) => pw([[z0, 2.42], [3.5, 2.45], [3.72, 2.3], [half, 2.12]], z);
  const hw = (z: number) => 1.03 * (1 - 0.06 * smooth01((z - 3.55) / (half - 3.55)));
  const levels = [0.95, 1.5, 2.25];
  const zs = stations(z0, half, 0.1, [2.25, 2.35, 3.1, 3.4, 3.55, 2.6, 2.7, 2.3, 3.45]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.62, arches(axles, 0.44, 0.52, 0.72, z), top(z), 0.14, 0.02, levels));
  b.glassY0 = 1.5;
  b.glassY1 = 2.4;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      if (sideBand(q, levels)) {
        if (inRect(q, { z0: 2.35, z1: 3.4, y0: 1.5, y1: 2.25 })) return 'glass';
        if ([2.3, 3.45].some((sz) => Math.abs(q.zc - sz) < 0.013) && q.yc < 2.28) return 'trim';
      }
      return 'paint';
    },
    { rear: 'trim', front: 'paint' },
  );
  b.box('glass', 1.78, 0.62, 0.03, 0, 1.86, half + 0.012, { r: 0.04, rx: -0.07 });
  b.box('trim', 1.86, 0.05, 0.05, 0, 2.2, half + 0.0, { r: 0.02 });
  for (const sx of [-1, 1]) {
    b.box('light', 0.32, 0.18, 0.1, sx * 0.75, 1.0, half - 0.02, { r: 0.03 });
    b.box('trim', 0.42, 0.08, 0.36, sx * 0.85, 0.62, 3.0);
    b.box('trim', 0.08, 0.42, 0.24, sx * 1.15, 1.95, 3.55, { r: 0.03 });
  }
  b.box('trim', 1.1, 0.36, 0.05, 0, 1.15, half + 0.002, { r: 0.03 });
  b.box('trim', 2.1, 0.28, 0.24, 0, 0.62, half - 0.04, { r: 0.05 });
  // 货厢：白色，四周铝边、后卷帘门、侧面护栏
  b.box('white', bw, 2.42, bz1 - bz0, 0, 0.95 + 1.21, (bz0 + bz1) / 2, { r: 0.04 });
  for (const y of [0.97, 3.35]) for (const sx of [-1, 1]) b.box('chrome', 0.04, 0.08, bz1 - bz0, sx * (bw / 2 + 0.01), y, (bz0 + bz1) / 2);
  for (const z of [bz0 + 0.03, bz1 - 0.03]) for (const sx of [-1, 1]) b.box('chrome', 0.06, 2.42, 0.06, sx * (bw / 2), 2.16, z);
  for (let k = 0; k < 9; k++) b.box('chrome', bw - 0.12, 0.02, 0.012, 0, 1.15 + k * 0.25, bz0 - 0.008);
  b.box('trim', 0.2, 0.04, 0.03, 0, 1.2, bz0 - 0.02);
  for (const sx of [-1, 1]) {
    b.box('tail', 0.12, 0.3, 0.05, sx * 1.02, 1.25, bz0 - 0.01, { r: 0.02 });
    for (let k = 0; k < 4; k++) b.box('amber', 0.04, 0.06, 0.08, sx * (bw / 2 + 0.02), 1.0, bz1 - 0.4 - k * 1.6);
    b.box('chrome', 0.04, 0.06, 2.6, sx * 1.0, 0.65, -0.2);
    b.box('chrome', 0.04, 0.06, 2.6, sx * 1.0, 0.42, -0.2);
  }
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.24, L - 1.4, sx * 0.48, 0.78, -0.3);
  b.cyl('chrome', 0.28, 0.28, 0.9, -0.82, 0.68, 0.7, 'z', 14);
  mudflaps(b, -2.25, 0.85, 0.42, 0.5);
  b.box('trim', bw - 0.1, 0.12, 0.3, 0, 0.62, bz0 - 0.12);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.82, bz0 - 0.015);
  return b.finish(-half);
}

// ---------------- 平头驾驶室（牵引车、电动厢式车共用） ----------------

/**
 * 平头驾驶室：zb（驾驶室后壁）→ zf（车头），roof 车顶高；放样的驾驶室壳（侧窗、门缝），正面风挡、格栅、保险杠、大灯、踏步、后视镜、遮阳檐。
 * accent：腰线以下一道彩色饰条（电动车的绿色）。
 */
function cabOver(b: MeshBuilder, zb: number, zf: number, roof: number, opts: { width?: number; floor?: number; accent?: string; sleeper?: boolean } = {}): void {
  const W = opts.width ?? 2.48;
  const floor = opts.floor ?? 1.12;
  const hwMax = W / 2;
  const highRoof = roof > 3.4;
  // 车顶：高顶卧铺的前沿有导流的圆弧，日间驾驶室是平顶
  const top = (z: number) =>
    highRoof
      ? pw(
          [
            [zb, roof - 0.05],
            [zb + 0.15, roof],
            [zf - 0.55, roof],
            [zf - 0.3, roof - 0.25],
            [zf - 0.12, 2.95],
            [zf, 2.8],
          ],
          z,
        )
      : pw(
          [
            [zb, roof - 0.04],
            [zb + 0.12, roof],
            [zf - 0.3, roof],
            [zf - 0.08, roof - 0.15],
            [zf, roof - 0.32],
          ],
          z,
        );
  const hw = (z: number) => hwMax * (1 - 0.035 * smooth01((z - (zf - 0.25)) / 0.25)) * (1 - 0.02 * smooth01((zb + 0.1 - z) / 0.1));
  const winY0 = 1.85;
  const winY1 = 2.72;
  const levels = opts.accent ? [floor + 0.2, floor + 0.32, winY0, winY1, 2.95] : [floor + 0.25, winY0, winY1, 2.95];
  const doorZ0 = zf - 1.05;
  const keys = [zb + 0.05, doorZ0, doorZ0 + 0.06, zf - 0.08, zf - 0.04, zf - 0.3, zf - 0.55, zb + 0.75, zb + 1.05];
  const zs = stations(zb, zf, 0.1, keys, 0.012, b.coarse);
  b.glassY0 = winY0;
  b.glassY1 = roof;
  loft(
    b,
    zs.map((z) => tallSection(z, hw(z), floor - 0.04, floor, top(z), highRoof ? 0.24 : 0.16, 0.03, levels)),
    (q) => {
      if (q.band <= 2) return 'trim';
      if (sideBand(q, levels)) {
        if (q.yc < floor + 0.25 && !opts.accent) return 'paint';
        if (opts.accent && q.yc > floor + 0.2 && q.yc < floor + 0.32) return 'stripe';
        // 车门窗（门的上半）；高顶卧铺在门后面还有一扇小窗
        if (inRect(q, { z0: doorZ0 + 0.08, z1: zf - 0.12, y0: winY0, y1: winY1 })) return 'glass';
        if (opts.sleeper && inRect(q, { z0: zb + 0.75, z1: zb + 1.05, y0: winY0 + 0.15, y1: winY1 - 0.15 })) return 'glass';
        if (q.yc < winY1 + 0.04 && [doorZ0, zf - 0.06].some((s) => Math.abs(q.zc - s) < 0.014)) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  if (opts.accent) b.custom.set('stripe', COLOR(opts.accent));
  // 正面：两片式风挡（略后仰）、中间立柱、雨刮、遮阳檐
  b.box('glass', W - 0.3, winY1 - winY0 + 0.05, 0.03, 0, (winY0 + winY1) / 2, zf + 0.01, { r: 0.03, rx: -0.06 });
  b.box('trim', 0.05, winY1 - winY0, 0.04, 0, (winY0 + winY1) / 2, zf + 0.02);
  for (const sx of [-1, 1]) b.box('trim', 0.7, 0.025, 0.03, sx * 0.4, winY0 + 0.04, zf + 0.03, { rz: sx * 0.15 });
  b.box('paint', W - 0.1, 0.06, 0.28, 0, winY1 + 0.12, zf + 0.06, { r: 0.02 });
  // 格栅、保险杠、大灯、雾灯、踏步
  b.box('trim', W - 0.8, 0.62, 0.05, 0, floor + 0.15, zf + 0.012, { r: 0.03 });
  for (let k = 0; k < 6; k++) b.box('chrome', W - 0.9, 0.025, 0.02, 0, floor - 0.08 + k * 0.1, zf + 0.04);
  b.box('trim', W + 0.02, 0.36, 0.26, 0, 0.62, zf - 0.04, { r: 0.05 });
  for (const sx of [-1, 1]) {
    b.box('light', 0.36, 0.2, 0.08, sx * (hwMax - 0.42), 0.98, zf + 0.02, { r: 0.03 });
    b.box('amber', 0.16, 0.12, 0.06, sx * (hwMax - 0.14), 1.28, zf - 0.02, { r: 0.02 });
    b.box('light', 0.16, 0.1, 0.06, sx * (hwMax - 0.35), 0.62, zf + 0.1);
    // 踏步（两级）、扶手
    for (const y of [0.55, 0.9]) b.box('trim', 0.3, 0.05, 0.42, sx * (hwMax - 0.05), y, doorZ0 + 0.55);
    b.box('chrome', 0.03, 0.9, 0.03, sx * (hwMax + 0.01), 1.6, doorZ0 + 0.1);
    // 大后视镜（支臂 + 镜子 + 下面的广角镜）
    b.box('trim', 0.4, 0.04, 0.04, sx * (hwMax + 0.18), 2.35, zf - 0.22);
    b.box('trim', 0.1, 0.5, 0.22, sx * (hwMax + 0.38), 2.3, zf - 0.22, { r: 0.03 });
    b.box('trim', 0.1, 0.2, 0.18, sx * (hwMax + 0.36), 1.9, zf - 0.18, { r: 0.03 });
  }
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.62, zf + 0.1);
  // 车顶示廓灯
  for (let k = -2; k <= 2; k++) b.box('amber', 0.08, 0.05, 0.05, k * 0.32, (highRoof ? roof - 0.02 : roof) + 0.02, zf - (highRoof ? 0.5 : 0.25));
}

// ---------------- 电动厢式冷藏车（11 米） ----------------

/** 电动厢式冷藏车（单体，长 11 米）：平头驾驶室、冷藏厢（前壁上的冷机）、底盘两侧的电池包；原点在车尾 */
export function evTruck(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.evTruck;
  const green = '#1baf7a';
  b.custom.set('stripe', COLOR(green));
  const bz0 = 0.05;
  const bz1 = 8.5;
  const bw = 2.5;
  const y0 = 1.1;
  const y1 = 3.86;
  if (coarse) {
    b.coarse = true;
    b.box('white', bw, y1 - y0, bz1 - bz0, 0, (y0 + y1) / 2, (bz0 + bz1) / 2);
    b.box('stripe', bw + 0.02, 0.36, bz1 - bz0 - 0.4, 0, 2.38, (bz0 + bz1) / 2);
    b.box('paint', 2.45, 1.88, 2.3, 0, 1.1 + 0.94, 9.85);
    b.box('glass', 2.2, 0.85, 0.1, 0, 2.28, 10.98);
    b.box('glass', 2.47, 0.8, 1.0, 0, 2.28, 10.3);
    b.box('stripe', 2.47, 0.12, 2.32, 0, 1.38, 9.85);
    b.box('white', 1.7, 0.75, 0.5, 0, 3.4, 8.75);
    b.box('navy', 2.0, 0.6, 3.6, 0, 0.65, 6.2);
    for (const sx of [-1, 1]) {
      b.box('light', 0.36, 0.2, 0.06, sx * 0.82, 0.92, 11.0);
      b.box('tail', 0.12, 0.3, 0.05, sx * 1.05, 1.12, bz0 - 0.01);
    }
    b.box('trim', 1.0, 0.28, 10.4, 0, 0.82, 5.4);
    coarseAxles(b, s.axles, 0);
    return b.finish(0);
  }
  // 驾驶室：8.75 → 11.0
  cabOver(b, 8.75, 11.0, 3.02, { width: 2.45, floor: 1.1, accent: green });
  // 冷藏厢：白色、四周铝边，侧面绿色彩条，后门两扇、锁杆、铰链
  b.box('white', bw, y1 - y0, bz1 - bz0, 0, (y0 + y1) / 2, (bz0 + bz1) / 2, { r: 0.05 });
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.04, 0.1, bz1 - bz0, sx * (bw / 2 + 0.005), y0 + 0.05, (bz0 + bz1) / 2);
    b.box('chrome', 0.04, 0.08, bz1 - bz0, sx * (bw / 2 + 0.005), y1 - 0.04, (bz0 + bz1) / 2);
    b.box('stripe', 0.02, 0.34, bz1 - bz0 - 0.5, sx * (bw / 2 + 0.008), 2.38, (bz0 + bz1) / 2);
    b.box('stripe', 0.02, 0.06, bz1 - bz0 - 0.5, sx * (bw / 2 + 0.008), 2.66, (bz0 + bz1) / 2);
    sideMarkers(b, bz0 + 0.6, bz1 - 0.6, y0 + 0.2, bw / 2, 2.5);
    // 电池包：两轴之间，深蓝灰外壳、前沿一道浅色
    b.box('navy', 0.5, 0.62, 3.6, sx * 0.98, 0.66, 6.2, { r: 0.05 });
    b.box('alu', 0.52, 0.06, 3.6, sx * 0.98, 0.99, 6.2);
    // 侧防护栏（后轮前面）
    for (const y of [0.45, 0.75]) b.box('chrome', 0.04, 0.06, 2.2, sx * 1.12, y, 2.1);
  }
  b.box('chrome', bw + 0.02, 0.12, 0.08, 0, y1 - 0.06, bz0 - 0.02);
  b.box('chrome', bw + 0.02, 0.12, 0.08, 0, y0 + 0.06, bz0 - 0.02);
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.1, y1 - y0, 0.08, sx * (bw / 2 - 0.05), (y0 + y1) / 2, bz0 - 0.02);
    for (const xx of [0.3, 0.9]) b.box('chrome', 0.035, y1 - y0 - 0.3, 0.035, sx * xx, (y0 + y1) / 2, bz0 - 0.05);
    for (const yy of [y0 + 0.5, (y0 + y1) / 2, y1 - 0.5]) b.box('trim', 0.18, 0.08, 0.04, sx * (bw / 2 - 0.12), yy, bz0 - 0.05);
  }
  b.box('trim', 0.02, y1 - y0 - 0.25, 0.02, 0, (y0 + y1) / 2, bz0 - 0.035);
  rearCluster(b, bz0 - 0.04, 0.85, 0.85, 0.4);
  b.box('trim', bw - 0.2, 0.14, 0.14, 0, 0.55, bz0 + 0.2);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.62, bz0 + 0.12);
  // 冷机：厢体前壁上方（驾驶室顶上）
  b.box('white', 1.8, 0.78, 0.48, 0, 3.4, bz1 + 0.24, { r: 0.06 });
  b.box('trim', 1.4, 0.5, 0.03, 0, 3.4, bz1 + 0.49);
  for (let k = 0; k < 5; k++) b.box('trim', 1.35, 0.02, 0.02, 0, 3.2 + k * 0.1, bz1 + 0.51);
  // 车架、挡泥板
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.26, 10.4, sx * 0.46, 0.85, 5.4);
  mudflaps(b, s.axles[1]!.x - 0.75, 0.92);
  return b.finish(0);
}

// ---------------- 平头牵引车（6 米） ----------------

/**
 * 平头牵引车：原点在鞍座中心（牵引销），车头在前 4.4 米、车尾在后 1.6 米。sleeper = 高顶卧铺（6×4，长途），否则日间驾驶室（4×2，区域、集卡）。
 * 驾驶室车漆按实例着色；车架、鞍座、油箱、储气筒、电瓶箱、挡泥板、竖直排气管。
 */
export function tractorCabover(sleeper: boolean, coarse: boolean): Geo {
  const b = new MeshBuilder();
  const key: ModelKey = sleeper ? 'tractor' : 'tractorDay';
  const s = MODEL_SPECS[key];
  const kp = s.kingpin as number;
  const zf = s.length - kp;
  const zr = -kp;
  const roof = sleeper ? 3.88 : 3.02;
  const zb = sleeper ? zf - 2.25 : zf - 1.75;
  const drives = s.axles.filter((a) => !a.steer).map((a) => a.x - kp);
  if (coarse) {
    b.coarse = true;
    b.box('paint', 2.48, roof - 1.12, zf - zb, 0, 1.12 + (roof - 1.12) / 2, (zb + zf) / 2);
    b.box('glass', 2.2, 0.85, 0.1, 0, 2.28, zf - 0.03);
    b.box('glass', 2.5, 0.75, 0.9, 0, 2.3, zf - 0.6);
    b.box('trim', 2.5, 0.36, 0.26, 0, 0.62, zf - 0.04);
    b.box('trim', 1.0, 0.3, zf - zr - 0.2, 0, 0.95, (zf + zr) / 2);
    b.box('trim', 1.6, 0.12, 1.2, 0, 1.25, 0);
    b.box('alu', 0.62, 0.55, 1.1, -0.95, 0.75, zb - 0.7);
    for (const sx of [-1, 1]) b.box('light', 0.36, 0.2, 0.06, sx * 0.82, 0.98, zf + 0.01);
    coarseAxles(b, s.axles, zr);
    return b.finish(zr);
  }
  cabOver(b, zb, zf, roof, { sleeper });
  // 车架（两根大梁）、鞍座（带开口的圆盘）、后横梁与尾灯
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.28, zf - zr - 0.3, sx * 0.45, 0.95, (zf - 0.3 + zr) / 2);
  b.box('trim', 1.7, 0.1, 1.25, 0, 1.2, 0);
  b.cyl('dark', 0.62, 0.62, 0.08, 0, 1.3, 0, 'y', 18);
  b.box('trim', 0.25, 0.09, 0.62, 0, 1.31, -0.42);
  b.box('trim', 2.2, 0.14, 0.12, 0, 0.82, zr + 0.06);
  for (const sx of [-1, 1]) {
    b.box('tail', 0.22, 0.12, 0.05, sx * 0.95, 0.92, zr + 0.0);
    b.box('amber', 0.1, 0.12, 0.05, sx * 1.12, 0.92, zr - 0.002);
  }
  // 油箱（铝合金，右侧）、储气筒和电瓶箱（左侧）
  b.cyl('alu', 0.32, 0.32, sleeper ? 1.2 : 0.9, -1.0, 0.75, zb - 0.75, 'z', 16);
  for (const z of sleeper ? [zb - 1.33, zb - 0.17] : [zb - 1.18, zb - 0.32]) b.cyl('trim', 0.325, 0.325, 0.05, -1.0, 0.75, z, 'z', 16);
  b.box('trim', 0.55, 0.5, 0.6, 1.0, 0.72, zb - 0.6, { r: 0.03 });
  b.cyl('chrome', 0.13, 0.13, 0.9, 0.95, 0.62, zb - 1.35, 'z', 10);
  // 驾驶室后面：竖直排气管（右后角）、进气筒、气管和电线（盘在驾驶室后壁上）
  b.cyl('chrome', 0.08, 0.08, roof - 1.1, -1.05, (roof + 1.1) / 2, zb - 0.12, 'y', 10);
  b.cyl('trim', 0.18, 0.18, 1.2, 1.0, 1.9, zb - 0.15, 'y', 12);
  for (const [i, c] of (['#2f6fb5', '#c8262b', '#1f2124'] as const).entries()) b.tube('trim', [new THREE.Vector3(-0.3 + i * 0.15, 2.0, zb - 0.06), new THREE.Vector3(-0.25 + i * 0.15, 1.6, zb - 0.35), new THREE.Vector3(-0.2 + i * 0.12, 1.45, -0.4)], 0.018, 5, COLOR(c));
  // 驱动轴上的挡泥板（半圆弧）和后挡泥板
  for (const sx of [-1, 1]) {
    const zc = drives.reduce((a, z) => a + z, 0) / drives.length;
    const span = Math.max(...drives) - Math.min(...drives) + 1.3;
    b.box('trim', 0.62, 0.05, span, sx * 0.9, 1.15, zc, { r: 0.02 });
    b.box('rubber', 0.6, 0.55, 0.03, sx * 0.9, 0.55, Math.min(...drives) - 0.62);
  }
  return b.finish(zr);
}

// ---------------- 长头卧铺牵引车（7.0 米） ----------------

/**
 * 长头带卧铺的牵引车（第一部分 Storewright 的车型，按长头铰接列车 18.1 米的长度限值缩短了卧铺）：保险杠、高格栅、
 * 斜置的发动机盖与翼子板、驾驶室（两扇门、两片式风挡）、紧凑的高顶卧铺、侧裙板、铝合金油箱、竖直排气管、进气筒、大后视镜、鞍座。
 * 原点在鞍座中心，车头在前 5.7 米、车尾在后 1.3 米；驾驶室后壁离牵引销 1.55 米（挂车前角转弯时扫过的圆在它外面），
 * 油箱、排气管、进气筒都在 2.5 米车宽以内。
 */
export function tractorLong(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.tractorLong;
  const kp = s.kingpin as number;
  const front = s.length - kp;
  const steer = (s.axles.find((a) => a.steer) as AxleSpec).x - kp;
  const C0 = 1.55;
  const C1 = 3.95;
  const H0 = 3.9;
  const H1 = front - 0.15;
  if (coarse) {
    b.coarse = true;
    b.box('paint', 1.45, 0.7, H1 - H0, 0, 1.15 + 0.35, (H0 + H1) / 2);
    b.box('chrome', 1.2, 0.86, 0.1, 0, 1.5, front - 0.13);
    b.box('paint', 2.48, 2.7, C1 - C0, 0, 1.15 + 1.35, (C0 + C1) / 2);
    b.box('glass', 2.2, 0.8, 0.12, 0, 2.55, C1 - 0.08);
    b.box('glass', 2.5, 0.75, 0.55, 0, 2.5, C1 - 0.55);
    b.box('chrome', 2.5, 0.34, 0.3, 0, 0.72, front - 0.05);
    b.box('trim', 1.0, 0.28, 5.5, 0, 0.95, 1.75);
    b.box('trim', 1.6, 0.12, 1.2, 0, 1.25, 0);
    for (const sx of [-1, 1]) b.box('alu', 0.66, 0.66, 0.95, sx * 0.92, 0.82, 2.65);
    coarseAxles(b, s.axles, -kp);
    return b.finish(-kp);
  }
  // 发动机盖：较窄（1.45 米），前端低
  const hoodTop = (z: number) => pw([[H0, 1.98], [4.63, 1.85], [5.24, 1.68], [H1, 1.52]], z);
  const hoodHW = (z: number) => 0.74 * (1 - 0.12 * smooth01((z - 5.0) / 0.55));
  loft(
    b,
    stations(H0, H1, 0.1, [H0 + 0.1]).map((z) => tallSection(z, hoodHW(z), 1.05, 1.08, hoodTop(z), 0.22, 0.04, [1.3, 1.6])),
    (q) => (q.yc < 1.1 ? 'trim' : 'paint'),
    { front: 'chrome' },
  );
  // 翼子板：罩住转向轮的半圆弧，随发动机盖延伸
  for (const sx of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, 0.68, 0, Math.PI, false);
    shape.lineTo(-0.58, 0);
    shape.absarc(0, 0, 0.58, Math.PI, 0, true);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2, curveSegments: 12 });
    g.rotateY(Math.PI / 2);
    g.translate(sx * 0.99 - 0.25, 0.55, steer);
    b.part(g, 'paint');
    b.box('paint', 0.5, 0.06, 1.65, sx * 0.99, 1.24, 4.63, { r: 0.02 });
  }
  // 驾驶室 + 紧凑卧铺：C0 → C1；驾驶室顶 3.1，卧铺带导流罩到 3.85
  const cabTop = (z: number) => pw([[C0, 3.75], [1.92, 3.85], [2.65, 3.75], [2.95, 3.25], [3.15, 3.12], [3.72, 3.06], [C1, 2.05]], z);
  const cabHW = (z: number) => 1.24 * (1 - 0.05 * smooth01((z - 3.6) / 0.35));
  const levels = [1.4, 2.12, 2.4, 2.75, 2.95, 3.3, 3.62];
  const czs = stations(C0, C1, 0.1, [2.9, 3.15, 3.3, 3.65, 3.68, 3.7, 1.9, 2.0, 2.25, 2.65]);
  b.glassY0 = 2.0;
  b.glassY1 = 3.05;
  loft(
    b,
    czs.map((z) => tallSection(z, cabHW(z), 1.12, 1.15, cabTop(z), z < 2.85 ? 0.3 : 0.18, 0.03, levels)),
    (q) => {
      if (q.band <= 2) return 'trim';
      // 两片式风挡：车头上部向后倾斜的面，中间一根立柱
      if (roofBand(q, levels) && q.zc > 3.7 && q.zc < 3.94 && q.yc > 2.1 && q.yc < 3.02 && Math.abs(q.xc) > 0.035) return 'glass';
      if (sideBand(q, levels)) {
        if (inRect(q, { z0: 3.15, z1: 3.65, y0: 2.12, y1: 2.95 })) return 'glass';
        if (inRect(q, { z0: 1.9, z1: 2.25, y0: 2.4, y1: 2.75 })) return 'glass';
        if (q.yc < 2.98 && [2.9, 3.68].some((sz) => Math.abs(q.zc - sz) < 0.013)) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint' },
  );
  // 遮阳檐、车顶示廓灯
  b.box('paint', 2.3, 0.08, 0.3, 0, 3.08, 3.87, { r: 0.03 });
  for (let k = -2; k <= 2; k++) b.box('amber', 0.1, 0.06, 0.06, k * 0.38, 3.14, 3.98);
  // 格栅、保险杠、大灯
  b.box('chrome', 1.2, 0.86, 0.08, 0, 1.08 + 0.43, front - 0.13, { r: 0.04 });
  for (let k = 0; k < 9; k++) b.box('trim', 1.05, 0.03, 0.02, 0, 1.18 + k * 0.08, front - 0.085);
  b.box('chrome', 2.5, 0.34, 0.3, 0, 0.72, front - 0.05, { r: 0.06 });
  for (const sx of [-1, 1]) {
    b.box('light', 0.42, 0.2, 0.3, sx * 0.93, 1.32, front - 0.55, { r: 0.05, ry: sx * 0.35 });
    // 进气筒（发动机盖两侧、驾驶室前面）、后视镜
    b.cyl('chrome', 0.17, 0.17, 1.0, sx * 1.0, 2.05, 4.08, 'y', 14);
    b.box('chrome', 0.06, 0.06, 0.5, sx * 1.42, 2.55, 3.47, { ry: sx * 0.3 });
    b.box('trim', 0.12, 0.62, 0.2, sx * 1.62, 2.55, 3.35, { r: 0.03 });
    // 油箱（铝合金）、踏步、侧裙板
    b.cyl('alu', 0.33, 0.33, 0.95, sx * 0.92, 0.82, 2.65, 'z', 18);
    for (const zz of [2.175, 3.125]) b.cyl('trim', 0.335, 0.335, 0.06, sx * 0.92, 0.82, zz, 'z', 18);
    b.box('trim', 0.42, 0.06, 0.4, sx * 0.95, 0.5, 3.4);
    b.box('paint', 0.06, 0.72, 0.9, sx * 1.2, 0.86, 1.67, { r: 0.03 });
    // 竖直排气管（驾驶室两个后角，挂车前角转弯扫不到）
    b.cyl('chrome', 0.1, 0.1, 2.5, sx * 1.12, 2.55, 1.42, 'y', 12);
    b.cyl('chrome', 0.13, 0.13, 0.85, sx * 1.12, 2.25, 1.42, 'y', 12);
    b.box('rubber', 0.6, 0.6, 0.03, sx * 0.92, 0.5, -1.25);
  }
  // 车架、鞍座、后横梁、尾灯
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.28, 5.5, sx * 0.45, 0.95, 1.75);
  b.box('trim', 1.8, 0.12, 1.3, 0, 1.25, 0);
  b.cyl('dark', 0.62, 0.62, 0.08, 0, 1.33, 0, 'y', 18);
  b.box('trim', 2.3, 0.12, 0.12, 0, 0.82, -1.25);
  for (const sx of [-1, 1]) b.box('tail', 0.22, 0.12, 0.05, sx * 0.95, 0.92, -1.3);
  return b.finish(-kp);
}

// ---------------- 13.6 米厢式 / 冷藏挂车 ----------------

/**
 * 13.6 米三轴挂车：原点在牵引销，前端在前 1.2 米、车尾在后 12.4 米。车厢（车漆按实例着色，平常是白色）、上下铝边、立柱（冷藏厢没有）、
 * 侧防护栏、支腿、后门框与锁杆、防钻撞横梁、组合尾灯与侧示廓灯；冷藏挂车前壁上有冷机、底下有冷机的油箱。stripe：自有车队的彩条。
 */
export function trailer136(reefer: boolean, stripe: string | undefined, coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.trailerPlain;
  const kp = s.kingpin as number;
  const zf = s.length - kp;
  const zr = -kp;
  const len = zf - zr;
  const W = 2.55;
  const y0 = 1.25;
  const y1 = 4.0;
  if (stripe) b.custom.set('stripe', COLOR(stripe));
  if (coarse) {
    b.coarse = true;
    b.box('paint', W, y1 - y0, len, 0, (y0 + y1) / 2, (zf + zr) / 2);
    if (stripe) b.box('stripe', W + 0.02, 0.38, len - 0.8, 0, 2.7, (zf + zr) / 2);
    b.box('trim', 1.2, 0.3, len - 0.4, 0, y0 - 0.15, (zf + zr) / 2);
    if (reefer) b.box('white', 2.0, 1.5, 0.55, 0, 3.15, zf + 0.27);
    for (const sx of [-1, 1]) b.box('tail', 0.3, 0.14, 0.05, sx * 1.0, 1.02, zr - 0.01);
    coarseAxles(b, s.axles, zr);
    return b.finish(zr);
  }
  b.box('paint', W, y1 - y0, len, 0, (y0 + y1) / 2, (zf + zr) / 2, { r: 0.05 });
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.04, 0.12, len, sx * (W / 2 + 0.005), y0 + 0.06, (zf + zr) / 2);
    b.box('chrome', 0.04, 0.1, len, sx * (W / 2 + 0.005), y1 - 0.05, (zf + zr) / 2);
    if (!reefer) for (let z = zr + 1.2; z < zf - 0.4; z += 1.2) b.box('chrome', 0.03, y1 - y0 - 0.2, 0.06, sx * (W / 2 + 0.01), (y0 + y1) / 2, z);
    if (stripe) {
      b.box('stripe', 0.02, 0.38, len - 0.8, sx * (W / 2 + 0.014), 2.7, (zf + zr) / 2);
      b.box('stripe', 0.02, 0.08, len - 0.8, sx * (W / 2 + 0.014), 3.02, (zf + zr) / 2);
    }
    sideMarkers(b, zr + 0.5, zf - 0.3, y0 + 0.2, W / 2, 3.0);
    // 侧防护栏（两轴之间到支腿后面）
    for (const y of [0.55, 0.85]) b.box('alu', 0.04, 0.08, 5.2, sx * (W / 2 - 0.06), y, -4.6);
    for (const z of [-7.1, -4.6, -2.1]) b.box('trim', 0.04, 0.5, 0.06, sx * (W / 2 - 0.07), 0.8, z);
  }
  // 后门框、两扇门、锁杆、铰链
  b.box('chrome', W + 0.02, 0.14, 0.08, 0, y1 - 0.07, zr - 0.02);
  b.box('chrome', W + 0.02, 0.14, 0.08, 0, y0 + 0.07, zr - 0.02);
  for (const sx of [-1, 1]) b.box('chrome', 0.1, y1 - y0, 0.08, sx * (W / 2 - 0.05), (y0 + y1) / 2, zr - 0.02);
  b.box('trim', 0.02, y1 - y0 - 0.28, 0.02, 0, (y0 + y1) / 2, zr - 0.035);
  for (const sx of [-1, 1]) {
    for (const xx of [0.32, 0.92]) b.box('chrome', 0.035, y1 - y0 - 0.3, 0.035, sx * xx, (y0 + y1) / 2, zr - 0.05);
    for (const yy of [y0 + 0.5, (y0 + y1) / 2, y1 - 0.5]) b.box('trim', 0.18, 0.08, 0.04, sx * (W / 2 - 0.12), yy, zr - 0.05);
  }
  // 组合尾灯（防钻撞横梁两头）、横梁、挡泥板
  b.box('trim', W - 0.2, 0.14, 0.14, 0, 0.55, zr + 0.25);
  for (const sx of [-1, 1]) b.box('trim', 0.1, 0.62, 0.1, sx * 1.0, 0.85, zr + 0.3);
  rearCluster(b, zr - 0.02, 1.02, 0.86, 0.46);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.78, zr + 0.16);
  mudflaps(b, zr + 1.0, 0.9);
  // 车架、支腿（带底座）、摇把
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.25, len - 0.4, sx * 0.5, y0 - 0.12, (zf + zr) / 2);
  for (const sx of [-1, 1]) {
    b.box('trim', 0.14, 0.95, 0.14, sx * 0.85, y0 - 0.5, -1.6);
    b.box('trim', 0.32, 0.06, 0.32, sx * 0.85, 0.06, -1.6);
  }
  b.box('chrome', 0.04, 0.04, 0.4, 0.98, 0.92, -1.75);
  // 牵引销座板
  b.box('trim', 1.6, 0.06, 1.4, 0, y0 - 0.03, 0.3);
  if (reefer) {
    b.box('white', 2.0, 1.5, 0.55, 0, 3.15, zf + 0.275, { r: 0.08 });
    b.box('trim', 1.5, 0.95, 0.03, 0, 3.15, zf + 0.56);
    for (let k = 0; k < 6; k++) b.box('trim', 1.45, 0.025, 0.02, 0, 2.75 + k * 0.15, zf + 0.58);
    b.box('chrome', 0.5, 0.36, 0.8, -0.9, 0.95, -4.0, { r: 0.04 });
  } else {
    b.box('chrome', W - 0.1, 0.06, 0.04, 0, 2.6, zf + 0.02);
  }
  return b.finish(zr);
}

// ---------------- 集装箱骨架车、集装箱 ----------------

/** 集装箱骨架车：原点在牵引销；两根大梁、横梁、前后锁头梁（扭锁）、支腿、车轴、挡泥板、尾灯梁。forty = 40 尺，否则 20 尺 */
export function chassisFrame(forty: boolean, coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS[forty ? 'chassis' : 'chassis20'];
  const kp = s.kingpin as number;
  const zf = s.length - kp;
  const zr = -kp;
  const len = zf - zr;
  if (coarse) {
    b.coarse = true;
    b.box('trim', 1.0, 0.25, len, 0, 1.12, (zf + zr) / 2);
    for (const z of [zf - 0.15, zr + 0.15]) b.box('trim', 2.4, 0.2, 0.3, 0, 1.15, z);
    for (const sx of [-1, 1]) b.box('tail', 0.3, 0.12, 0.05, sx * 1.0, 0.98, zr - 0.01);
    coarseAxles(b, s.axles, zr);
    return b.finish(zr);
  }
  // 大梁（工字钢）：上下翼缘 + 腹板；前端鹅颈处略低
  for (const sx of [-1, 1]) {
    b.box('dark', 0.16, 0.03, len, sx * 0.5, 1.235, (zf + zr) / 2);
    b.box('dark', 0.03, 0.26, len, sx * 0.5, 1.1, (zf + zr) / 2);
    b.box('dark', 0.16, 0.03, len, sx * 0.5, 0.965, (zf + zr) / 2);
  }
  for (let z = zr + 0.8; z < zf - 0.5; z += forty ? 1.6 : 1.4) b.box('dark', 0.9, 0.12, 0.1, 0, 1.12, z);
  // 前后锁头梁、四角扭锁
  for (const z of [zf - 0.15, zr + 0.15]) {
    b.box('dark', 2.42, 0.2, 0.28, 0, 1.15, z);
    for (const sx of [-1, 1]) b.box('chrome', 0.12, 0.08, 0.12, sx * 1.12, 1.29, z);
  }
  if (forty) for (const sx of [-1, 1]) b.box('dark', 0.86, 0.12, 0.2, sx * 0.75, 1.15, zr + len / 2);
  // 支腿、车轴下的悬挂、挡泥板、尾灯梁
  for (const sx of [-1, 1]) {
    b.box('trim', 0.14, 0.9, 0.14, sx * 0.85, 0.52, -1.9);
    b.box('trim', 0.3, 0.06, 0.3, sx * 0.85, 0.05, -1.9);
  }
  for (const a of s.axles) b.box('trim', 1.9, 0.1, 0.16, 0, a.r, a.x + zr);
  mudflaps(b, zr + (forty ? 0.8 : 0.7), 0.9);
  b.box('trim', 2.3, 0.16, 0.16, 0, 0.86, zr + 0.12);
  rearCluster(b, zr + 0.02, 0.98, 0.9, 0.36);
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.72, zr + 0.06);
  sideMarkers(b, zr + 1.0, zf - 1.0, 1.0, 0.6, forty ? 3.0 : 2.5);
  return b.finish(zr);
}

/** 集装箱（原点在箱尾的底面中心）：波纹侧板和前壁（车漆，按实例着色）、箱门（四根锁杆、铰链）、顶 / 底边梁、角件 */
export function containerBox(forty: boolean, coarse: boolean): Geo {
  const b = new MeshBuilder();
  const L = forty ? 12.19 : 6.06;
  const W = 2.44;
  const H = 2.59;
  if (coarse) {
    b.coarse = true;
    b.box('paint', W, H, L, 0, H / 2, L / 2);
    for (const sx of [-1, 1]) b.box('trim', 0.04, H - 0.2, 0.05, sx * 0.3, H / 2, -0.02);
    return b.finish(0);
  }
  // 侧板：梯形波纹（每 0.28 米一道），沿车长连成一条带
  const pitch = 0.28;
  const n = Math.floor((L - 0.3) / pitch);
  const z0 = (L - n * pitch) / 2;
  const depth = 0.035;
  for (const sx of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const z = z0 + i * pitch;
      const off = (k: number) => sx * (W / 2 - (k ? depth : 0));
      pts.push(new THREE.Vector3(off(0), 0, z), new THREE.Vector3(off(0), 0, z + pitch * 0.2), new THREE.Vector3(off(1), 0, z + pitch * 0.35), new THREE.Vector3(off(1), 0, z + pitch * 0.85));
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i] as THREE.Vector3;
      const c = pts[i + 1] as THREE.Vector3;
      if (c.z > L - z0 + 1e-6) break;
      const A = new THREE.Vector3(a.x, 0.12, a.z);
      const B = new THREE.Vector3(c.x, 0.12, c.z);
      const C = new THREE.Vector3(c.x, H - 0.12, c.z);
      const D = new THREE.Vector3(a.x, H - 0.12, a.z);
      if (sx > 0) {
        b.tri('paint', A, D, C);
        b.tri('paint', A, C, B);
      } else {
        b.tri('paint', A, B, C);
        b.tri('paint', A, C, D);
      }
    }
  }
  // 顶板、底板（深色）、顶 / 底边梁、四角立柱与角件
  b.box('paint', W - 0.04, 0.04, L - 0.1, 0, H - 0.03, L / 2);
  b.box('dark', W - 0.04, 0.05, L - 0.1, 0, 0.03, L / 2);
  for (const sx of [-1, 1]) {
    b.box('paint', 0.08, 0.12, L, sx * (W / 2 - 0.04), H - 0.06, L / 2);
    b.box('paint', 0.08, 0.14, L, sx * (W / 2 - 0.04), 0.07, L / 2);
    for (const z of [0.07, L - 0.07]) {
      b.box('paint', 0.14, H, 0.14, sx * (W / 2 - 0.07), H / 2, z);
      for (const y of [0.06, H - 0.06]) b.box('dark', 0.17, 0.12, 0.17, sx * (W / 2 - 0.085), y, z);
    }
  }
  // 前壁（竖波纹）
  for (let k = 0; k < 8; k++) b.box('paint', 0.22, H - 0.26, 0.04, -W / 2 + 0.25 + k * 0.28, H / 2, L - 0.02);
  // 箱门：两扇门板、四根锁杆（带锁扣）、铰链、门封
  b.box('paint', W - 0.24, H - 0.3, 0.04, 0, H / 2, 0.02);
  b.box('trim', 0.02, H - 0.32, 0.02, 0, H / 2, -0.005);
  for (const xx of [-0.92, -0.42, 0.42, 0.92]) {
    b.box('chrome', 0.04, H - 0.28, 0.04, xx, H / 2, -0.03);
    b.box('trim', 0.12, 0.05, 0.05, xx, 1.05, -0.05);
  }
  for (const sx of [-1, 1]) for (const y of [0.35, 1.0, 1.6, 2.25]) b.box('chrome', 0.1, 0.06, 0.05, sx * (W / 2 - 0.13), y, -0.01);
  return b.finish(0);
}

// ---------------- 12 米城市公交（低地板） ----------------

/** 12 米低地板城市公交：原点在车尾。车身车漆按实例着色（线路颜色），大车窗、前门和中门（右侧）、前后风挡、空调机组、线路牌（不写字的亮条） */
export function cityBus(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.bus;
  const L = s.length;
  const axles = s.axles.map((a) => a.x).sort((a, c) => a - c);
  if (coarse) {
    b.coarse = true;
    b.box('paint', 2.55, 0.75, L, 0, 0.3 + 0.375, L / 2);
    b.box('glass', 2.57, 1.38, L - 0.6, 0, 1.05 + 0.69, L / 2 - 0.1);
    b.box('paint', 2.55, 0.6, L, 0, 2.43 + 0.3, L / 2);
    b.box('white', 1.6, 0.25, 3.0, 0, 3.15, 5.0);
    b.box('glass', 2.3, 1.7, 0.06, 0, 1.85, L - 0.01);
    for (const sx of [-1, 1]) {
      b.box('light', 0.32, 0.16, 0.06, sx * 0.9, 0.78, L);
      b.box('tail', 0.14, 0.42, 0.05, sx * 1.08, 0.95, -0.01);
    }
    coarseAxles(b, s.axles, 0);
    return b.finish(0);
  }
  const top = (z: number) => pw([[0, 2.95], [0.15, 3.05], [L - 0.3, 3.05], [L - 0.05, 2.95], [L, 2.8]], z);
  const hw = (z: number) => 1.275 * (1 - 0.03 * smooth01((z - (L - 0.2)) / 0.2)) * (1 - 0.02 * smooth01((0.15 - z) / 0.15));
  const levels = [0.62, 0.95, 1.05, 2.35, 2.43, 2.6];
  const frontDoor: [number, number] = [L - 1.62, L - 0.42];
  const midDoor: [number, number] = [5.3, 6.55];
  const winEdges = [0.6, 2.05, 3.55, 5.2, 6.65, 7.9, 9.15, 10.3];
  const keys = [...axles.flatMap((a) => [a - 0.58, a, a + 0.58]), ...frontDoor, ...midDoor, ...winEdges, L - 0.1, L - 0.25, 0.12];
  const zs = stations(0, L, 0.16, keys);
  b.glassY0 = 1.1;
  b.glassY1 = 2.6;
  loft(
    b,
    zs.map((z) => tallSection(z, hw(z), 0.3, arches(axles, 0.5, 0.58, 0.32, z), top(z), 0.22, 0.03, levels)),
    (q) => {
      if (q.band <= 2) return 'trim';
      if (sideBand(q, levels)) {
        const inDoor = (d: [number, number]) => !q.right && q.zc > d[0] && q.zc < d[1];
        // 车门（右侧）：上下都是玻璃，中间一道门缝
        if (inDoor(frontDoor) || inDoor(midDoor)) {
          if (q.yc > 0.35 && q.yc < 2.43) return [frontDoor, midDoor].some((d) => Math.abs(q.zc - (d[0] + d[1]) / 2) < 0.014) ? 'trim' : 'glass';
        }
        if (q.yc > 1.05 && q.yc < 2.35 && q.zc > 0.35 && q.zc < L - 0.15) {
          // 窗间立柱
          if (winEdges.some((e) => Math.abs(q.zc - e) < 0.05)) return 'trim';
          return 'glass';
        }
        if (q.yc > 0.95 && q.yc < 1.05) return 'trim';
        if (q.yc > 2.43 && q.yc < 2.6 && q.zc > 0.3) return 'white';
        if (q.yc < 0.62) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  // 前风挡（大、略后仰）、线路牌的亮条（不写字）、雨刮、后视镜（前伸的支臂）
  b.box('glass', 2.32, 1.62, 0.03, 0, 1.85, L + 0.01, { r: 0.03, rx: -0.04 });
  b.box('trim', 2.2, 0.26, 0.04, 0, 2.82, L - 0.02);
  b.box('amber', 1.7, 0.12, 0.02, 0, 2.82, L + 0.005);
  for (const sx of [-1, 1]) {
    b.box('trim', 0.85, 0.025, 0.03, sx * 0.48, 1.08, L + 0.03, { rz: sx * 0.12 });
    b.tube('trim', [new THREE.Vector3(sx * 1.2, 2.7, L - 0.2), new THREE.Vector3(sx * 1.38, 2.7, L + 0.25), new THREE.Vector3(sx * 1.38, 2.45, L + 0.42)], 0.025, 5);
    b.box('trim', 0.08, 0.42, 0.24, sx * 1.38, 2.2, L + 0.42, { r: 0.03 });
    b.box('light', 0.34, 0.16, 0.06, sx * 0.9, 0.78, L + 0.01, { r: 0.03 });
    b.box('amber', 0.12, 0.14, 0.05, sx * 1.1, 1.0, L + 0.005);
    b.box('tail', 0.14, 0.45, 0.05, sx * 1.08, 0.95, -0.01, { r: 0.02 });
  }
  b.box('trim', 2.45, 0.32, 0.14, 0, 0.5, L - 0.02, { r: 0.05 });
  b.box('trim', 2.45, 0.3, 0.12, 0, 0.5, 0.02, { r: 0.05 });
  b.box('glass', 1.9, 0.62, 0.03, 0, 2.1, -0.012);
  // 车尾的发动机散热格栅
  for (let k = 0; k < 5; k++) b.box('trim', 1.6, 0.04, 0.02, 0, 1.0 + k * 0.08, -0.015);
  // 车顶：空调机组、动力电池舱罩
  b.box('white', 1.7, 0.26, 3.2, 0, 3.17, 4.6, { r: 0.08 });
  b.box('white', 1.5, 0.18, 2.2, 0, 3.12, 8.3, { r: 0.06 });
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.75, -0.02);
  return b.finish(0);
}

// ---------------- 房车、小拖车（第一部分的车型） ----------------

/** A 型自行式房车：长 11.2、宽 2.55、高 3.75 米；原点在车身中心 */
export function rvClassA(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const L = 11.2;
  const half = L / 2;
  const s = MODEL_SPECS.rv;
  const axles = s.axles.map((a) => a.x - half).sort((a, c) => a - c);
  if (coarse) {
    b.coarse = true;
    b.box('paint', 2.55, 3.0, L - 0.4, 0, 0.45 + 1.5, -0.2);
    b.box('glass', 2.4, 1.2, 0.5, 0, 2.3, half - 0.3);
    b.box('glass', 2.57, 0.7, 6.0, 0, 2.2, -0.4);
    b.box('accent', 2.57, 0.2, L - 1.2, 0, 1.42, -0.4);
    for (const sx of [-1, 1]) {
      b.box('light', 0.4, 0.2, 0.06, sx * 0.85, 1.05, half);
      b.box('tail', 0.14, 0.5, 0.05, sx * 1.12, 1.25, -half);
    }
    coarseAxles(b, s.axles, -half);
    return b.finish(-half);
  }
  const top = (z: number) => pw([[-half, 3.25], [-half + 0.25, 3.45], [half - 1.0, 3.45], [half - 0.55, 3.2], [half - 0.15, 2.0], [half, 1.3]], z);
  const hw = (z: number) => 1.275 * (1 - 0.05 * smooth01((z - (half - 0.9)) / 0.9)) * (1 - 0.03 * smooth01((-half + 0.25 - z) / 0.25));
  const levels = [0.62, 0.65, 1.0, 1.25, 1.32, 1.52, 1.55, 1.62, 1.75, 1.82, 1.85, 1.9, 2.38, 2.55, 2.6, 2.65, 3.0, 3.2];
  const keys = [...axles.flatMap((a) => [a - 0.6, a, a + 0.6]), half - 0.6, half - 0.55, half - 0.15, half - 0.12, 2.2, 2.36, 2.8, 2.95, 3.2, 4.6, 0.6, 2.0, -1.6, -0.2, -4.6, -3.4, -3.2, -1.9, -0.6, 0.7];
  const zs = stations(-half, half, 0.14, keys);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.42, arches(axles, 0.5, 0.6, 0.56, z), top(z), 0.28, 0.04, levels));
  const windows: Rect[] = [
    { z0: 3.2, z1: 4.6, y0: 1.75, y1: 2.65 },
    { z0: 0.6, z1: 2.0, y0: 1.85, y1: 2.6 },
    { z0: -1.6, z1: -0.2, y0: 1.85, y1: 2.6 },
    { z0: -4.6, z1: -3.4, y0: 1.9, y1: 2.55 },
  ];
  const door: Rect = { z0: 2.2, z1: 2.95, y0: 0.62, y1: 2.6 };
  b.glassY0 = 1.6;
  b.glassY1 = 3.0;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      if (roofBand(q, levels) && q.zc > half - 0.55 && q.zc < half - 0.12 && q.yc > 1.65) return 'glass';
      if (sideBand(q, levels)) {
        if (windows.some((r) => inRect(q, r))) return 'glass';
        if (!q.right && inRect(q, door)) return Math.abs(q.yc - 2.1) < 0.28 && Math.abs(q.zc - 2.58) < 0.22 ? 'glass' : 'white';
        if (q.yc > 0.65 && q.yc < 1.25 && [-3.2, -1.9, -0.6, 0.7].some((sz) => Math.abs(q.zc - sz) < 0.013)) return 'trim';
        if (q.yc > 1.32 && q.yc < 1.52 && q.zc < half - 0.6) return 'accent';
        if (q.yc > 1.55 && q.yc < 1.62 && q.zc < half - 0.6) return 'accent';
        if (q.yc < 0.62) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  for (const sx of [-1, 1]) {
    b.box('light', 0.42, 0.2, 0.12, sx * 0.85, 1.05, half - 0.03, { r: 0.04, ry: sx * 0.15 });
    b.box('tail', 0.14, 0.55, 0.06, sx * 1.12, 1.25, -half + 0.01, { r: 0.03 });
    b.box('trim', 0.1, 0.6, 0.3, sx * 1.36, 2.65, half - 0.9, { r: 0.04 });
  }
  b.box('trim', 1.1, 0.3, 0.05, 0, 0.98, half + 0.002, { r: 0.04 });
  b.box('trim', 2.4, 0.25, 0.22, 0, 0.62, half - 0.05, { r: 0.06 });
  b.box('glass', 1.7, 0.5, 0.02, 0, 2.6, -half - 0.005, { r: 0.02 });
  b.box('trim', 2.4, 0.22, 0.2, 0, 0.62, -half + 0.05, { r: 0.05 });
  b.box('plate', 0.44, 0.14, 0.02, 0, 0.95, -half - 0.012);
  for (const yy of [0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2]) b.box('chrome', 0.42, 0.03, 0.03, -0.75, yy, -half - 0.06);
  for (const sx of [-1, 1]) b.box('chrome', 0.03, 2.8, 0.03, -0.75 + sx * 0.2, 2.05, -half - 0.06);
  for (const z of [1.6, -2.4]) b.box('white', 0.75, 0.3, 1.0, 0, 3.6, z, { r: 0.08 });
  b.box('glass', 1.6, 0.03, 1.2, 0, 3.5, -0.4);
  b.box('white', 0.5, 0.12, 0.5, 0.4, 3.53, 3.6, { r: 0.04 });
  b.box('white', 0.14, 0.14, 4.6, -1.34, 3.05, -0.4, { r: 0.06 });
  return b.finish(-half);
}

/** 拖挂式房车（原点在挂钩球头，向 −Z 延伸到 −9.65）：A 字形拖杆、液化气罐、电瓶箱、千斤顶、前端弧形导流面、侧窗、入户门、车顶空调、遮阳篷、串联轴 */
export function travelTrailer(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.camper;
  const zf = -1.45;
  const zr = -s.length;
  if (coarse) {
    b.coarse = true;
    b.box('paint', 2.44, 2.55, zf - zr, 0, 0.55 + 1.27, (zf + zr) / 2);
    b.box('glass', 2.46, 0.6, 5.5, 0, 2.1, -5.3);
    b.box('accent', 2.46, 0.15, zf - zr - 0.3, 0, 1.1, (zf + zr) / 2);
    b.box('trim', 0.2, 0.15, 1.5, 0, 0.5, -0.7);
    for (const sx of [-1, 1]) b.box('tail', 0.16, 0.12, 0.05, sx * 1.0, 0.9, zr);
    coarseAxles(b, s.axles, zr);
    return b.finish(zr);
  }
  const top = (z: number) => pw([[zr, 3.0], [zr + 0.2, 3.12], [zf - 0.9, 3.12], [zf - 0.3, 2.65], [zf, 1.6]], z);
  const hw = (z: number) => 1.22 * (1 - 0.06 * smooth01((z - (zf - 0.5)) / 0.5));
  const axles = s.axles.map((a) => a.x + zr);
  const levels = [0.6, 1.0, 1.18, 1.24, 1.3, 1.75, 1.9, 2.4, 2.45, 2.5, 2.7];
  const zs = stations(zr, zf, 0.14, [...axles.flatMap((a) => [a - 0.45, a, a + 0.45]), zf - 0.3, zf - 0.05, -3.5, -4.25, -3.0, -2.2, -5.5, -4.6, -8.8, -7.6]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.5, arches(axles, 0.36, 0.42, 0.55, z), top(z), 0.2, 0.03, levels));
  const windows: Rect[] = [
    { z0: -3.0, z1: -2.2, y0: 1.75, y1: 2.45 },
    { z0: -5.5, z1: -4.6, y0: 1.75, y1: 2.45 },
    { z0: -8.8, z1: -7.6, y0: 1.75, y1: 2.45 },
  ];
  b.glassY0 = 1.6;
  b.glassY1 = 2.8;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      if (roofBand(q, levels) && q.zc > zf - 0.3 && q.zc < zf - 0.05 && q.yc > 1.9 && q.yc < 2.4) return 'glass';
      if (sideBand(q, levels)) {
        if (windows.some((r) => inRect(q, r))) return 'glass';
        if (!q.right && inRect(q, { z0: -4.25, z1: -3.5, y0: 0.6, y1: 2.5 })) return 'white';
        if (q.yc > 1.0 && q.yc < 1.18) return 'accent';
        if (q.yc > 1.24 && q.yc < 1.3) return 'accent';
        if (q.yc < 0.6) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  for (const sx of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.1, 0.12, 1.75);
    g.rotateY(sx * 0.42);
    g.translate(sx * 0.36, 0.5, -0.78);
    b.part(g, 'trim');
  }
  b.box('trim', 0.18, 0.14, 0.3, 0, 0.5, -0.1);
  b.cyl('chrome', 0.05, 0.05, 0.75, 0.12, 0.62, -0.45, 'y', 8);
  for (const sx of [-1, 1]) b.cyl('white', 0.17, 0.17, 0.62, sx * 0.2, 0.92, -1.0, 'y', 14);
  b.box('trim', 0.42, 0.28, 0.3, 0, 0.72, -1.3, { r: 0.03 });
  for (const sx of [-1, 1]) b.box('tail', 0.16, 0.12, 0.05, sx * 1.0, 0.9, zr - 0.01, { r: 0.02 });
  b.box('chrome', 2.2, 0.12, 0.12, 0, 0.55, zr - 0.02);
  b.box('glass', 1.0, 0.4, 0.02, 0, 2.2, zr - 0.006);
  b.box('white', 0.72, 0.28, 0.95, 0, 3.26, -5.2, { r: 0.08 });
  b.box('white', 0.13, 0.13, 4.2, -1.24, 2.72, -5.0, { r: 0.05 });
  return b.finish(zr);
}

/** 开放式快艇（放在船拖车上；船头朝 +Z，原点在船底中点）：深 V 船壳、护舷、风挡、驾驶台、座椅、舷外机；船壳车漆按实例着色 */
function bowrider(b: MeshBuilder, z0: number, coarse: boolean): void {
  const L = 6.2;
  const zs = coarse ? [0, 0.25, 0.6, 0.85, 1] : Array.from({ length: 15 }, (_, i) => i / 14);
  const secs = zs.map((f) => {
    const z = z0 + f * L;
    // 船头收尖、船尾方；船底深 V
    const beam = 1.12 * (f > 0.62 ? Math.sqrt(Math.max(0, 1 - ((f - 0.62) / 0.38) ** 2)) : 1) + 0.0001;
    const sheer = 0.95 + 0.25 * smooth01((f - 0.5) / 0.5);
    const keel = 0.05 + 0.25 * smooth01((f - 0.7) / 0.3);
    return { z, pts: [[0, keel], [beam * 0.5, keel + 0.18], [beam * 0.95, 0.42], [beam, sheer - 0.1], [beam * 0.98, sheer], [beam * 0.6, sheer + 0.01], [0, sheer + 0.02]] as Array<[number, number]> };
  });
  loft(b, secs, (q) => (q.band >= 4 ? (q.zc < z0 + L * 0.72 && q.band >= 4 ? null : 'white') : q.band === 3 ? 'paint' : q.band <= 1 ? 'white' : 'paint'), { rear: 'white', front: 'white' });
  // 甲板（座舱地板）、护舷、风挡、驾驶台、座椅、舷外机
  b.box('deck', 2.0, 0.04, L * 0.68, 0, 0.62, z0 + L * 0.36);
  for (const sx of [-1, 1]) b.box('trim', 0.05, 0.06, L * 0.75, sx * 1.1, 0.95, z0 + L * 0.42);
  b.box('glass', 1.9, 0.3, 0.05, 0, 1.15, z0 + L * 0.68, { rx: -0.5 });
  b.box('white', 0.7, 0.55, 0.6, 0.45, 0.9, z0 + L * 0.58, { r: 0.05 });
  b.box('cushion', 1.6, 0.25, 0.6, 0, 0.8, z0 + L * 0.2);
  b.box('cushion', 0.5, 0.35, 0.5, 0.45, 0.8, z0 + L * 0.45);
  b.box('trim', 0.38, 0.75, 0.42, 0, 0.75, z0 - 0.22, { r: 0.05 });
}

/** 船拖车（原点在挂钩球头，向 −Z 延伸 7.4 米）：车架、木垫梁、绞盘柱、挡泥板、尾灯；船放在上面 */
export function boatTrailer(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.boatTrailer;
  const zr = -s.length;
  if (coarse) b.coarse = true;
  b.box('trim', 0.12, 0.12, 2.0, 0, 0.45, -0.9);
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.1, 0.12, 5.6, sx * 0.55, 0.45, -4.4);
    if (!coarse) b.box('wood', 0.12, 0.1, 3.6, sx * 0.42, 0.62, -4.6);
    // 挡泥板：车轴上方的半圆弧（形状画在 (z, y) 平面里，圆心在车轴上方）
    const az = (s.axles[0] as AxleSpec).x + zr;
    const shape = new THREE.Shape();
    shape.absarc(az, 0.33, 0.42, 0, Math.PI, false);
    shape.lineTo(az - 0.36, 0.33);
    shape.absarc(az, 0.33, 0.36, Math.PI, 0, true);
    shape.closePath();
    b.extrudeZY('white', shape, 0.26, sx * 0.95 - 0.13);
  }
  for (const z of [-2.2, -3.8, -5.6, -6.9]) b.box('chrome', 1.2, 0.1, 0.1, 0, 0.45, z);
  b.box('chrome', 0.1, 0.8, 0.1, 0, 0.85, -1.85);
  b.box('trim', 0.25, 0.2, 0.2, 0, 1.15, -1.75, { r: 0.04 });
  for (const sx of [-1, 1]) b.box('tail', 0.14, 0.1, 0.06, sx * 0.62, 0.55, zr + 0.2);
  b.box('trim', 1.4, 0.06, 0.06, 0, 0.55, zr + 0.2);
  bowrider(b, -7.05, coarse);
  if (coarse) coarseAxles(b, s.axles, zr);
  return b.finish(zr);
}

/** 小型平板拖车（原点在挂钩球头，向 −Z 延伸 4.3 米）：拖杆、平板、网栏、尾门坡板 */
export function utilityTrailer(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.utilityTrailer;
  const zr = -s.length;
  if (coarse) b.coarse = true;
  b.box('trim', 0.1, 0.1, 1.3, 0, 0.5, -0.6);
  b.box('wood', 1.86, 0.05, 3.0, 0, 0.58, -2.75);
  for (const sx of [-1, 1]) {
    b.box('paint', 0.06, 0.06, 3.0, sx * 0.95, 0.58, -2.75);
    b.box('paint', 0.05, 0.05, 3.0, sx * 0.95, 1.05, -2.75);
    if (!coarse) for (let z = -1.3; z >= -4.2; z -= 0.42) b.box('paint', 0.03, 0.46, 0.03, sx * 0.95, 0.82, z);
    b.box('paint', 0.3, 0.06, 0.8, sx * 1.05, 0.72, -3.0, { r: 0.02 });
  }
  b.box('paint', 1.9, 0.05, 0.05, 0, 1.05, -1.25);
  b.box('paint', 1.84, 0.9, 0.05, 0, 1.03, -4.27);
  if (!coarse) for (let x = -0.8; x <= 0.81; x += 0.2) b.box('paint', 0.03, 0.86, 0.06, x, 1.03, -4.27);
  for (const sx of [-1, 1]) b.box('tail', 0.12, 0.08, 0.06, sx * 0.85, 0.55, -4.3);
  if (coarse) coarseAxles(b, s.axles, zr);
  return b.finish(zr);
}

// ---------------- 场内牵引车 ----------------

/**
 * 港口场内拖车（码头拖车）：原点在车尾。偏置的单座驾驶室（左侧，四面大窗）、右侧低矮的发动机罩、前面带配重的保险杠、
 * 可举升的鞍座、后面的走台和气管、车顶的黄色警示灯；车身车漆按实例着色。
 */
export function terminalTractor(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.terminalTractor;
  const L = s.length;
  const kp = s.kingpin as number;
  if (coarse) {
    b.coarse = true;
    b.box('trim', 1.2, 0.3, L - 0.3, 0, 1.0, L / 2);
    b.box('paint', 1.25, 1.95, 2.1, 0.62, 1.2 + 0.98, 3.65);
    b.box('glass', 1.27, 0.95, 1.9, 0.62, 2.55, 3.65);
    b.box('paint', 1.2, 0.8, 2.2, -0.65, 1.2 + 0.4, 4.1);
    b.box('trim', 2.5, 0.6, 0.3, 0, 0.8, L - 0.15);
    b.box('trim', 1.6, 0.12, 1.2, 0, 1.42, kp);
    coarseAxles(b, s.axles, 0);
    return b.finish(0);
  }
  // 车架、配重保险杠、前面的大灯
  for (const sx of [-1, 1]) b.box('trim', 0.14, 0.3, L - 0.35, sx * 0.48, 1.0, L / 2 - 0.1);
  b.box('dark', 2.5, 0.62, 0.32, 0, 0.82, L - 0.16, { r: 0.05 });
  b.box('amber', 2.3, 0.08, 0.02, 0, 1.06, L + 0.005);
  // 驾驶室（左侧，建模坐标 +X）：四面大窗、圆角
  const cx = 0.62;
  b.box('paint', 1.25, 0.55, 2.1, cx, 1.2 + 0.28, 3.65, { r: 0.05 });
  b.box('glass', 1.23, 0.95, 2.05, cx, 2.24, 3.65, { r: 0.04 });
  for (const zz of [2.62, 4.68]) for (const xx of [cx - 0.6, cx + 0.6]) b.box('paint', 0.06, 0.95, 0.06, xx, 2.24, zz);
  b.box('paint', 1.32, 0.12, 2.18, cx, 2.77, 3.65, { r: 0.04 });
  b.cyl('amber', 0.1, 0.1, 0.16, cx, 2.91, 3.3, 'y', 10);
  // 右侧发动机罩、进气格栅、竖直排气管
  b.box('paint', 1.2, 0.82, 2.4, -0.66, 1.2 + 0.41, 4.05, { r: 0.06 });
  for (let k = 0; k < 4; k++) b.box('trim', 0.9, 0.03, 0.02, -0.66, 1.4 + k * 0.12, 5.26);
  b.cyl('chrome', 0.07, 0.07, 1.6, -1.15, 2.4, 2.9, 'y', 8);
  for (const sx of [-1, 1]) {
    b.box('light', 0.26, 0.16, 0.06, sx * 0.95, 1.15, L + 0.01, { r: 0.03 });
    b.box('trim', 0.62, 0.05, 1.45, sx * 0.92, 1.25, s.axles[0]!.x, { r: 0.02 });
  }
  // 可举升的鞍座（举升架 + 盘）、后走台（花纹板）和栏杆、盘起来的气管和电线
  b.box('trim', 1.5, 0.12, 1.1, 0, 1.25, kp);
  b.cyl('dark', 0.6, 0.6, 0.08, 0, 1.38, kp, 'y', 16);
  b.box('alu', 1.9, 0.04, 0.85, 0, 1.25, 2.25);
  for (const sx of [-1, 1]) b.box('chrome', 0.03, 0.75, 0.03, sx * 0.9, 1.62, 2.0);
  b.box('chrome', 1.82, 0.03, 0.03, 0, 2.0, 2.0);
  for (const [i, c] of (['#2f6fb5', '#c8262b'] as const).entries()) b.tube('trim', [new THREE.Vector3(-0.2 + i * 0.25, 2.0, 2.05), new THREE.Vector3(-0.15 + i * 0.25, 1.7, 1.6), new THREE.Vector3(-0.1 + i * 0.2, 1.5, 0.6)], 0.02, 5, COLOR(c));
  b.box('trim', 2.4, 0.16, 0.14, 0, 0.85, 0.07);
  rearCluster(b, 0.0, 1.1, 0.9, 0.34);
  mudflaps(b, s.axles[1]!.x - 0.65, 0.9);
  return b.finish(0);
}

/**
 * 配送中心场内牵引车（调车车）：原点在车尾。居中偏左的驾驶室（后门出入、四面窗）、后面的走台和扶梯、可举升的鞍座、
 * 前面的格栅和保险杠、车顶警示灯；车身车漆按实例着色。
 */
export function yardShunter(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.yardShunter;
  const L = s.length;
  const kp = s.kingpin as number;
  if (coarse) {
    b.coarse = true;
    b.box('trim', 1.1, 0.3, L - 0.3, 0, 0.95, L / 2);
    b.box('paint', 1.7, 1.85, 2.1, 0.25, 1.25 + 0.92, 3.1);
    b.box('glass', 1.72, 0.85, 2.0, 0.25, 2.55, 3.1);
    b.box('paint', 2.2, 0.85, 1.0, 0, 1.2 + 0.42, 4.65);
    b.box('trim', 2.45, 0.4, 0.25, 0, 0.75, L - 0.12);
    b.box('trim', 1.5, 0.12, 1.1, 0, 1.35, kp);
    coarseAxles(b, s.axles, 0);
    return b.finish(0);
  }
  for (const sx of [-1, 1]) b.box('trim', 0.14, 0.28, L - 0.3, sx * 0.46, 0.95, L / 2 - 0.05);
  // 车头：发动机罩、格栅、保险杠、大灯
  b.box('paint', 2.2, 0.85, 1.05, 0, 1.2 + 0.42, 4.62, { r: 0.06 });
  b.box('trim', 1.3, 0.5, 0.04, 0, 1.55, L - 0.03);
  for (let k = 0; k < 5; k++) b.box('chrome', 1.2, 0.025, 0.02, 0, 1.36 + k * 0.1, L - 0.005);
  b.box('trim', 2.45, 0.38, 0.24, 0, 0.75, L - 0.12, { r: 0.05 });
  for (const sx of [-1, 1]) {
    b.box('light', 0.28, 0.18, 0.06, sx * 0.82, 1.1, L + 0.005, { r: 0.03 });
    b.box('trim', 0.6, 0.05, 1.35, sx * 0.95, 1.18, s.axles[0]!.x, { r: 0.02 });
  }
  // 驾驶室（居中偏左）：四面窗，后门
  const cx = 0.25;
  b.box('paint', 1.7, 0.6, 2.05, cx, 1.25 + 0.3, 3.1, { r: 0.05 });
  b.box('glass', 1.68, 0.88, 2.0, cx, 2.29, 3.1, { r: 0.04 });
  for (const zz of [2.1, 4.1]) for (const xx of [cx - 0.82, cx + 0.82]) b.box('paint', 0.06, 0.88, 0.06, xx, 2.29, zz);
  b.box('paint', 1.78, 0.12, 2.12, cx, 2.8, 3.1, { r: 0.04 });
  b.box('trim', 0.04, 1.4, 0.7, cx - 0.05, 1.95, 2.05);
  b.cyl('amber', 0.1, 0.1, 0.16, cx, 2.94, 2.6, 'y', 10);
  // 后走台（到鞍座）、扶梯、鞍座、气管
  b.box('alu', 1.8, 0.04, 0.6, 0, 1.3, 1.95);
  for (const y of [0.55, 0.9]) b.box('alu', 0.6, 0.04, 0.25, cx - 0.1, y, 2.05);
  b.box('trim', 1.45, 0.12, 1.0, 0, 1.25, kp);
  b.cyl('dark', 0.56, 0.56, 0.08, 0, 1.37, kp, 'y', 16);
  for (const [i, c] of (['#2f6fb5', '#c8262b'] as const).entries()) b.tube('trim', [new THREE.Vector3(-0.5 + i * 0.25, 2.3, 2.08), new THREE.Vector3(-0.45 + i * 0.25, 1.8, 1.7), new THREE.Vector3(-0.4 + i * 0.2, 1.5, 0.5)], 0.02, 5, COLOR(c));
  b.box('trim', 2.3, 0.16, 0.14, 0, 0.82, 0.07);
  rearCluster(b, 0.0, 1.05, 0.88, 0.34);
  mudflaps(b, s.axles[1]!.x - 0.62, 0.88);
  return b.finish(0);
}

/** 模型名 → 建模函数（零件坐标；coarse = 远处的简模） */
export function truckModel(key: ModelKey, coarse: boolean): Geo | undefined {
  switch (key) {
    case 'van':
      return van(undefined, coarse);
    case 'vanOnline':
      return van('#9b7bc4', coarse);
    case 'vanBakery':
      return van('#d9963a', coarse);
    case 'boxTruck':
      return boxTruck(coarse);
    case 'evTruck':
      return evTruck(coarse);
    case 'tractor':
      return tractorCabover(true, coarse);
    case 'tractorDay':
      return tractorCabover(false, coarse);
    case 'tractorLong':
      return tractorLong(coarse);
    case 'trailerDry':
      return trailer136(false, '#2a78d6', coarse);
    case 'trailerReefer':
      return trailer136(true, '#5fb0e8', coarse);
    case 'trailerPlain':
      return trailer136(false, undefined, coarse);
    case 'trailerPlainReefer':
      return trailer136(true, undefined, coarse);
    case 'chassis':
      return chassisFrame(true, coarse);
    case 'chassis20':
      return chassisFrame(false, coarse);
    case 'container':
      return containerBox(true, coarse);
    case 'container20':
      return containerBox(false, coarse);
    case 'bus':
      return cityBus(coarse);
    case 'rv':
      return rvClassA(coarse);
    case 'camper':
      return travelTrailer(coarse);
    case 'boatTrailer':
      return boatTrailer(coarse);
    case 'utilityTrailer':
      return utilityTrailer(coarse);
    case 'terminalTractor':
      return terminalTractor(coarse);
    case 'yardShunter':
      return yardShunter(coarse);
    default:
      return undefined;
  }
}

export type { Mat };
