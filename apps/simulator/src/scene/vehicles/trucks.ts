import * as THREE from 'three';
import { loft, MeshBuilder, pw, smooth01, stations, type Mat, type QuadInfo, type Section } from './builder';
import { SEMI } from '../vehicleTypes';

export { SEMI };

/**
 * 大型载具（按公开的常见外形和尺寸）：
 * - 全尺寸高顶厢式车、平头厢式货车（配送直送）；
 * - 长头带卧铺的半挂牵引车（原点在鞍座 / 牵引销，车头朝 +Z）；
 * - 53 英尺厢式挂车与冷藏挂车（原点在牵引销，向 −Z 延伸）；
 * - A 型自行式房车；拖挂式房车、船拖车（带船）、小型平板拖车（原点在挂钩球头，向 −Z 延伸）。
 * 车身用圆角矩形截面放样；车窗、门缝、彩条按位置分类出来，灯、格栅、油箱、排气管等是单独的部件。
 */

/**
 * 圆角矩形截面（右半边）：底部中点 → 底板边 → 轮罩 → 侧壁 → 顶角圆弧 → 顶部中点；点数固定。
 * 侧壁的点放在给定的绝对高度上（车窗上下沿、彩条边、行李舱门），分出来的车窗和彩条边缘是直的；
 * 低于轮罩或高于顶角的高度挤到可用范围内。
 */
function tallSection(z: number, hw: number, yB: number, ySide: number, yTop: number, rTop: number, crown: number, levels: number[]): Section {
  const r = Math.min(rTop, hw * 0.9, Math.max(0.02, (yTop - ySide) * 0.45));
  const pts: Array<[number, number]> = [
    [0, yB],
    [Math.max(0.02, hw - 0.2), yB],
    [Math.max(0.02, hw - 0.2), ySide],
    [hw - 0.015, ySide],
  ];
  const lo = ySide + 0.02;
  const hi = Math.max(lo + 0.002 * (levels.length + 1), yTop - r);
  let prev = ySide;
  levels.forEach((y, i) => {
    const yy = Math.max(prev + 0.001, Math.min(hi - (levels.length - i) * 0.002, Math.max(lo + i * 0.002, y)));
    pts.push([hw, yy]);
    prev = yy;
  });
  for (const a of [0.3, 0.75, 1.2]) pts.push([hw - r + r * Math.cos(a), Math.max(prev + 0.001, yTop - r + r * Math.sin(a))]);
  pts.push([Math.max(0.01, (hw - r) * 0.5), yTop + crown * 0.75], [0, yTop + crown]);
  return { z, pts };
}

/** 截面各段的编号：0–2 底盘和轮罩，3 … 3+L 侧壁（L 为侧壁高度数），4+L … 5+L 顶角，6+L 起车顶 */
const sideBand = (q: QuadInfo, levels: readonly number[]) => q.band >= 3 && q.band <= 3 + levels.length;
const roofBand = (q: QuadInfo, levels: readonly number[]) => q.band >= 6 + levels.length;

function arches(axles: number[], wheelR: number, archR: number, sill: number, z: number): number {
  let y = sill;
  for (const az of axles) {
    const d = Math.abs(z - az);
    if (d < archR) y = Math.max(y, wheelR + Math.sqrt(archR * archR - d * d) * 0.97);
  }
  return y;
}

interface Rect {
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

const inRect = (q: QuadInfo, r: Rect) => q.zc > r.z0 && q.zc < r.z1 && q.yc > r.y0 && q.yc < r.y1;

// ---------------- 厢式车 ----------------

/** 全尺寸高顶厢式车（货运版）：长 5.93、宽 2.05、高 2.55、轴距 3.66 米 */
export function van(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const L = 5.93;
  const half = L / 2;
  const axles = [-1.71, 1.95];
  const R = 0.37;
  const top = (z: number) =>
    pw(
      [
        [-half, 2.4],
        [-half + 0.12, 2.52],
        [1.0, 2.55],
        [1.25, 2.45],
        [2.15, 1.3],
        [2.4, 1.2],
        [2.85, 1.06],
        [half, 0.92],
      ],
      z,
    );
  const hw = (z: number) => 1.025 * (1 - 0.1 * Math.pow(Math.max(0, z - 2.2) / (half - 2.2), 2)) * (1 - 0.03 * smooth01((-half + 0.15 - z) / 0.15));
  const levels = [0.62, 0.95, 1.36, 2.12, 2.3];
  const zs = stations(-half, half, 0.12, [...axles.flatMap((a) => [a - 0.46, a, a + 0.46]), 1.05, 1.22, 1.25, 1.96, 2.15, 1.18, 2.02, -0.05, 0.95, -half + 0.05]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.25 + 0.07 * smooth01((Math.abs(z) - half + 0.2) / 0.2), arches(axles, R, 0.46, 0.42, z), top(z), z > 1.2 ? 0.12 : 0.2, 0.03, levels));
  const doorWin: Rect = { z0: 1.22, z1: 1.96, y0: 1.36, y1: 2.12 };
  b.glassY0 = 1.3;
  b.glassY1 = 2.4;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      // 前风挡：车头斜面上两根 A 柱之间
      if (roofBand(q, levels) && q.zc > 1.27 && q.zc < 2.13) return 'glass';
      if (sideBand(q, levels)) {
        if (q.yc < 0.62) return 'trim';
        if (inRect(q, doorWin)) return 'glass';
        // 车门缝：前门前后沿；侧滑门在右侧（−X）
        if (q.yc < 2.15 && [1.18, 2.02].some((s) => Math.abs(q.zc - s) < 0.013)) return 'trim';
        if (!q.right && q.yc < 2.15 && [-0.05, 0.95].some((s) => Math.abs(q.zc - s) < 0.013)) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  // 车头：大灯、格栅、保险杠；车尾：对开后门的窗、竖直尾灯、门缝
  for (const sx of [-1, 1]) {
    b.box('light', 0.38, 0.2, 0.12, sx * 0.72, 1.0, half - 0.05, { r: 0.04, ry: sx * 0.25 });
    b.box('tail', 0.12, 0.42, 0.06, sx * 0.94, 1.25, -half + 0.01, { r: 0.02 });
    b.box('glass', 0.62, 0.5, 0.02, sx * 0.42, 1.85, -half - 0.005);
    // 后视镜
    b.box('trim', 0.08, 0.36, 0.2, sx * 1.16, 1.75, 1.92, { r: 0.03 });
    b.box('trim', 0.14, 0.04, 0.04, sx * 1.08, 1.85, 1.98);
  }
  b.box('trim', 0.9, 0.28, 0.05, 0, 0.95, half - 0.01, { r: 0.04 });
  b.box('trim', 2.0, 0.22, 0.2, 0, 0.55, half - 0.04, { r: 0.05 });
  b.box('trim', 2.0, 0.2, 0.16, 0, 0.55, -half + 0.03, { r: 0.05 });
  b.box('trim', 0.02, 1.7, 0.02, 0, 1.4, -half - 0.006);
  b.box('plate', 0.5, 0.13, 0.02, 0, 0.82, -half - 0.012);
  b.box('plate', 0.5, 0.12, 0.02, 0, 0.62, half + 0.012);
  return b.build();
}

// ---------------- 平头厢式货车 ----------------

/** 平头（驾驶室在发动机上方）厢式货车：长 7.6、货厢宽 2.3、高 3.4 米；驾驶室车漆按实例着色，货厢白色 */
export function boxTruck(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const L = 7.6;
  const half = L / 2;
  const axles = [-1.6, 2.7];
  const R = 0.44;
  // 驾驶室：z 1.95 → 3.8
  const z0 = 1.95;
  const top = (z: number) => pw([[z0, 2.42], [3.5, 2.45], [3.72, 2.3], [half, 2.12]], z);
  const hw = (z: number) => 1.03 * (1 - 0.06 * smooth01((z - 3.55) / (half - 3.55)));
  const levels = [0.95, 1.5, 2.25];
  const zs = stations(z0, half, 0.1, [2.25, 2.35, 3.1, 3.4, 3.55, 2.6, 2.7, 2.3, 3.45]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.62, arches(axles, R, 0.52, 0.72, z), top(z), 0.14, 0.02, levels));
  b.glassY0 = 1.5;
  b.glassY1 = 2.4;
  loft(
    b,
    sec,
    (q) => {
      if (q.band <= 2) return 'trim';
      if (sideBand(q, levels)) {
        if (inRect(q, { z0: 2.35, z1: 3.4, y0: 1.5, y1: 2.25 })) return 'glass';
        if ([2.3, 3.45].some((s) => Math.abs(q.zc - s) < 0.013) && q.yc < 2.28) return 'trim';
      }
      return 'paint';
    },
    { rear: 'trim', front: 'paint' },
  );
  // 前风挡：驾驶室正面上部，略微后仰
  b.box('glass', 1.78, 0.62, 0.03, 0, 1.86, half + 0.012, { r: 0.04, rx: -0.07 });
  b.box('trim', 1.86, 0.05, 0.05, 0, 2.2, half + 0.0, { r: 0.02 });
  // 驾驶室正面：大灯、格栅、保险杠、踏步
  for (const sx of [-1, 1]) {
    b.box('light', 0.32, 0.18, 0.1, sx * 0.75, 1.0, half - 0.02, { r: 0.03 });
    b.box('trim', 0.42, 0.08, 0.36, sx * 0.85, 0.62, 3.0);
    b.box('trim', 0.08, 0.42, 0.24, sx * 1.15, 1.95, 3.55, { r: 0.03 });
  }
  b.box('trim', 1.1, 0.36, 0.05, 0, 1.15, half + 0.002, { r: 0.03 });
  b.box('trim', 2.1, 0.28, 0.24, 0, 0.62, half - 0.04, { r: 0.05 });
  // 货厢：z −3.8 → 1.85，白色，四周铝边、后卷帘门、侧面护栏
  const bz0 = -half;
  const bz1 = 1.85;
  const bw = 2.3;
  b.box('white', bw, 2.42, bz1 - bz0, 0, 0.95 + 1.21, (bz0 + bz1) / 2, { r: 0.04 });
  for (const y of [0.97, 3.35]) for (const sx of [-1, 1]) b.box('chrome', 0.04, 0.08, bz1 - bz0, sx * (bw / 2 + 0.01), y, (bz0 + bz1) / 2);
  for (const z of [bz0 + 0.03, bz1 - 0.03]) for (const sx of [-1, 1]) b.box('chrome', 0.06, 2.42, 0.06, sx * (bw / 2), 2.16, z);
  for (let k = 0; k < 9; k++) b.box('chrome', bw - 0.12, 0.02, 0.012, 0, 1.15 + k * 0.25, bz0 - 0.008);
  b.box('trim', 0.2, 0.04, 0.03, 0, 1.2, bz0 - 0.02);
  for (const sx of [-1, 1]) {
    b.box('tail', 0.12, 0.3, 0.05, sx * 1.02, 1.25, bz0 - 0.01, { r: 0.02 });
    for (let k = 0; k < 4; k++) b.box('amber', 0.04, 0.06, 0.08, sx * (bw / 2 + 0.02), 1.0, bz1 - 0.4 - k * 1.6);
    // 侧护栏
    b.box('chrome', 0.04, 0.06, 2.6, sx * 1.0, 0.65, -0.2);
    b.box('chrome', 0.04, 0.06, 2.6, sx * 1.0, 0.42, -0.2);
  }
  // 车架、油箱、后挡泥板、尾板
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.24, L - 1.4, sx * 0.48, 0.78, -0.3);
  b.cyl('chrome', 0.28, 0.28, 0.9, -0.82, 0.68, 0.7, 'z', 14);
  for (const sx of [-1, 1]) b.box('rubber', 0.5, 0.45, 0.03, sx * 0.85, 0.42, -2.25);
  // 收起的尾板（货厢底下）、车牌
  b.box('trim', bw - 0.1, 0.12, 0.3, 0, 0.62, bz0 - 0.12);
  b.box('plate', 0.5, 0.13, 0.02, 0, 0.82, bz0 - 0.015);
  return b.build();
}

// ---------------- 半挂牵引车 ----------------


/**
 * 长头带卧铺的牵引车：保险杠、高格栅、斜置的发动机盖与翼子板、驾驶室（两扇门、两片式风挡）、
 * 高顶卧铺与导流罩、侧裙板、铝合金油箱、竖直排气管、进气筒、大后视镜、鞍座。原点在鞍座中心。
 */
export function tractor(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const front = SEMI.kingpinToFront;
  const steer = 5.05;
  // 发动机盖：z 4.35 → 6.25，较窄（1.45 米），前端低
  const hoodTop = (z: number) => pw([[4.3, 1.98], [5.2, 1.85], [5.9, 1.68], [6.25, 1.52]], z);
  const hoodHW = (z: number) => 0.74 * (1 - 0.12 * smooth01((z - 5.7) / 0.55));
  const hzs = stations(4.3, 6.25, 0.1, [4.4]);
  loft(
    b,
    hzs.map((z) => tallSection(z, hoodHW(z), 1.05, 1.08, hoodTop(z), 0.22, 0.04, [1.3, 1.6])),
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
    // 翼子板顶面从保险杠一直延伸到驾驶室踏步
    b.box('paint', 0.5, 0.06, 1.9, sx * 0.99, 1.24, 5.2, { r: 0.02 });
  }
  // 驾驶室 + 卧铺：z 0.9 → 4.35；驾驶室顶 3.15，卧铺带导流罩到 4.05
  const cabTop = (z: number) => pw([[0.9, 3.95], [1.4, 4.05], [2.6, 3.95], [3.0, 3.3], [3.3, 3.15], [4.1, 3.08], [4.35, 2.05]], z);
  const cabHW = (z: number) => 1.24 * (1 - 0.05 * smooth01((z - 3.9) / 0.45));
  const levels = [1.4, 2.12, 2.4, 2.75, 2.95, 3.3, 3.62];
  const czs = stations(0.9, 4.35, 0.1, [3.0, 3.3, 3.55, 4.0, 4.05, 4.08, 2.95, 1.7, 1.8, 2.15, 2.6]);
  b.glassY0 = 2.0;
  b.glassY1 = 3.1;
  loft(
    b,
    czs.map((z) => tallSection(z, cabHW(z), 1.12, 1.15, cabTop(z), z < 3.0 ? 0.3 : 0.18, 0.03, levels)),
    (q) => {
      if (q.band <= 2) return 'trim';
      // 两片式风挡：车头上部向后倾斜的面，中间一根立柱
      if (roofBand(q, levels) && q.zc > 4.08 && q.zc < 4.34 && q.yc > 2.1 && q.yc < 3.06 && Math.abs(q.xc) > 0.035) return 'glass';
      if (sideBand(q, levels)) {
        if (inRect(q, { z0: 3.3, z1: 4.0, y0: 2.12, y1: 2.95 })) return 'glass';
        // 卧铺的小侧窗
        if (inRect(q, { z0: 1.7, z1: 2.15, y0: 2.4, y1: 2.75 })) return 'glass';
        if (q.yc < 2.98 && [2.95, 4.05].some((s) => Math.abs(q.zc - s) < 0.013)) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint' },
  );
  // 遮阳檐、车顶示廓灯
  b.box('paint', 2.3, 0.08, 0.32, 0, 3.12, 4.28, { r: 0.03 });
  for (let k = -2; k <= 2; k++) b.box('amber', 0.1, 0.06, 0.06, k * 0.38, 3.18, 4.4);
  // 格栅、保险杠、大灯
  b.box('chrome', 1.2, 0.86, 0.08, 0, 1.08 + 0.43, front - 0.13, { r: 0.04 });
  for (let k = 0; k < 9; k++) b.box('trim', 1.05, 0.03, 0.02, 0, 1.18 + k * 0.08, front - 0.085);
  b.box('chrome', 2.5, 0.34, 0.3, 0, 0.72, front - 0.05, { r: 0.06 });
  for (const sx of [-1, 1]) {
    b.box('light', 0.42, 0.2, 0.3, sx * 0.93, 1.32, front - 0.55, { r: 0.05, ry: sx * 0.35 });
    // 进气筒、后视镜
    b.cyl('chrome', 0.2, 0.2, 1.1, sx * 1.12, 2.1, 4.2, 'y', 14);
    b.box('chrome', 0.06, 0.06, 0.5, sx * 1.42, 2.55, 3.75, { ry: sx * 0.3 });
    b.box('trim', 0.12, 0.62, 0.2, sx * 1.62, 2.55, 3.6, { r: 0.03 });
    // 油箱（铝合金）、踏步、侧裙板
    b.cyl('chrome', 0.33, 0.33, 1.25, sx * 1.02, 0.82, 2.9, 'z', 18);
    for (const zz of [2.32, 3.48]) b.cyl('trim', 0.335, 0.335, 0.06, sx * 1.02, 0.82, zz, 'z', 18);
    b.box('trim', 0.42, 0.06, 0.5, sx * 1.02, 0.5, 3.75);
    b.box('paint', 0.06, 0.72, 1.7, sx * 1.22, 0.86, 1.45, { r: 0.03 });
    // 竖直排气管（卧铺后面）
    b.cyl('chrome', 0.1, 0.1, 2.6, sx * 1.15, 2.6, 0.82, 'y', 12);
    b.cyl('chrome', 0.13, 0.13, 0.9, sx * 1.15, 2.3, 0.82, 'y', 12);
    // 挡泥板
    b.box('rubber', 0.6, 0.6, 0.03, sx * 0.92, 0.5, -1.25);
  }
  // 车架、鞍座、后挡泥板横梁
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.28, 6.0, sx * 0.45, 0.95, 2.0);
  b.box('trim', 1.8, 0.12, 1.3, 0, 1.25, 0);
  b.box('chrome', 0.5, 0.06, 0.5, 0, 1.33, 0);
  b.box('trim', 2.3, 0.12, 0.12, 0, 0.82, -1.25);
  return b.build();
}

// ---------------- 挂车 ----------------

/**
 * 53 英尺挂车（原点在牵引销，向 −Z 延伸到 −15.25）：车厢（车漆按实例着色）、上下铝边、立柱、侧裙板、
 * 支腿、后门框与锁杆、防钻撞横梁、尾灯与侧示廓灯；冷藏挂车前端有冷机、车厢更光滑。
 */
export function trailerVan(reefer: boolean): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const zf = 0.95;
  const zr = -SEMI.kingpinToRear;
  const len = zf - zr;
  const W = 2.6;
  const y0 = 1.22;
  const y1 = 4.1;
  b.box('paint', W, y1 - y0, len, 0, (y0 + y1) / 2, (zf + zr) / 2, { r: 0.06 });
  // 上下铝边
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.04, 0.12, len, sx * (W / 2 + 0.005), y0 + 0.06, (zf + zr) / 2);
    b.box('chrome', 0.04, 0.1, len, sx * (W / 2 + 0.005), y1 - 0.05, (zf + zr) / 2);
    // 立柱（干货厢有，冷藏厢是光滑的）
    if (!reefer) for (let z = zr + 1.2; z < zf - 0.4; z += 1.2) b.box('chrome', 0.03, y1 - y0 - 0.2, 0.06, sx * (W / 2 + 0.01), (y0 + y1) / 2, z);
    // 侧示廓灯
    for (let z = zr + 0.5; z < zf; z += 3.0) b.box('amber', 0.03, 0.06, 0.1, sx * (W / 2 + 0.02), y0 + 0.2, z);
    // 侧裙板（导流）
    b.box('trim', 0.03, 0.6, 7.6, sx * (W / 2 - 0.05), 0.78, -6.6);
  }
  // 后门框、两扇门、锁杆、铰链
  b.box('chrome', W + 0.02, 0.14, 0.08, 0, y1 - 0.07, zr - 0.02);
  b.box('chrome', W + 0.02, 0.14, 0.08, 0, y0 + 0.07, zr - 0.02);
  for (const sx of [-1, 1]) b.box('chrome', 0.1, y1 - y0, 0.08, sx * (W / 2 - 0.05), (y0 + y1) / 2, zr - 0.02);
  b.box('trim', 0.02, y1 - y0 - 0.28, 0.02, 0, (y0 + y1) / 2, zr - 0.035);
  for (const sx of [-1, 1]) {
    for (const xx of [0.32, 0.92]) b.box('chrome', 0.035, y1 - y0 - 0.3, 0.035, sx * xx, (y0 + y1) / 2, zr - 0.05);
    for (const yy of [y0 + 0.5, (y0 + y1) / 2, y1 - 0.5]) b.box('trim', 0.18, 0.08, 0.04, sx * (W / 2 - 0.12), yy, zr - 0.05);
    b.box('tail', 0.14, 0.14, 0.05, sx * 1.0, y0 - 0.12, zr - 0.02, { r: 0.03 });
    b.box('rubber', 0.6, 0.6, 0.03, sx * 0.95, 0.55, -SEMI.kingpinToAxle - 1.25);
  }
  // 防钻撞横梁、车架
  b.box('trim', W - 0.2, 0.14, 0.14, 0, 0.55, zr + 0.25);
  for (const sx of [-1, 1]) b.box('trim', 0.1, 0.45, 0.1, sx * 1.0, 0.8, zr + 0.3);
  for (const sx of [-1, 1]) b.box('trim', 0.12, 0.25, len - 0.4, sx * 0.5, y0 - 0.12, (zf + zr) / 2);
  // 支腿（带底座）、摇把
  for (const sx of [-1, 1]) {
    b.box('trim', 0.14, 0.95, 0.14, sx * 0.85, y0 - 0.5, -2.1);
    b.box('trim', 0.32, 0.06, 0.32, sx * 0.85, 0.06, -2.1);
  }
  b.box('chrome', 0.04, 0.04, 0.4, 0.98, 0.92, -2.25);
  // 前端：冷机或前壁加强
  if (reefer) {
    b.box('white', 2.0, 1.5, 0.66, 0, 3.15, zf + 0.33, { r: 0.08 });
    b.box('trim', 1.5, 0.95, 0.03, 0, 3.15, zf + 0.67);
    for (let k = 0; k < 6; k++) b.box('trim', 1.45, 0.025, 0.02, 0, 2.75 + k * 0.15, zf + 0.69);
    b.box('chrome', 0.5, 0.36, 0.8, -0.9, 0.95, -4.0, { r: 0.04 });
  } else {
    b.box('chrome', W - 0.1, 0.06, 0.04, 0, 2.6, zf + 0.02);
  }
  return b.build();
}

// ---------------- 房车 ----------------

/**
 * A 型自行式房车（像大巴一样的整体车身）：长 11.2、宽 2.55、高 3.75 米；大风挡、一排侧窗、入户门、
 * 下方行李舱门、车顶空调、后爬梯、侧面遮阳篷卷筒、彩条。车身颜色按实例着色（浅色居多）。
 */
export function rvClassA(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const L = 11.2;
  const half = L / 2;
  const axles = [-2.6, 3.4];
  const R = 0.5;
  const top = (z: number) => pw([[-half, 3.25], [-half + 0.25, 3.45], [half - 1.0, 3.45], [half - 0.55, 3.2], [half - 0.15, 2.0], [half, 1.3]], z);
  const hw = (z: number) => 1.275 * (1 - 0.05 * smooth01((z - (half - 0.9)) / 0.9)) * (1 - 0.03 * smooth01((-half + 0.25 - z) / 0.25));
  const levels = [0.62, 0.65, 1.0, 1.25, 1.32, 1.52, 1.55, 1.62, 1.75, 1.82, 1.85, 1.9, 2.38, 2.55, 2.6, 2.65, 3.0, 3.2];
  const keys = [...axles.flatMap((a) => [a - 0.6, a, a + 0.6]), half - 0.6, half - 0.55, half - 0.15, half - 0.12, 2.2, 2.36, 2.8, 2.95, 3.2, 4.6, 0.6, 2.0, -1.6, -0.2, -4.6, -3.4, -3.2, -1.9, -0.6, 0.7];
  const zs = stations(-half, half, 0.14, keys);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.42, arches(axles, R, 0.6, 0.56, z), top(z), 0.28, 0.04, levels));
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
      // 大风挡：车头的斜面，两侧的顶角是车身色的立柱
      if (roofBand(q, levels) && q.zc > half - 0.55 && q.zc < half - 0.12 && q.yc > 1.65) return 'glass';
      if (sideBand(q, levels)) {
        if (windows.some((r) => inRect(q, r))) return 'glass';
        // 入户门（右侧，−X）与门上的小窗
        if (!q.right && inRect(q, door)) return Math.abs(q.yc - 2.1) < 0.28 && Math.abs(q.zc - 2.58) < 0.22 ? 'glass' : 'white';
        // 行李舱门缝
        if (q.yc > 0.65 && q.yc < 1.25 && [-3.2, -1.9, -0.6, 0.7].some((s) => Math.abs(q.zc - s) < 0.013)) return 'trim';
        // 彩条
        if (q.yc > 1.32 && q.yc < 1.52 && q.zc < half - 0.6) return 'accent';
        if (q.yc > 1.55 && q.yc < 1.62 && q.zc < half - 0.6) return 'accent';
        if (q.yc < 0.62) return 'trim';
      }
      return 'paint';
    },
    { rear: 'paint', front: 'paint' },
  );
  // 车头：大灯、格栅、保险杠；车尾：后窗、尾灯、爬梯、备胎罩
  for (const sx of [-1, 1]) {
    b.box('light', 0.42, 0.2, 0.12, sx * 0.85, 1.05, half - 0.03, { r: 0.04, ry: sx * 0.15 });
    b.box('tail', 0.14, 0.55, 0.06, sx * 1.12, 1.25, -half + 0.01, { r: 0.03 });
    b.box('trim', 0.1, 0.6, 0.3, sx * 1.36, 2.65, half - 0.9, { r: 0.04 });
  }
  b.box('trim', 1.1, 0.3, 0.05, 0, 0.98, half + 0.002, { r: 0.04 });
  b.box('trim', 2.4, 0.25, 0.22, 0, 0.62, half - 0.05, { r: 0.06 });
  b.box('glass', 1.7, 0.5, 0.02, 0, 2.6, -half - 0.005, { r: 0.02 });
  b.box('trim', 2.4, 0.22, 0.2, 0, 0.62, -half + 0.05, { r: 0.05 });
  b.box('plate', 0.5, 0.13, 0.02, 0, 0.95, -half - 0.012);
  for (const yy of [0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2]) b.box('chrome', 0.42, 0.03, 0.03, -0.75, yy, -half - 0.06);
  for (const sx of [-1, 1]) b.box('chrome', 0.03, 2.8, 0.03, -0.75 + sx * 0.2, 2.05, -half - 0.06);
  // 车顶：两台空调、天窗通风口、太阳能板
  for (const z of [1.6, -2.4]) b.box('white', 0.75, 0.3, 1.0, 0, 3.6, z, { r: 0.08 });
  b.box('glass', 1.6, 0.03, 1.2, 0, 3.5, -0.4);
  b.box('white', 0.5, 0.12, 0.5, 0.4, 3.53, 3.6, { r: 0.04 });
  // 右侧遮阳篷卷筒
  b.box('white', 0.14, 0.14, 4.6, -1.34, 3.05, -0.4, { r: 0.06 });
  return b.build();
}

/**
 * 拖挂式房车（原点在挂钩球头，向 −Z 延伸到约 −9.6）：A 字形拖杆、液化气罐、电瓶箱、千斤顶、
 * 前端弧形导流面、侧窗、入户门、车顶空调、遮阳篷、串联轴。
 */
export function travelTrailer(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const zf = -1.45;
  const zr = -9.65;
  const top = (z: number) => pw([[zr, 3.0], [zr + 0.2, 3.12], [zf - 0.9, 3.12], [zf - 0.3, 2.65], [zf, 1.6]], z);
  const hw = (z: number) => 1.22 * (1 - 0.06 * smooth01((z - (zf - 0.5)) / 0.5));
  const axles = [-6.05, -6.85];
  const R = 0.36;
  const levels = [0.6, 1.0, 1.18, 1.24, 1.3, 1.75, 1.9, 2.4, 2.45, 2.5, 2.7];
  const zs = stations(zr, zf, 0.14, [...axles.flatMap((a) => [a - 0.45, a, a + 0.45]), zf - 0.3, zf - 0.05, -3.5, -4.25, -3.0, -2.2, -5.5, -4.6, -8.8, -7.6]);
  const sec = zs.map((z) => tallSection(z, hw(z), 0.5, arches(axles, R, 0.42, 0.55, z), top(z), 0.2, 0.03, levels));
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
      // 前端弧面上的横长窗
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
  // A 字形拖杆、球头座、千斤顶、两个液化气罐、电瓶箱
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
  // 车尾：尾灯、保险杠（储物管）、后窗
  for (const sx of [-1, 1]) b.box('tail', 0.16, 0.12, 0.05, sx * 1.0, 0.9, zr - 0.01, { r: 0.02 });
  b.box('chrome', 2.2, 0.12, 0.12, 0, 0.55, zr - 0.02);
  b.box('glass', 1.0, 0.4, 0.02, 0, 2.2, zr - 0.006);
  // 车顶空调、右侧遮阳篷卷筒
  b.box('white', 0.72, 0.28, 0.95, 0, 3.26, -5.2, { r: 0.08 });
  b.box('white', 0.13, 0.13, 4.2, -1.24, 2.72, -5.0, { r: 0.05 });
  return b.build();
}

/** 船拖车（原点在挂钩球头，向 −Z 延伸）：车架、木垫梁、绞盘柱、挡泥板；船单独放在上面 */
export function boatTrailer(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  b.box('trim', 0.12, 0.12, 2.0, 0, 0.45, -0.9);
  for (const sx of [-1, 1]) {
    b.box('chrome', 0.1, 0.12, 5.6, sx * 0.55, 0.45, -4.4);
    b.box('wood', 0.12, 0.1, 3.6, sx * 0.42, 0.62, -4.6);
    // 挡泥板
    const shape = new THREE.Shape();
    shape.absarc(0, 0, 0.42, 0, Math.PI, false);
    shape.lineTo(-0.36, 0);
    shape.absarc(0, 0, 0.36, Math.PI, 0, true);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.26, bevelEnabled: false, curveSegments: 10 });
    g.rotateY(Math.PI / 2);
    g.translate(sx * 0.95 - 0.13, 0.33, -5.0);
    b.part(g, 'white');
  }
  for (const z of [-2.2, -3.8, -5.6, -6.9]) b.box('chrome', 1.2, 0.1, 0.1, 0, 0.45, z);
  // 绞盘柱
  b.box('chrome', 0.1, 0.8, 0.1, 0, 0.85, -1.85);
  b.box('trim', 0.25, 0.2, 0.2, 0, 1.15, -1.75, { r: 0.04 });
  for (const sx of [-1, 1]) b.box('tail', 0.14, 0.1, 0.06, sx * 0.62, 0.55, -7.2);
  const p = b.build();
  return p;
}

/** 小型平板拖车（原点在挂钩球头）：拖杆、平板、网栏、尾门坡板、挡泥板 */
export function utilityTrailer(): { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  b.box('trim', 0.1, 0.1, 1.3, 0, 0.5, -0.6);
  b.box('wood', 1.86, 0.05, 3.0, 0, 0.58, -2.75);
  for (const sx of [-1, 1]) {
    b.box('paint', 0.06, 0.06, 3.0, sx * 0.95, 0.58, -2.75);
    b.box('paint', 0.05, 0.05, 3.0, sx * 0.95, 1.05, -2.75);
    for (let z = -1.3; z >= -4.2; z -= 0.42) b.box('paint', 0.03, 0.46, 0.03, sx * 0.95, 0.82, z);
    b.box('paint', 0.3, 0.06, 0.8, sx * 1.05, 0.72, -3.0, { r: 0.02 });
  }
  b.box('paint', 1.9, 0.05, 0.05, 0, 1.05, -1.25);
  // 尾门坡板（竖起）
  b.box('paint', 1.84, 0.9, 0.05, 0, 1.03, -4.27);
  for (let x = -0.8; x <= 0.81; x += 0.2) b.box('paint', 0.03, 0.86, 0.06, x, 1.03, -4.27);
  for (const sx of [-1, 1]) b.box('tail', 0.12, 0.08, 0.06, sx * 0.85, 0.55, -4.3);
  return b.build();
}

export type { Mat };
