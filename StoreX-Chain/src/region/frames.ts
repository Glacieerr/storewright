/**
 * 设施的坐标系：港口、机场、物流园内部的几何和作业动画都按「局部坐标」写（就是这些设施原来摆在湾区里的位置，沙盘米），
 * 区域生成器决定每个设施放到哪里、朝哪个方向，整体平移、旋转进区域。
 *
 * 换算和 three.js 一致：父节点 position = w、rotation.y = rot，局部点 p 先减去 o 再旋转：
 *   x' = w.x + (p.x − o.x)·cos(rot) + (p.z − o.z)·sin(rot)
 *   z' = w.z − (p.x − o.x)·sin(rot) + (p.z − o.z)·cos(rot)
 * 朝向（绕 y 轴的角）在区域里要加上 rot。
 */
export interface XZ {
  x: number;
  z: number;
}
export interface Frame {
  /** 局部坐标里的参考点（沙盘米） */
  o: XZ;
  /** 参考点在区域里的位置（沙盘米） */
  w: XZ;
  /** 绕 y 轴转的角（弧度，three.js 的 rotation.y） */
  rot: number;
}
interface KmPt {
  x: number;
  y: number;
}

export const identityFrame = (o: XZ): Frame => ({ o: { ...o }, w: { ...o }, rot: 0 });

export function toWorld(f: Frame, p: XZ): XZ {
  const dx = p.x - f.o.x;
  const dz = p.z - f.o.z;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: f.w.x + dx * c + dz * s, z: f.w.z - dx * s + dz * c };
}

export function toLocal(f: Frame, p: XZ): XZ {
  const dx = p.x - f.w.x;
  const dz = p.z - f.w.z;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: f.o.x + dx * c - dz * s, z: f.o.z + dx * s + dz * c };
}

/** 局部的方向向量（不带平移）转到区域里 */
export function dirToWorld(f: Frame, d: XZ): XZ {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: d.x * c + d.z * s, z: -d.x * s + d.z * c };
}

/** 公里坐标（x 向东、y 向北）版本：沙盘 x = 公里 × 100，z = −公里 × 100 */
export function kmToWorld(f: Frame, k: KmPt): KmPt {
  const p = toWorld(f, { x: k.x * 100, z: -k.y * 100 });
  return { x: p.x / 100, y: -p.z / 100 };
}
export function kmToLocal(f: Frame, k: KmPt): KmPt {
  const p = toLocal(f, { x: k.x * 100, z: -k.y * 100 });
  return { x: p.x / 100, y: -p.z / 100 };
}

/** 局部的一个矩形（沙盘米）放进区域以后的四个角（公里），用来检查设施占地 */
export function footprintKm(f: Frame, r: { x0: number; x1: number; z0: number; z1: number }): KmPt[] {
  return [
    { x: r.x0, z: r.z0 },
    { x: r.x1, z: r.z0 },
    { x: r.x1, z: r.z1 },
    { x: r.x0, z: r.z1 },
  ].map((p) => {
    const w = toWorld(f, p);
    return { x: w.x / 100, y: -w.z / 100 };
  });
}
