import * as THREE from 'three';
import { LAMPS, type LampSpec, type PartSlot } from '../fleet';
import { Pool } from './kit';

/**
 * 设施里自己画的车（物流园的场内牵引车和货车、港口的场内牵引车和物流中心的货车、机场的车）的车灯：
 * 和区域车辆层同一套灯位（fleet.ts 的 LAMPS）、同一套规则和颜色——夜里大灯、尾灯常亮；停着等、减速时亮刹车灯；
 * 倒车亮倒车灯；转弯打转向灯；倒车靠台、挂 / 摘挂车时打双闪。灯不受光照、不做色调映射（夜里也鲜亮）。
 * 没有灯位表的车模（自己拼的专用车）按车身的包围盒在车头、车尾两角放灯（specOf）。零件原点在车尾、车头朝 +x，+z 是右侧。
 */
export interface LampState {
  night: boolean;
  brake?: boolean;
  rev?: boolean;
  /** 转向灯：1 = 右（+z 一侧）、−1 = 左 */
  turn?: number;
  hazard?: boolean;
}

const BRAKE = 0xff2414;
const TAIL = 0x8a0d08;
const AMBER = 0xffa21a;
const REVERSE = 0xf4f6ff;
const HEAD = 0xfff1cf;

/** 夜里（和外来货车、区域车辆的天色一样：太阳高度低于一定值） */
export function isNight(t: number): boolean {
  const h = (((t / 3600) % 24) + 24) % 24;
  return Math.sin((Math.PI * (h - 6)) / 13.5) * 1.6 + 0.2 < 0.62;
}

/** 朝向的变化 → 转向灯的一侧（朝向 h = atan2(dx, dz) 变大是往左转）；转得很慢不打灯 */
export function turnOf(h0: number, h1: number): number {
  let d = h1 - h0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) < 0.06 ? 0 : d > 0 ? -1 : 1;
}

export class Lamps {
  private readonly pool: Pool;
  private blink = false;
  constructor(name: string, capacity = 600) {
    this.pool = new Pool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), capacity, name, false);
  }
  get mesh(): THREE.InstancedMesh {
    return this.pool.mesh;
  }
  /** 一帧开始：转向灯、双闪每秒闪一下半（按仿真时刻） */
  begin(t: number): void {
    this.pool.begin();
    this.blink = Math.floor(t * 3) % 2 === 0;
  }
  end(): void {
    this.pool.end();
  }

  /**
   * 一个零件的灯：零件原点在 (x, y, z)、朝向 yaw（和 Pool.put 一样）、缩放 k；front：大灯、前转向灯；rear：尾灯 / 刹车灯、倒车灯、后转向灯。
   * spec：灯位表里的零件名，或者自己给的灯位
   */
  part(spec: PartSlot | LampSpec | undefined, x: number, y: number, z: number, yaw: number, k: number, front: boolean, rear: boolean, st: LampState): void {
    const s = typeof spec === 'string' ? LAMPS[spec] : spec;
    if (!s) return;
    const m = s.k * 1.3;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const at = (p: readonly [number, number, number], side: number, w: number, h: number, l: number, col: number) => {
      const lx = p[0];
      const lz = p[2] * side;
      this.pool.put(x + (lx * c + lz * sn) * k, y + p[1] * k, z + (-lx * sn + lz * c) * k, yaw, 0, w * k, h * k, l * k, col);
    };
    if (rear && s.tail) {
      if (st.brake) for (const sd of [1, -1]) at(s.tail, sd, 0.14 * m, 0.24 * m, 0.44 * m, BRAKE);
      else if (st.night) for (const sd of [1, -1]) at(s.tail, sd, 0.1 * m, 0.2 * m, 0.38 * m, TAIL);
    }
    if (rear && st.rev && s.back) for (const sd of [1, -1]) at(s.back, sd, 0.12 * m, 0.2 * m, 0.3 * m, REVERSE);
    if (this.blink && (st.hazard || st.turn)) {
      for (const sd of st.hazard ? [1, -1] : [st.turn as number]) {
        if (rear && s.rearTurn) at(s.rearTurn, sd, 0.14 * m, 0.2 * m, 0.32 * m, AMBER);
        if (front && s.frontTurn) at(s.frontTurn, sd, 0.14 * m, 0.2 * m, 0.32 * m, AMBER);
      }
    }
    if (front && st.night && s.head) for (const sd of [1, -1]) at(s.head, sd, 0.12 * m, 0.22 * m, 0.46 * m, HEAD);
  }

  /** 没有灯位表的车模：按包围盒在车头两角放大灯、前转向灯，车尾两角放尾灯、倒车灯、后转向灯（灯高 lampY，默认离地 0.8 米） */
  static specOf(geo: THREE.BufferGeometry, lampY = 0.8): LampSpec {
    geo.computeBoundingBox();
    const b = geo.boundingBox as THREE.Box3;
    const hw = Math.max(0.35, Math.min(Math.abs(b.max.z), Math.abs(b.min.z)) - 0.22);
    const y = Math.min(lampY, b.max.y * 0.7);
    return { tail: [b.min.x - 0.02, y, hw], back: [b.min.x - 0.02, y, Math.max(0.2, hw - 0.32)], rearTurn: [b.min.x - 0.02, y + 0.2, hw], frontTurn: [b.max.x + 0.02, y, hw + 0.05], head: [b.max.x + 0.02, y, Math.max(0.25, hw - 0.25)], k: 1 };
  }
}
