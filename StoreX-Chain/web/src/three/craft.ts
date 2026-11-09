import * as THREE from 'three';
import { box, cyl, merge, wheel, type Part } from '../../../../StoreX/web/src/three/models';

/**
 * 船和飞机（原点在中心、头朝 +x，米）：
 * - 集装箱船（长 280 米、宽 40 米）：尖船首的船体（水线以下红色防污漆）、船尾的驾驶楼和烟囱、一排排 40 尺箱位；
 * - 别家的集装箱船（港口的船期）：按船长、船宽、贝位数生成，支线船到大型船几种尺寸，甲板上的箱由港口作业动画画；
 * - 拖轮：班轮进出港的最后 / 最初一段，两条拖轮在船的外侧护航；港口的船期里拖轮顶推、拖带别家的船靠离泊；
 * - 双发宽体货机：后掠的机翼、两台发动机、平尾、垂尾、侧面的货舱门、起落架；
 * - 机坪的地勤车：升降平台车、行李拖车和板车。
 */
const PALETTE = ['#c0392b', '#2471a3', '#1e8449', '#d35400', '#7d3c98', '#566573', '#a04000', '#2e86c1', '#f0b27a', '#16a085'];

function rnd(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** 平面形状（x 向前、z 向右）往上拉成柱体：y 从 y0 到 y1；侧面一种颜色，顶面一种颜色 */
function hull(shape: THREE.Shape, y0: number, y1: number, side: string, top = side): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  g.computeVertexNormals();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const cs = new THREE.Color(side);
  const ct = new THREE.Color(top);
  for (let i = 0; i < pos.count; i++) {
    const c = (nor.getY(i) as number) > 0.5 ? ct : cs;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  return g;
}

/** 集装箱船；cargo = false 时只有船体（本店班轮甲板上的箱由港口作业动画一个个画，卸一个少一个） */
export function containerShip(cargo = true): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-140, -20);
  s.lineTo(100, -20);
  s.quadraticCurveTo(138, -16, 146, 0);
  s.quadraticCurveTo(138, 16, 100, 20);
  s.lineTo(-140, 20);
  s.quadraticCurveTo(-146, 0, -140, -20);
  // 水线以下红色防污漆，以上深蓝，甲板灰色
  const parts: Part[] = [hull(s, -12, -1.2, '#9d2b22'), hull(s, -1.2, 5, '#1f3550', '#5f6469')];
  // 船首楼、船尾的驾驶楼（白色，带一圈窗）、驾驶台两翼、烟囱
  parts.push(box(20, 3, 30, '#1f3550', 122, 5, 0));
  parts.push(box(16, 24, 34, '#eef1f3', -110, 5, 0), box(16.2, 1.6, 34.2, '#26313c', -110, 26, 0), box(16.2, 1.2, 34.2, '#26313c', -110, 20, 0), box(6, 2, 44, '#eef1f3', -104, 27.2, 0));
  parts.push(box(9, 14, 10, '#d6d9dc', -126, 21, 0), box(9.2, 3, 10.2, '#c0392b', -126, 33, 0));
  // 箱位：每 13.2 米一排 40 尺箱，横向 14 列，堆 3–6 层；排与排之间是绑扎桥
  const r = rnd(41);
  for (let i = 0; i < 16; i++) {
    if (!cargo) {
      // 只画舱盖板和绑扎桥
      const x = -92 + i * 13.2;
      parts.push(box(12.6, 0.8, i > 13 ? 26 : 35, '#6b7177', x, 5, 0), box(0.6, 7, i > 13 ? 26 : 35, '#8a9096', x + 6.6, 5, 0));
      continue;
    }
    const x = -92 + i * 13.2;
    const width = i > 13 ? 26 : 35;
    const blocks = 5;
    for (let k = 0; k < blocks; k++) {
      const z = -width / 2 + (k + 0.5) * (width / blocks);
      const tiers = 3 + Math.floor(r() * 4);
      parts.push(box(12.2, 2.6 * tiers, width / blocks - 0.3, PALETTE[Math.floor(r() * PALETTE.length)] as string, x, 5, z));
    }
    parts.push(box(0.6, 7, width, '#8a9096', x + 6.6, 5, 0));
  }
  parts.push(cyl(0.4, 0.4, 14, '#d6d9dc', 124, 8, 0, 6));
  return merge(parts);
}

/**
 * 别家的集装箱船（港口自己排的船期：支线船、中型、大型几种尺寸）：船长、船宽、甲板上几个 40 尺贝位、每贝几列。
 * 船体、驾驶楼和烟囱按尺寸生成；甲板上只有舱盖板和绑扎桥，箱由港口作业动画一个个画（卸一个少一个、装一个多一个）。
 */
export interface HullSpec {
  len: number;
  beam: number;
  bays: number;
  rows: number;
  /** 水线以上的船体、驾驶楼、烟囱色带 */
  hull: string;
  house: string;
  band: string;
}

/** 船体的平面形状（船中为原点，船首朝 +x）：首部那一段收窄 */
function hullShape(len: number, beam: number): THREE.Shape {
  const h = len / 2;
  const w = beam / 2;
  const xn = h - 0.16 * len;
  const s = new THREE.Shape();
  s.moveTo(-h + 6, -w);
  s.lineTo(xn, -w);
  s.quadraticCurveTo(h - 0.03 * len, -0.8 * w, h, 0);
  s.quadraticCurveTo(h - 0.03 * len, 0.8 * w, xn, w);
  s.lineTo(-h + 6, w);
  s.quadraticCurveTo(-h, 0, -h + 6, -w);
  return s;
}

/** 驾驶楼的位置和尺寸（船尾） */
function houseOf(s: HullSpec): { x: number; len: number; h: number } {
  const k = s.len / 292;
  return { x: -s.len / 2 + 0.12 * s.len, len: 10 + 6 * k, h: 14 + 10 * k };
}

/** 甲板箱位（船的本地坐标）：每个贝的中心 x、这个贝能放几列（船首收窄的地方少几列）；舱盖板顶面 y = 5.8 */
export function hullBays(s: HullSpec): { x: number; rows: number }[] {
  const h = s.len / 2;
  const w = s.beam / 2;
  const hs = houseOf(s);
  const x0 = hs.x + hs.len / 2 + 4 + 6.6;
  const xn = h - 0.16 * s.len;
  const cx = h - 0.03 * s.len;
  const out: { x: number; rows: number }[] = [];
  for (let i = 0; i < s.bays; i++) {
    const x = x0 + i * 13.2;
    const fwd = x + 6.3;
    let hw = w;
    if (fwd > xn) {
      // 首部的二次曲线：按 x 二分出曲线参数，再取那里的半宽
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 30; k++) {
        const u = (lo + hi) / 2;
        const xu = (1 - u) * (1 - u) * xn + 2 * u * (1 - u) * cx + u * u * h;
        if (xu < fwd) lo = u;
        else hi = u;
      }
      const u = (lo + hi) / 2;
      hw = (1 - u) * (1 - u) * w + 2 * u * (1 - u) * 0.8 * w;
    }
    out.push({ x, rows: Math.max(0, Math.min(s.rows, Math.floor((2 * hw - 1.5) / 2.6))) });
  }
  return out;
}

/** 别家的集装箱船：船体（水线以下红色防污漆）、首楼、船尾的驾驶楼和烟囱、舱盖板和绑扎桥（不带箱） */
export function boxShip(s: HullSpec): THREE.BufferGeometry {
  const shape = hullShape(s.len, s.beam);
  const h = s.len / 2;
  const parts: Part[] = [hull(shape, -10, -1.2, '#9d2b22'), hull(shape, -1.2, 5, s.hull, '#5f6469')];
  // 首楼、船首的桅杆
  parts.push(box(0.07 * s.len, 3, s.beam * 0.62, s.hull, h - 0.075 * s.len, 5, 0), box(0.07 * s.len - 0.6, 0.12, s.beam * 0.62 - 0.6, '#5f6469', h - 0.075 * s.len, 8, 0), cyl(0.35, 0.35, 12, '#d6d9dc', h - 0.05 * s.len, 8, 0, 6));
  // 驾驶楼（一圈窗带）、驾驶台两翼、烟囱（顶上一道色带）
  const hs = houseOf(s);
  const bw = s.beam - 6;
  parts.push(box(hs.len, hs.h, bw, s.house, hs.x, 5, 0), box(hs.len + 0.2, 1.5, bw + 0.2, '#26313c', hs.x, 5 + hs.h - 3.4, 0), box(hs.len + 0.2, 1.1, bw + 0.2, '#26313c', hs.x, 5 + hs.h - 8, 0));
  parts.push(box(5, 1.8, s.beam + 3, s.house, hs.x + hs.len / 2 - 2.5, 5 + hs.h - 2.6, 0));
  const fk = 0.6 + 0.4 * (s.len / 292);
  parts.push(box(8 * fk, 12 * fk, 9 * fk, '#d6d9dc', hs.x - hs.len / 2 - 4 * fk, 5 + hs.h - 8 * fk, 0), box(8.2 * fk, 2.6 * fk, 9.2 * fk, s.band, hs.x - hs.len / 2 - 4 * fk, 5 + hs.h + 1.4 * fk, 0));
  // 舱盖板（每贝一块）和贝与贝之间的绑扎桥
  for (const b of hullBays(s)) {
    if (b.rows <= 0) continue;
    const w = b.rows * 2.6 + 1;
    parts.push(box(12.6, 0.8, w, '#6b7177', b.x, 5, 0), box(0.6, 6.5, w, '#8a9096', b.x + 6.6, 5, 0));
  }
  return merge(parts);
}

export function tug(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-13, -4.5);
  s.lineTo(7, -4.5);
  s.quadraticCurveTo(13, -3.5, 14, 0);
  s.quadraticCurveTo(13, 3.5, 7, 4.5);
  s.lineTo(-13, 4.5);
  s.lineTo(-13, -4.5);
  return merge([hull(s, -3, -0.6, '#2b2b2b'), hull(s, -0.6, 2.2, '#c0392b', '#8a8f94'), box(9, 4, 7, '#f2f2ef', 0, 2.2, 0), box(9.2, 0.9, 7.2, '#26313c', 0, 4.6, 0), box(4, 2.5, 5, '#f2f2ef', 1, 6.2, 0), cyl(0.25, 0.25, 6, '#d6d9dc', -1, 8.7, 0, 6), box(4, 1.2, 8.4, '#3a3a3a', 13, 0.8, 0)]);
}

/** 横放的圆柱（沿 x 轴，中心在 x, y, z）：rTop 在 +x 一头 */
function hcyl(rTop: number, rBottom: number, len: number, color: string, x: number, y: number, z: number, seg = 16): Part {
  return cyl(rTop, rBottom, len, color, 0, -len / 2, 0, seg).rotateZ(-Math.PI / 2).translate(x, y, z);
}

/** 后掠的翼面：根弦 c0、梢弦 c1、半展长 span、后掠 sweep（梢部往后退的米数），厚 th */
function wing(c0: number, c1: number, span: number, sweep: number, th: number, color: string, x: number, y: number, side: 1 | -1): Part {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(-sweep, span * side);
  s.lineTo(-sweep - c1, span * side);
  s.lineTo(-c0, 0);
  s.lineTo(0, 0);
  return hull(s, -th / 2, th / 2, color).translate(x, y, 0);
}

/** 双发宽体货机（长 64 米、翼展 65 米） */
export function freighter(): THREE.BufferGeometry {
  const W = '#f3f3f1';
  const parts: Part[] = [
    hcyl(3.1, 3.1, 46, W, 0, 6.2, 0),
    hcyl(0.6, 3.1, 9, W, 27.5, 6.2, 0),
    hcyl(3.1, 0.7, 13, W, -29.5, 6.9, 0),
    box(2.2, 0.9, 3.4, '#26313c', 30, 7.4, 0),
    box(52, 0.5, 6.25, '#2a78d6', -2, 5.1, 0),
    // 侧面的主货舱门（左侧，机翼后面）
    box(5.4, 3.0, 0.08, '#d9dcdf', -12, 5.2, -3.1),
    wing(13, 3.5, 30, 15, 1.1, '#e6e6e3', 6, 4.6, 1),
    wing(13, 3.5, 30, 15, 1.1, '#e6e6e3', 6, 4.6, -1),
    wing(6, 2.2, 10.5, 5.5, 0.5, '#e6e6e3', -27, 7.4, 1),
    wing(6, 2.2, 10.5, 5.5, 0.5, '#e6e6e3', -27, 7.4, -1),
    hcyl(1.65, 1.65, 6.4, '#a6abb1', 4, 3.4, 9.5),
    hcyl(1.65, 1.65, 6.4, '#a6abb1', 4, 3.4, -9.5),
    hcyl(1.2, 1.2, 0.3, '#2d2f33', 7.25, 3.4, 9.5),
    hcyl(1.2, 1.2, 0.3, '#2d2f33', 7.25, 3.4, -9.5),
    box(2.2, 1.0, 0.5, '#d9dcdf', 3.5, 4.4, 9.5),
    box(2.2, 1.0, 0.5, '#d9dcdf', 3.5, 4.4, -9.5),
  ];
  // 垂尾：竖着的后掠翼面
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(-7, 11);
  fin.lineTo(-11, 11);
  fin.lineTo(-9.5, 0);
  fin.lineTo(0, 0);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.6, bevelEnabled: false });
  finGeo.translate(-26, 8.4, -0.3);
  const n = finGeo.getAttribute('position').count;
  const fc = new Float32Array(n * 3);
  const blue = new THREE.Color('#2a78d6');
  for (let i = 0; i < n; i++) {
    fc[i * 3] = blue.r;
    fc[i * 3 + 1] = blue.g;
    fc[i * 3 + 2] = blue.b;
  }
  finGeo.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  parts.push(finGeo);
  // 起落架：前轮、两组主轮
  parts.push(box(0.4, 3.2, 0.4, '#5b6067', 24, 0.6, 0), wheel(0.6, 0.5, '#1d1d1d', 24, 0.6, 0));
  for (const z of [-2.6, 2.6]) {
    parts.push(box(0.6, 3.0, 0.6, '#5b6067', -2, 0.9, z));
    for (const x of [-3.4, -2, -0.6]) parts.push(wheel(0.7, 1.4, '#1d1d1d', x, 0.7, z));
  }
  return merge(parts);
}

/** 机坪地勤：升降平台车（装卸集装板）、拖车、板车 */
export function loader(): THREE.BufferGeometry {
  return merge([box(7, 1, 3.6, '#f2c94c', 0, 0.5), box(6, 0.4, 3.4, '#d6d9dc', 0, 3.2), box(1.6, 2.2, 3.4, '#3d4650', 3, 1.5), box(0.3, 2.4, 0.3, '#5b6067', -1, 1.5, 1.4), box(0.3, 2.4, 0.3, '#5b6067', -1, 1.5, -1.4), ...[-2.5, 2.5].flatMap((x) => [wheel(0.45, 0.4, '#1d1d1d', x, 0.45, 1.6), wheel(0.45, 0.4, '#1d1d1d', x, 0.45, -1.6)])]);
}
export function dolly(): THREE.BufferGeometry {
  return merge([box(3.4, 0.5, 2.6, '#7b8087', 0, 0.5), box(3.2, 1.6, 2.4, '#c9d3dc', 0, 1.0), ...[-1.2, 1.2].flatMap((x) => [wheel(0.3, 0.3, '#1d1d1d', x, 0.3, 1.2), wheel(0.3, 0.3, '#1d1d1d', x, 0.3, -1.2)])]);
}
export function apronTug(): THREE.BufferGeometry {
  return merge([box(3.2, 1.2, 1.8, '#f2c94c', 0, 0.4), box(1.2, 1.0, 1.6, '#26313c', -0.6, 1.6), ...[-1, 1].flatMap((x) => [wheel(0.4, 0.35, '#1d1d1d', x, 0.4, 0.9), wheel(0.4, 0.35, '#1d1d1d', x, 0.4, -0.9)])]);
}
