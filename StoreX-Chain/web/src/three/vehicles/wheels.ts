import * as THREE from 'three';
import { MAT_COLOR, MeshBuilder } from './builder';

/**
 * 单独实例化的车轮（半径 1、宽 1，车轴沿 z、中心在原点，按实例缩放到真实尺寸；第一部分 Storewright 的车轮）：
 * 圆润的胎肩和胎侧、轮辋外圈；乘用车是五辐轮毂和中心盖，货车是带减重孔的钢圈、凸出的轮毂和一圈螺母。
 * 两面都有轮毂面（左右两侧的车轮用同一个几何体）。段数比第一部分少一些：区域里同时有几百辆车。
 */
const cache = new Map<'car' | 'truck', THREE.BufferGeometry>();

/** 车削体：points 为 (半径, 轴向位置)，轴沿 x */
function lathe(points: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
  g.rotateZ(-Math.PI / 2);
  return g;
}

export function wheelGeometry(kind: 'car' | 'truck' = 'car'): THREE.BufferGeometry {
  const hit = cache.get(kind);
  if (hit) return hit;
  const b = new MeshBuilder();
  const rubber = MAT_COLOR.rubber;
  const sidewall = new THREE.Color('#2b2e32');
  const truck = kind === 'truck';
  const seg = truck ? 16 : 18;
  // 轮胎外轮廓（半径, 轴向）：轮辋边 → 胎侧 → 胎肩圆角 → 胎面（略鼓）；胎侧颜色稍浅，受光时看得出轮胎的圆润
  const rimR = truck ? 0.66 : 0.64;
  const side: Array<[number, number]> = truck
    ? [
        [rimR, -0.47],
        [0.82, -0.5],
        [0.95, -0.49],
      ]
    : [
        [rimR, -0.44],
        [0.8, -0.49],
        [0.92, -0.48],
      ];
  const tread: Array<[number, number]> = truck
    ? [
        [0.95, -0.49],
        [0.995, -0.42],
        [1.0, 0.0],
        [0.995, 0.42],
        [0.95, 0.49],
      ]
    : [
        [0.92, -0.48],
        [0.985, -0.4],
        [1.0, 0.0],
        [0.985, 0.4],
        [0.92, 0.48],
      ];
  b.part(lathe(side, seg), 'rubber', sidewall);
  b.part(lathe(tread, seg), 'rubber', rubber);
  b.part(
    lathe(
      [...side].reverse().map(([r, y]) => [r, -y] as [number, number]),
      seg,
    ),
    'rubber',
    sidewall,
  );
  const silver = truck ? new THREE.Color('#d6dade') : new THREE.Color('#c2c8cd');
  const dark = new THREE.Color('#2f3337');
  for (const sx of [-1, 1]) {
    const face = sx * 0.43;
    // 轮辋外圈
    const lip = new THREE.RingGeometry(rimR - 0.07, rimR + 0.005, seg + 6);
    lip.rotateY(sx * (Math.PI / 2));
    lip.translate(sx * (truck ? 0.47 : 0.445), 0, 0);
    b.part(lip, 'chrome', silver);
    // 轮毂背板（辐条之间看进去是深色）
    const back = new THREE.CircleGeometry(rimR - 0.06, seg);
    back.rotateY(sx * (Math.PI / 2));
    back.translate(face - sx * 0.06, 0, 0);
    b.part(back, 'trim', dark);
    if (truck) {
      // 钢圈：碟形盘面 + 六个减重孔 + 凸出的轮毂 + 八颗螺母
      const disc = new THREE.RingGeometry(0.2, rimR - 0.07, seg + 4);
      disc.rotateY(sx * (Math.PI / 2));
      disc.translate(face - sx * 0.02, 0, 0);
      b.part(disc, 'chrome', silver);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const hole = new THREE.CircleGeometry(0.075, 7);
        hole.rotateY(sx * (Math.PI / 2));
        hole.translate(face - sx * 0.01, Math.sin(a) * 0.43, Math.cos(a) * 0.43);
        b.part(hole, 'trim', dark);
      }
      b.cyl('chrome', 0.2, 0.15, 0.1, face + sx * 0.03, 0, 0, 'x', 10, new THREE.Color('#aeb4ba'));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        b.box('chrome', 0.04, 0.045, 0.045, face + sx * 0.01, Math.sin(a) * 0.27, Math.cos(a) * 0.27, { color: new THREE.Color('#e8eaec') });
      }
    } else {
      // 五辐轮毂：辐条从中心盖伸到轮辋，外宽内窄，略微凹进
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const spoke = new THREE.BufferGeometry();
        const r0 = 0.14;
        const r1 = rimR - 0.07;
        const w0 = 0.07;
        const w1 = 0.12;
        const pts = [
          [r0, -w0],
          [r1, -w1],
          [r1, w1],
          [r0, w0],
        ].map(([r, w]) => new THREE.Vector3(face, Math.sin(a) * (r as number) + Math.cos(a) * (w as number), Math.cos(a) * (r as number) - Math.sin(a) * (w as number)));
        const [p0, p1, p2, p3] = pts as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
        p1.x -= sx * 0.03;
        p2.x -= sx * 0.03;
        const pos = sx > 0 ? [p0, p2, p1, p0, p3, p2] : [p0, p1, p2, p0, p2, p3];
        spoke.setAttribute('position', new THREE.Float32BufferAttribute(pos.flatMap((p) => [p.x, p.y, p.z]), 3));
        spoke.computeVertexNormals();
        b.part(spoke, 'chrome', silver);
      }
      b.cyl('chrome', 0.15, 0.13, 0.05, face, 0, 0, 'x', 12, new THREE.Color('#9aa1a7'));
    }
  }
  // 胎面上一道浅色的线（远一点也看得出在转）
  b.box('trim', 0.9, 0.04, 0.12, 0, 0.985, 0, { color: new THREE.Color('#4a4c50') });
  // 车轴沿 x → 沿 z（零件坐标里车头朝 +x，车轴横着）
  const g = b.finish(0);
  cache.set(kind, g);
  return g;
}
