import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 合并静态构件用的小工具：按范围造长方体、合并成一个几何体（统一成非索引、都带 uv） */

export function boxGeo(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

export function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = geos.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    return g;
  });
  const out = mergeGeometries(list, false);
  if (!out) throw new Error('merge failed');
  out.computeBoundingSphere();
  return out;
}

/** 由三角形列表造几何体；每个三角形按期望的法线方向自动调整绕序 */
export class TriBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, uvs?: [number, number, number, number, number, number]): void {
    const e1 = new THREE.Vector3().subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(c, a);
    const face = new THREE.Vector3().crossVectors(e1, e2);
    const flip = face.dot(n) < 0;
    const pts = flip ? [a, c, b] : [a, b, c];
    const u = uvs ?? [0, 0, 1, 0, 0, 1];
    const us = flip ? [u[0], u[1], u[4], u[5], u[2], u[3]] : u;
    for (const p of pts) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
    }
    this.uv.push(...us);
  }
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, nb?: THREE.Vector3, nc?: THREE.Vector3, nd?: THREE.Vector3): void {
    // a-b-c-d 依次相邻；可以给四个顶点各自的法线（曲面），否则用同一个
    if (nb && nc && nd) {
      this.triN(a, b, c, n, nb, nc);
      this.triN(a, c, d, n, nc, nd);
    } else {
      this.tri(a, b, c, n);
      this.tri(a, c, d, n);
    }
  }
  private triN(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, na: THREE.Vector3, nb: THREE.Vector3, nc: THREE.Vector3): void {
    const e1 = new THREE.Vector3().subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(c, a);
    const face = new THREE.Vector3().crossVectors(e1, e2);
    const avg = new THREE.Vector3().add(na).add(nb).add(nc);
    const flip = face.dot(avg) < 0;
    const pts: Array<[THREE.Vector3, THREE.Vector3]> = flip
      ? [
          [a, na],
          [c, nc],
          [b, nb],
        ]
      : [
          [a, na],
          [b, nb],
          [c, nc],
        ];
    for (const [p, n] of pts) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(0, 0);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** 沿 x 方向的经典花瓶形栏杆柱（车削体），高 h，底部在 y=0 */
export function balusterGeometry(h: number, r: number): THREE.BufferGeometry {
  const k = h / 0.62;
  const prof = [
    [0, 0],
    [r * 1.25, 0],
    [r * 1.25, 0.06],
    [r * 0.75, 0.1],
    [r * 1.15, 0.24],
    [r * 0.95, 0.36],
    [r * 0.55, 0.46],
    [r * 0.6, 0.52],
    [r * 1.2, 0.55],
    [r * 1.2, 0.62],
    [0, 0.62],
  ].map(([x, y]) => new THREE.Vector2(x as number, (y as number) * k));
  return new THREE.LatheGeometry(prof, 8);
}
