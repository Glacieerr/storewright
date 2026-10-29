import * as THREE from 'three';
import { loft, MeshBuilder, smooth01, stations, type Mat, type QuadInfo, type Section } from './builder';

/**
 * 小船（按常见船型的公开外形和尺寸）：搭接木板的划艇、深 V 船底的开放式快艇（带舷外机）、
 * 带小舱室和桅杆索具的小帆船、皮划艇、浮筒船。原点在龙骨最低点（船中），船头朝 +Z；
 * 吃水线高度见 BOAT_SPEC（放到水面上时 y = 水位 − waterline）。
 * 船体用放样建出外壳；座舱是另一层法线朝内的放样（内壁和舱底），甲板在座舱范围内开口。
 */

type Geo = { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry };

export type BoatKind = 'row' | 'motor' | 'sail' | 'kayak' | 'pontoon';

export const BOAT_SPEC: Record<BoatKind, { length: number; beam: number; waterline: number }> = {
  row: { length: 3.7, beam: 1.4, waterline: 0.2 },
  motor: { length: 6.0, beam: 2.35, waterline: 0.38 },
  sail: { length: 6.4, beam: 2.3, waterline: 0.45 },
  kayak: { length: 4.0, beam: 0.64, waterline: 0.12 },
  pontoon: { length: 7.0, beam: 2.5, waterline: 0.3 },
};

/** 船体外形：沿船长的半宽、龙骨高度、舷边高度、船底斜升（深 V） */
interface HullShape {
  L: number;
  hw: (t: number) => number;
  keel: (t: number) => number;
  sheer: (t: number) => number;
  deadrise: (t: number) => number;
}

/** 硬舭（有折角）的船体截面：龙骨 → V 形船底 → 折角 → 舷侧 → 护舷 → 舷边 → 甲板 */
function hardChine(h: HullShape, z: number): Section {
  const t = Math.min(1, Math.max(0, z / h.L + 0.5));
  const hw = Math.max(0.025, h.hw(t));
  const yk = h.keel(t);
  const ys = h.sheer(t);
  const dr = h.deadrise(t);
  const chine = Math.min(ys - 0.22, yk + dr * hw * 0.9);
  return {
    z,
    pts: [
      [0, yk],
      [hw * 0.45, Math.min(chine, yk + dr * hw * 0.45)],
      [hw * 0.86, chine - 0.01],
      [hw * 0.96, chine + 0.03],
      [hw * 0.99, chine + 0.1],
      [hw, chine + 0.45 * (ys - chine)],
      [hw * 0.996, ys - 0.07],
      [hw * 0.97, ys],
      [hw * 0.88, ys + 0.012],
      [hw * 0.8, ys + 0.006],
      [hw * 0.4, ys + 0.003],
      [0, ys + 0.008],
    ],
  };
}

/** 座舱内壁（法线朝内）：舱底 → 舱底边 → 内壁 → 舷边内沿；最上面一段（舱口）不画 */
function tub(b: MeshBuilder, h: HullShape, z0: number, z1: number, floor: (z: number) => number, inset: number, floorMat: Mat, wallMat: Mat): void {
  const zs = stations(z0, z1, 0.1, []);
  const secs: Section[] = zs.map((z) => {
    const t = Math.min(1, Math.max(0, z / h.L + 0.5));
    const hw = Math.max(0.05, h.hw(t) * inset);
    const yf = floor(z);
    const ys = h.sheer(t) + 0.006;
    return {
      z,
      pts: [
        [0, yf],
        [hw * 0.86, yf],
        [hw * 0.97, yf + 0.1],
        [hw, yf + 0.55 * (ys - yf)],
        [hw, ys],
        [0, ys],
      ],
    };
  });
  loft(b, secs, (q) => (q.band >= 4 ? null : q.band === 0 ? floorMat : wallMat), { rear: wallMat, front: wallMat }, true);
}

/** 沿一串 (x, y, z) 点的栏杆（护栏、扶手），立柱落到 yBase */
function rail(b: MeshBuilder, pts: THREE.Vector3[], r: number, posts: number, yBase: number, mat: Mat = 'chrome'): void {
  b.tube(mat, pts, r, 6);
  for (let i = 0; i < posts; i++) {
    const p = pts[Math.round((i / Math.max(1, posts - 1)) * (pts.length - 1))] as THREE.Vector3;
    b.cyl(mat, r * 0.9, r * 0.9, p.y - yBase, p.x, (p.y + yBase) / 2, p.z, 'y', 6);
  }
}

/** 一块玻璃板：两端点（俯视）、底高与顶高、后倾 */
function pane(b: MeshBuilder, xa: number, za: number, xb: number, zb: number, y0: number, y1: number, rake: number, frame = true): void {
  // 端点按 x 从小到大排，后倾方向在两舷一致（顶边朝船尾 / 朝船内）
  const [x0, z0, x1, z1] = xb >= xa ? [xa, za, xb, zb] : [xb, zb, xa, za];
  const len = Math.hypot(x1 - x0, z1 - z0);
  const place = (g: THREE.BufferGeometry) => {
    g.rotateX(-rake);
    g.rotateY(Math.atan2(-(z1 - z0), x1 - x0));
    g.translate((x0 + x1) / 2, y0, (z0 + z1) / 2);
    return g;
  };
  b.part(place(new THREE.BoxGeometry(len, y1 - y0, 0.02).translate(0, (y1 - y0) / 2, 0)), 'glass');
  if (frame) b.part(place(new THREE.BoxGeometry(len + 0.02, 0.025, 0.035).translate(0, y1 - y0, 0)), 'chrome');
}

/** 舷外机：机罩、支架、竖直的尾轴、防空泡板和螺旋桨；z 为船尾板位置 */
function outboard(b: MeshBuilder, z: number, yTop: number, yKeel: number, size = 1, mat: Mat = 'trim'): void {
  const s = size;
  b.box(mat, 0.46 * s, 0.62 * s, 0.62 * s, 0, yTop + 0.18 * s, z - 0.36 * s, { r: 0.12 * s });
  b.box('white', 0.48 * s, 0.04, 0.64 * s, 0, yTop - 0.1 * s, z - 0.36 * s, { r: 0.015 });
  b.box(mat, 0.2 * s, 0.24 * s, 0.24 * s, 0, yTop - 0.24 * s, z - 0.18 * s);
  b.box(mat, 0.12 * s, yTop - 0.3 * s - (yKeel - 0.22 * s), 0.18 * s, 0, (yTop - 0.3 * s + yKeel - 0.22 * s) / 2, z - 0.42 * s, { r: 0.04 * s });
  b.box(mat, 0.34 * s, 0.025, 0.42 * s, 0, yKeel + 0.05 * s, z - 0.46 * s);
  b.cyl('chrome', 0.05 * s, 0.05 * s, 0.22 * s, 0, yKeel - 0.1 * s, z - 0.62 * s, 'z', 8);
  for (let k = 0; k < 3; k++) b.box('chrome', 0.03, 0.34 * s, 0.07 * s, 0, yKeel - 0.1 * s, z - 0.72 * s, { rz: (k * Math.PI * 2) / 3 });
}

// ---------------- 开放式快艇 ----------------

const MOTOR: HullShape = {
  L: 6.0,
  hw: (t) => 1.175 * (t <= 0.45 ? 0.9 + 0.1 * smooth01(t / 0.45) : Math.max(0.02, 1 - Math.pow((t - 0.45) / 0.55, 2.1))),
  keel: (t) => 0.62 * Math.pow(smooth01((t - 0.55) / 0.45), 1.4),
  sheer: (t) => 1.1 + 0.3 * Math.pow(smooth01((t - 0.5) / 0.5), 1.5) - 0.03 * smooth01((0.15 - t) / 0.15),
  deadrise: (t) => 0.36 + 0.5 * smooth01((t - 0.55) / 0.45),
};

/** 开放式快艇（6 米、船宽 2.35 米）：深 V 船底、环绕式风挡、驾驶台、船头沙发、后排长椅、游泳平台、舷外机、船头护栏 */
export function bowrider(): Geo {
  const b = new MeshBuilder();
  const h = MOTOR;
  const zOpen0 = -2.35;
  const zOpen1 = 2.3;
  const zs = stations(-3.0, 3.0, 0.1, [zOpen0, zOpen1]);
  b.glassY0 = 1.1;
  b.glassY1 = 1.6;
  const classify = (q: QuadInfo): Mat | null => {
    if (q.band <= 2) return 'white';
    if (q.band === 3) return 'trim';
    if (q.band <= 5) return 'paint';
    if (q.band === 6) return 'chrome';
    if (q.band <= 8) return 'white';
    // 甲板：座舱范围内开口，其余是白色甲板
    if (q.zc > zOpen0 && q.zc < zOpen1) return null;
    return 'white';
  };
  loft(
    b,
    zs.map((z) => hardChine(h, z)),
    classify,
    { rear: 'white', front: 'white' },
  );
  const floor = (z: number) => Math.max(0.46, h.keel(z / h.L + 0.5) + 0.42);
  tub(b, h, zOpen0, zOpen1, floor, 0.8, 'deck', 'white');
  const sh = (z: number) => h.sheer(z / h.L + 0.5);
  const hwz = (z: number) => h.hw(z / h.L + 0.5);
  // 环绕式风挡：中间留出通往船头的通道
  const zw = 0.7;
  const yw = sh(zw);
  const wpts: Array<[number, number]> = [
    [0.28, zw + 0.05],
    [0.62, zw],
    [0.92, zw - 0.18],
    [hwz(zw - 0.42) * 0.86, zw - 0.42],
  ];
  for (const sx of [-1, 1]) {
    for (let i = 1; i < wpts.length; i++) {
      const [x0, z0] = wpts[i - 1] as [number, number];
      const [x1, z1] = wpts[i] as [number, number];
      pane(b, sx * x0, z0, sx * x1, z1, yw, yw + 0.36, 0.45);
    }
  }
  // 驾驶台（右舷，−X）与左舷台、方向盘、仪表
  const yf = floor(0);
  b.box('white', 0.62, yw - yf + 0.02, 0.55, -0.55, (yw + yf) / 2, 0.38, { r: 0.05 });
  b.box('white', 0.55, yw - yf + 0.02, 0.5, 0.55, (yw + yf) / 2, 0.4, { r: 0.05 });
  b.box('trim', 0.5, 0.04, 0.3, -0.55, yw + 0.03, 0.3, { rx: 0.4 });
  b.cyl('trim', 0.17, 0.17, 0.03, -0.55, yw - 0.02, 0.06, 'z', 18);
  b.cyl('chrome', 0.025, 0.025, 0.18, -0.55, yw - 0.02, 0.15, 'z', 6);
  // 座椅：两把驾驶座、后排长椅、船头 U 形沙发
  for (const sx of [-1, 1]) {
    b.box('cushion', 0.5, 0.18, 0.5, sx * 0.55, yf + 0.42, -0.55, { r: 0.07 });
    b.box('cushion', 0.5, 0.5, 0.14, sx * 0.55, yf + 0.72, -0.82, { r: 0.07, rx: -0.12 });
    b.box('white', 0.36, 0.33, 0.36, sx * 0.55, yf + 0.17, -0.55, { r: 0.04 });
    b.box('cushion', 0.4, 0.3, 1.2, sx * (hwz(1.6) * 0.8 - 0.22), yf + 0.3, 1.62, { r: 0.07 });
    b.box('cushion', 0.12, 0.32, 1.2, sx * (hwz(1.6) * 0.8 - 0.04), yf + 0.6, 1.62, { r: 0.05 });
  }
  b.box('cushion', 2 * hwz(-2) * 0.8 - 0.1, 0.32, 0.55, 0, yf + 0.3, -1.95, { r: 0.08 });
  b.box('cushion', 2 * hwz(-2) * 0.8 - 0.1, 0.5, 0.14, 0, yf + 0.68, -2.25, { r: 0.07, rx: 0.15 });
  b.box('cushion', 1.0, 0.3, 0.45, 0, floor(2.1) + 0.3, 2.12, { r: 0.08 });
  // 游泳平台、舷外机、船头护栏、航行灯、系缆桩
  b.box('deck', 1.7, 0.08, 0.4, 0, 0.55, -3.18, { r: 0.03 });
  outboard(b, -3.05, sh(-3) - 0.05, 0.02, 1.05);
  for (const sx of [-1, 1]) {
    const pts = [1.5, 2.1, 2.55, 2.85].map((z) => new THREE.Vector3(sx * Math.max(0.05, hwz(z) * 0.86), sh(z) + 0.4, z));
    rail(b, pts, 0.016, 3, sh(2.2));
    b.box(sx > 0 ? 'tail' : 'light', 0.04, 0.06, 0.1, sx * hwz(2.5) * 0.97, sh(2.5) - 0.06, 2.5, { color: sx > 0 ? new THREE.Color('#d0302a') : new THREE.Color('#2fae5a') });
    b.box('chrome', 0.05, 0.04, 0.16, sx * hwz(-2.6) * 0.9, sh(-2.6) + 0.03, -2.6);
  }
  return b.build();
}

// ---------------- 划艇 ----------------

const ROW: HullShape = {
  L: 3.7,
  hw: (t) => 0.7 * (t <= 0.42 ? 0.62 + 0.38 * Math.sin((t / 0.42) * (Math.PI / 2)) : Math.max(0.02, 1 - Math.pow((t - 0.42) / 0.58, 2.0))),
  keel: (t) => 0.1 * Math.pow(Math.abs(t - 0.45) / 0.55, 2.4) + 0.18 * Math.pow(smooth01((t - 0.75) / 0.25), 2),
  sheer: (t) => 0.56 + 0.16 * Math.pow((t - 0.45) / 0.55, 2),
  deadrise: () => 0.2,
};

/** 搭接木板的划艇截面：U 形船底，每块船板的下沿压在下一块外面（台阶） */
function lapstrake(h: HullShape, z: number, inset = 0): Section {
  const t = Math.min(1, Math.max(0, z / h.L + 0.5));
  const hw = Math.max(0.02, h.hw(t) - inset);
  const yk = h.keel(t) + inset;
  const ys = h.sheer(t);
  const planks = 6;
  const pts: Array<[number, number]> = [[0, yk]];
  for (let k = 1; k <= planks; k++) {
    const a = (k / planks) * (Math.PI / 2);
    const x = hw * Math.pow(Math.sin(a), 0.62);
    const y = yk + (ys - yk) * (1 - Math.pow(Math.cos(a), 1.25));
    if (k < planks && inset === 0) {
      // 搭接台阶：上一块板的下沿在外侧
      pts.push([x, y], [x + 0.014, y + 0.004]);
    } else pts.push([x, y]);
  }
  pts.push([hw * 0.88, ys + 0.02], [0, ys + 0.02]);
  return { z, pts };
}

/** 划艇（3.7 米）：搭接木板船壳、木质内壳、三道坐板、桨架、两支桨 */
export function rowboat(): Geo {
  const b = new MeshBuilder();
  const h = ROW;
  const zs = stations(-1.85, 1.85, 0.08, []);
  // 截面的段：0–10 是六块船板和五道搭接台阶，11 是舷边（木色），12 是开口
  loft(
    b,
    zs.map((z) => lapstrake(h, z)),
    (q) => {
      // 最上面一块船板（舷板）白色，其余按实例着色
      if (q.band >= 12) return null;
      if (q.band === 11) return 'wood';
      if (q.band >= 9) return 'white';
      return 'paint';
    },
    { rear: 'paint' },
  );
  // 内壳（木色）
  const ins = zs.filter((z) => z > -1.8 && z < 1.62);
  loft(
    b,
    ins.map((z) => lapstrake(h, z, 0.035)),
    (q) => (q.band >= 6 ? null : 'wood'),
    { rear: 'wood', front: 'wood' },
    true,
  );
  const sh = (z: number) => h.sheer(z / h.L + 0.5);
  const hwz = (z: number) => h.hw(z / h.L + 0.5);
  for (const z of [-1.15, 0.05, 0.95]) b.box('wood', 2 * hwz(z) - 0.1, 0.035, 0.24, 0, sh(z) - 0.2, z);
  for (const sx of [-1, 1]) {
    b.tube('wood', [-1.82, -1.0, 0, 1.0, 1.7].map((z) => new THREE.Vector3(sx * Math.max(0.04, hwz(z) + 0.01), sh(z) + 0.03, z)), 0.028, 5);
    b.box('chrome', 0.03, 0.09, 0.03, sx * (hwz(0.35) + 0.01), sh(0.35) + 0.09, 0.35);
    // 桨：放在船里，桨叶朝船尾
    const g = new THREE.CylinderGeometry(0.022, 0.022, 2.3, 6);
    g.rotateX(Math.PI / 2);
    g.rotateY(sx * 0.07);
    g.translate(sx * 0.28, sh(0) - 0.12, 0.05);
    b.part(g, 'wood');
    b.box('wood', 0.13, 0.015, 0.5, sx * (0.28 + 0.08), sh(0) - 0.12, -1.05, { ry: sx * 0.07 });
  }
  b.box('wood', 0.05, 0.08, 3.5, 0, h.keel(0.45) - 0.03, -0.05);
  return b.build();
}

// ---------------- 小帆船 ----------------

const SAIL: HullShape = {
  L: 6.4,
  hw: (t) => 1.15 * (t <= 0.45 ? 0.82 + 0.18 * smooth01(t / 0.45) : Math.max(0.02, 1 - Math.pow((t - 0.45) / 0.55, 1.8))),
  keel: (t) => 0.42 * Math.pow(smooth01((t - 0.6) / 0.4), 1.6),
  sheer: (t) => 1.05 + 0.22 * Math.pow(smooth01((t - 0.5) / 0.5), 1.6) + 0.05 * smooth01((0.2 - t) / 0.2),
  deadrise: (t) => 0.3 + 0.3 * smooth01((t - 0.6) / 0.4),
};

/** 小帆船（6.4 米）：白色船体与彩色舷条、小舱室（舷窗）、尾部座舱、桅杆与吊杆、卷起的主帆和前帆、支索、舵与舵柄 */
export function sailboat(): Geo {
  const b = new MeshBuilder();
  const h = SAIL;
  const zC0 = -2.75;
  const zC1 = -0.45;
  const zs = stations(-3.2, 3.2, 0.1, [zC0, zC1]);
  loft(
    b,
    zs.map((z) => hardChine(h, z)),
    (q) => {
      if (q.band <= 1) return 'white';
      if (q.band === 2) return 'navy';
      if (q.band === 3) return 'white';
      if (q.band === 4) return 'paint';
      if (q.band <= 7) return 'white';
      if (q.zc > zC0 && q.zc < zC1) return null;
      return q.band >= 9 ? 'deck' : 'white';
    },
    { rear: 'white', front: 'white' },
  );
  const sh = (z: number) => h.sheer(z / h.L + 0.5);
  const hwz = (z: number) => h.hw(z / h.L + 0.5);
  const yf = sh(-1.6) - 0.5;
  tub(b, h, zC0, zC1, () => yf, 0.8, 'deck', 'white');
  // 小舱室：圆角的舱顶、舷窗、舱口
  const yc = sh(0.8);
  b.box('white', 1.5, 0.42, 2.0, 0, yc + 0.2, 0.55, { r: 0.12 });
  b.box('deck', 1.3, 0.04, 1.7, 0, yc + 0.42, 0.55, { r: 0.02 });
  for (const sx of [-1, 1]) for (const z of [0.1, 0.65, 1.15]) b.box('glass', 0.02, 0.1, 0.26, sx * 0.755, yc + 0.24, z, { r: 0.008 });
  b.box('trim', 0.5, 0.3, 0.04, 0, yc + 0.18, -0.46);
  // 桅杆、吊杆（卷起的主帆和帆罩）、前帆卷在前支索上
  const zm = 1.0;
  const ym = yc + 0.42;
  const top = ym + 7.4;
  b.cyl('alu', 0.06, 0.05, top - ym, 0, (ym + top) / 2, zm, 'y', 10);
  b.box('alu', 1.5, 0.04, 0.05, 0, ym + 4.2, zm);
  const yb = ym + 0.95;
  b.cyl('alu', 0.045, 0.045, 3.4, 0, yb, zm - 1.7, 'z', 8);
  b.cyl('navy', 0.13, 0.11, 3.1, 0, yb + 0.12, zm - 1.6, 'z', 10);
  const bow = new THREE.Vector3(0, sh(3.1) + 0.05, 3.1);
  const mastTop = new THREE.Vector3(0, top - 0.2, zm);
  b.tube('trim', [bow, mastTop], 0.008, 4);
  const stay = bow.distanceTo(mastTop);
  const jib = new THREE.CylinderGeometry(0.03, 0.065, stay * 0.8, 8);
  jib.translate(0, stay * 0.42, 0);
  jib.rotateX(Math.PI / 2);
  jib.lookAt(new THREE.Vector3().subVectors(mastTop, bow));
  b.part(jib.translate(bow.x, bow.y, bow.z), 'canvas');
  // 侧支索（经过撑臂）、后支索
  for (const sx of [-1, 1]) {
    const chain = new THREE.Vector3(sx * hwz(zm - 0.1) * 0.95, sh(zm - 0.1), zm - 0.1);
    const spreader = new THREE.Vector3(sx * 0.74, ym + 4.2, zm);
    b.tube('trim', [chain, spreader, new THREE.Vector3(0, top - 0.3, zm)], 0.006, 3);
  }
  b.tube('trim', [new THREE.Vector3(0, top, zm), new THREE.Vector3(0, sh(-3.1) + 0.1, -3.15)], 0.006, 3);
  // 舵、舵柄、船头护栏
  b.box('white', 0.05, 1.1, 0.45, 0, sh(-3.2) - 0.45, -3.35, { r: 0.02 });
  b.box('wood', 0.05, 0.05, 1.1, 0, sh(-3.2) + 0.05, -2.75, { rx: -0.1 });
  for (const sx of [-1, 1]) rail(b, [2.2, 2.7, 3.05].map((z) => new THREE.Vector3(sx * Math.max(0.05, hwz(z) * 0.85), sh(z) + 0.55, z)), 0.014, 3, sh(2.6));
  // 龙骨（水下的鳍龙骨）
  b.box('navy', 0.12, 0.7, 1.1, 0, -0.32, 0.2, { r: 0.05 });
  return b.build();
}

// ---------------- 皮划艇 ----------------

const KAYAK: HullShape = {
  L: 4.0,
  hw: (t) => 0.32 * Math.max(0.03, Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.65)),
  keel: (t) => 0.1 * Math.pow(Math.abs(t - 0.5) * 2, 2.4),
  sheer: (t) => 0.24 + 0.06 * Math.pow(Math.abs(t - 0.5) * 2, 2),
  deadrise: () => 0.4,
};

/** 皮划艇（4 米）：尖头尖尾、隆起的甲板、座舱口、甲板弹力绳、双叶桨 */
export function kayak(): Geo {
  const b = new MeshBuilder();
  const h = KAYAK;
  const zs = stations(-2.0, 2.0, 0.08, []);
  const sec = (z: number): Section => {
    const t = Math.min(1, Math.max(0, z / h.L + 0.5));
    const hw = h.hw(t);
    const yk = h.keel(t);
    const ys = h.sheer(t);
    const crown = 0.1 * Math.sin(Math.PI * t);
    return {
      z,
      pts: [
        [0, yk],
        [hw * 0.55, yk + 0.05],
        [hw * 0.92, yk + 0.12],
        [hw, ys - 0.04],
        [hw * 0.97, ys],
        [hw * 0.6, ys + crown * 0.75],
        [0, ys + crown],
      ],
    };
  };
  loft(
    b,
    zs.map(sec),
    (q) => {
      if (q.band === 3) return 'trim';
      // 座舱口（椭圆）
      if (q.band >= 4 && Math.pow(q.xc / 0.23, 2) + Math.pow((q.zc + 0.05) / 0.42, 2) < 1) return 'trim';
      return 'paint';
    },
    {},
  );
  b.tube(
    'trim',
    Array.from({ length: 17 }, (_, k) => {
      const a = (k / 16) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * 0.24, sec(-0.05).pts[6]?.[1] ?? 0.3, -0.05 + Math.sin(a) * 0.43);
    }),
    0.018,
    5,
  );
  b.box('trim', 0.34, 0.2, 0.05, 0, 0.34, -0.38, { rx: -0.2 });
  for (const z of [0.75, 1.05, -0.85]) {
    const t = z / h.L + 0.5;
    const y = h.sheer(t) + 0.1 * Math.sin(Math.PI * t);
    b.tube('trim', [new THREE.Vector3(-h.hw(t) * 0.9, y - 0.03, z - 0.12), new THREE.Vector3(0, y + 0.01, z), new THREE.Vector3(h.hw(t) * 0.9, y - 0.03, z + 0.12)], 0.006, 3);
  }
  // 双叶桨横放在座舱前
  b.cyl('alu', 0.016, 0.016, 2.2, 0, 0.42, 0.45, 'x', 6);
  for (const sx of [-1, 1]) b.box('trim', 0.42, 0.01, 0.16, sx * 1.15, 0.42, 0.45, { r: 0.004 });
  return b.build();
}

// ---------------- 浮筒船 ----------------

/** 浮筒船（7 米）：两根铝合金浮筒、平台甲板、四周护栏板（彩色腰带）、遮阳篷、驾驶台、沙发、舷外机 */
export function pontoon(): Geo {
  const b = new MeshBuilder();
  const L = 7.0;
  for (const sx of [-1, 1]) {
    b.cyl('alu', 0.32, 0.32, L - 1.0, sx * 0.82, 0.32, -0.4, 'z', 16);
    const nose = new THREE.ConeGeometry(0.32, 1.1, 16);
    nose.rotateX(Math.PI / 2);
    nose.scale(1, 1, 1);
    nose.translate(sx * 0.82, 0.32, L / 2 - 0.85);
    b.part(nose, 'alu');
    b.cyl('alu', 0.32, 0.32, 0.02, sx * 0.82, 0.32, -L / 2 + 0.1, 'z', 16);
  }
  for (let z = -3.0; z <= 2.6; z += 0.8) b.box('trim', 2.2, 0.08, 0.1, 0, 0.66, z);
  b.box('deck', 2.5, 0.08, 6.4, 0, 0.74, -0.15, { r: 0.03 });
  // 护栏板：下半是实例颜色的腰带，上半白色，顶部扶手；船头有门
  const yd = 0.78;
  for (const sx of [-1, 1]) {
    b.box('paint', 0.04, 0.32, 5.6, sx * 1.23, yd + 0.2, -0.35);
    b.box('white', 0.04, 0.42, 5.6, sx * 1.23, yd + 0.57, -0.35);
    b.box('chrome', 0.06, 0.04, 5.6, sx * 1.23, yd + 0.8, -0.35);
    b.box('paint', 0.8, 0.32, 0.04, sx * 0.85, yd + 0.2, 2.45);
    b.box('white', 0.8, 0.42, 0.04, sx * 0.85, yd + 0.57, 2.45);
    b.box('paint', 0.8, 0.32, 0.04, sx * 0.85, yd + 0.2, -3.15);
    b.box('white', 0.8, 0.42, 0.04, sx * 0.85, yd + 0.57, -3.15);
    // 沿护栏的沙发
    b.box('cushion', 0.5, 0.36, 2.0, sx * 0.94, yd + 0.18, 1.2, { r: 0.07 });
    b.box('cushion', 0.12, 0.42, 2.0, sx * 1.14, yd + 0.5, 1.2, { r: 0.05 });
  }
  b.box('cushion', 1.9, 0.36, 0.5, 0, yd + 0.18, -2.75, { r: 0.07 });
  // 驾驶台、风挡
  b.box('white', 0.6, 0.9, 0.62, -0.75, yd + 0.45, -0.3, { r: 0.06 });
  pane(b, -1.02, -0.02, -0.48, -0.02, yd + 0.9, yd + 1.15, 0.35);
  b.box('cushion', 0.5, 0.4, 0.5, -0.75, yd + 0.2, -1.05, { r: 0.07 });
  // 遮阳篷：四根支架、篷布
  for (const sx of [-1, 1]) for (const z of [-1.6, 0.6]) b.cyl('chrome', 0.02, 0.02, 1.25, sx * 1.15, yd + 1.42, z, 'y', 6);
  b.box('navy', 2.45, 0.06, 2.6, 0, yd + 2.05, -0.5, { r: 0.03 });
  outboard(b, -3.25, yd + 0.05, 0.05, 1.1, 'white');
  return b.build();
}

const cache = new Map<BoatKind, Geo>();

export function boatGeometry(kind: BoatKind): Geo {
  let g = cache.get(kind);
  if (!g) {
    g = kind === 'row' ? rowboat() : kind === 'motor' ? bowrider() : kind === 'sail' ? sailboat() : kind === 'kayak' ? kayak() : pontoon();
    cache.set(kind, g);
  }
  return g;
}
