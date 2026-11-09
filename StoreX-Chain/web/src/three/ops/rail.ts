import * as THREE from 'three';
import { box, merge, wheel, type Part } from '../../../../../StoreX/web/src/three/models';
import type { WVehicle } from '../../../../src/sim/trace';
import { containerGeometry, ease, lerp, Pool, prog, STORE_BOX } from './kit';
import { railGeometry, type RailBox, type Transfer } from '../../../../src/hub/park';

/**
 * 铁路站的轨道式龙门吊（RMG）：沿一段直线铁路跑，跨着装卸线和旁边的两排箱位。
 * 卸车：大车走到车厢 → 小车移到铁路上方 → 吊具下降、锁箱、起升 → 小车移到箱位上方 → 大车走到空箱位 → 下降、放箱。
 * 装车（港口铁路站）反过来：从箱位吊上平车。
 * 平车上还有几个箱由这里决定（区域车辆层画车厢时问 cargo()），卸一个少一个、装一个多一个；箱的颜色也由这里给（本店的箱是蓝色）。
 *
 * 坐标：一段直线 A → B，u 沿铁路（从 A 起），v 垂直于铁路、指向 A → B 的右手边（箱位在这一侧；要放另一边就把 A、B 对调）；铁路中心 v = 0。
 *
 * 站台可以扩容（设施管理台的「装卸线」）：主线旁边再加几股装卸线（每股隔 4.8 米，停着等装卸的平车），箱位和龙门吊的跨度跟着往外挪；
 * 站房、信号机、车挡和站台照明是固定的。列车停在主线上作业（区域车辆层沿主线画列车）。
 *
 * 物流园的两段站台（truckLane）：外侧支腿再往外挪 4.4 米，跨内外排箱位外面留一条集卡道（单向西行），短驳车、外来集卡开进来停在箱的旁边，
 * 龙门吊把箱放到车上（或从车上把空箱吊回箱位）；站房和照明挪到铁路北侧，不挡集卡道。哪个箱放哪个箱位、什么时候被提走、
 * 龙门吊什么时候给集卡道上的车装卸，都按物流园的计划（src/hub/park.ts，setPlan）。
 */

/** 和区域车辆层的列车一致：12 节平车、每节 15 米，第 k 节（从 1 起）的中心离车头 17 + (k − 1)·15 + 7.5 米 */
export const WAGONS = 12;
export const wagonBack = (k: number): number => 17 + (k - 1) * 15 + 7.5;
/** 车厢上的箱颜色（别家的箱，和区域车辆层同一组） */
export const TRAIN_BOX = ['#c0392b', '#2471a3', '#1e8449', '#d35400', '#7d3c98', '#566573', '#a04000', '#2e86c1', '#f0b27a', '#16a085'];
/** 平车上箱底的高度、箱高；集卡道上骨架车的箱底高度（和车模一样） */
const DECK = 2.0;
const BOX_H = 2.59;
const CHASSIS_Y = 1.25;
/** 箱位：两排（主线外 v = 12、15.2，加装卸线时往外挪），每排沿铁路 13 米一个、最多两层 */
const ROW_V0 = [12, 15.2];
/** 加的装卸线之间的间距 */
const TRACK_GAP = 4.8;
const SLOT_U = 13.2;
const TIERS = 2;
/** 龙门吊：两侧支腿在 v = −6、+21（加装卸线时外侧支腿往外挪），主梁高 18 米 */
const LEG_V0 = [-6, 21];
const TOP = 18;
const HOOK_TOP = 15.5;
const GANTRY_V = 1.6;
const TROLLEY_V = 1.2;
const HOIST_V = 0.6;

export interface RailWork {
  vid: number;
  label: string;
  /** 列车停在这里的时段（秒） */
  t0: number;
  t1: number;
  mode: 'load' | 'unload';
  /** 每节平车的中心（u）和箱的颜色；第 0 个 = 第 1 节 */
  wagons: { u: number; color: string; store: boolean; id: string }[];
}
interface Cycle {
  work: RailWork;
  /** 第几节平车（从 0 起）、箱位 */
  k: number;
  slot: { u: number; v: number; tier: number };
  /** 大车、小车、吊具的关键时刻 */
  t: number[];
  /** 箱离开原处（吊起）、落到新位置（松开）的时刻 */
  lift: number;
  place: number;
  /** 车厢上那一头（u, v = 0）和箱位那一头 */
  uW: number;
}

/** 轨道式龙门吊的门架：两侧支腿（每侧两根腿、下横梁带钢轮台车）、两根主梁、机房；原点在大车中心的地面，主梁沿 z（v 方向） */
function rmgFrame(LEG_V: readonly number[]): THREE.BufferGeometry {
  const Y = '#e8a33a';
  const D = '#3d4650';
  const p: Part[] = [];
  const zc = (LEG_V[0] as number + (LEG_V[1] as number)) / 2;
  for (const z of LEG_V) {
    p.push(box(16, 1.4, 1.4, Y, 0, 0.9, z));
    for (const dx of [-6.6, -5.2, 5.2, 6.6]) p.push(wheel(0.45, 0.3, '#2b2b2b', dx, 0.45, z));
    for (const x of [-7, 7]) p.push(box(1.3, TOP - 1.2, 1.3, Y, x, 2.3, z));
    p.push(box(15.4, 1.4, 1.4, Y, 0, TOP - 0.6, z));
  }
  const span = (LEG_V[1] as number) - (LEG_V[0] as number) + 6;
  for (const x of [-3.2, 3.2]) p.push(box(1.2, 2.0, span, Y, x, TOP, zc), box(0.25, 0.2, span, D, x, TOP + 2.0, zc));
  // 机房（一侧支腿上方）、司机室（挂在小车下面，另画）、爬梯
  p.push(box(5.5, 3.2, 4, '#dfe3e6', 0, TOP + 2.0, (LEG_V[1] as number) + 1.5), box(5.7, 0.3, 4.2, D, 0, TOP + 5.2, (LEG_V[1] as number) + 1.5), box(0.4, TOP, 0.4, D, 7.9, 0, LEG_V[0] as number));
  return merge(p);
}
function rmgTrolley(): THREE.BufferGeometry {
  return merge([box(8.2, 1.6, 4.2, '#3d4650', 0, 0, 0), box(8.4, 0.25, 4.4, '#e8a33a', 0, 1.6, 0), box(2.0, 2.2, 2.0, '#d6e4f0', 2.8, -2.4, 1.8)]);
}
function spreader(): THREE.BufferGeometry {
  return merge([box(12.0, 0.45, 2.3, '#e8a33a', 0, 0, 0), box(1.8, 0.7, 2.0, '#3d4650', 0, 0.45, 0)]);
}

export class RailYard {
  readonly group = new THREE.Group();
  private frame: Pool;
  private trolley: Pool;
  private spread: Pool;
  private boxes: Pool;
  private ropes: Pool;
  private readonly A: THREE.Vector3;
  private readonly d: THREE.Vector3;
  private readonly n: THREE.Vector3;
  private readonly yaw: number;
  readonly len: number;
  private works: RailWork[] = [];
  private cycles: Cycle[] = [];
  /** 当天一开始就在箱位上的箱（装车用，或别家的背景箱） */
  private initial: { u: number; v: number; tier: number; color: string; store: boolean; id: string; until: number }[] = [];
  /** 大车停的位置（没有活的时候） */
  private readonly park: number;
  /** 这个站台的箱位排、龙门吊支腿（随装卸线的股数往外挪） */
  private readonly rowV: number[];
  private readonly legV: number[];
  private readonly tracks: number;

  /** 跨内的集卡道（物流园的站台才有）：中心 v */
  readonly laneV: number | undefined;
  /** 物流园的计划：这一段站台上每个箱的箱位、被提走的时刻、龙门吊给集卡道上的车装卸的时段 */
  private plan: { boxes: RailBox[]; transfers: Transfer[] } | undefined;

  constructor(
    readonly title: string,
    a: { x: number; z: number },
    b: { x: number; z: number },
    tracks = 1,
    opts: { truckLane?: boolean } = {},
  ) {
    this.group.name = `rail-yard-${title}`;
    this.tracks = Math.max(1, Math.min(4, Math.round(tracks)));
    const off = (this.tracks - 1) * TRACK_GAP;
    this.rowV = ROW_V0.map((v) => v + off);
    this.legV = [LEG_V0[0] as number, (LEG_V0[1] as number) + off];
    if (opts.truckLane) {
      const g = railGeometry(this.tracks, true);
      this.rowV = g.rowV;
      this.legV = g.legV;
      this.laneV = g.laneV;
    }
    this.A = new THREE.Vector3(a.x, 0, a.z);
    this.d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    this.len = this.d.length();
    this.d.normalize();
    this.n = new THREE.Vector3(-this.d.z, 0, this.d.x);
    // 模型 +x 沿 u、+z 沿 v
    this.yaw = -Math.atan2(this.d.z, this.d.x);
    this.park = this.len * 0.5;
    const VC = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.12 });
    this.frame = new Pool(rmgFrame(this.legV), VC, 1, 'rmg-frame');
    this.trolley = new Pool(rmgTrolley(), VC, 1, 'rmg-trolley');
    this.spread = new Pool(spreader(), VC, 1, 'rmg-spreader');
    this.boxes = new Pool(containerGeometry(box, merge), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), 80, 'rail-yard-boxes');
    this.ropes = new Pool(new THREE.CylinderGeometry(1, 1, 1, 5), new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.5, roughness: 0.4 }), 8, 'rmg-ropes', false);
    for (const p of [this.frame, this.trolley, this.spread, this.boxes, this.ropes]) this.group.add(p.mesh);
    this.group.add(this.staticParts());
  }

  /** 第一排箱位离主线多远（装车用的箱一早放在这一排） */
  get firstRowV(): number {
    return this.rowV[0] as number;
  }

  /** 沙盘坐标 → (u, v) */
  uv(x: number, z: number): { u: number; v: number } {
    const dx = x - this.A.x;
    const dz = z - this.A.z;
    return { u: dx * this.d.x + dz * this.d.z, v: dx * this.n.x + dz * this.n.z };
  }
  /** (u, v) → 沙盘坐标 */
  at(u: number, v: number): { x: number; z: number } {
    return { x: this.A.x + this.d.x * u + this.n.x * v, z: this.A.z + this.d.z * u + this.n.z * v };
  }

  /** 不动的部分：龙门吊的两条轨道、箱位的地面和标线、装卸线旁的通道 */
  private staticParts(): THREE.Group {
    const g = new THREE.Group();
    const p: Part[] = [];
    const L = this.len;
    const off = (this.tracks - 1) * TRACK_GAP;
    const vTop = (this.legV[1] as number) + 3;
    p.push(box(L + 30, 0.25, vTop + 9.5, '#a9a69c', L / 2, 0.05, (vTop - 9.5) / 2));
    if (this.laneV !== undefined) {
      // 集卡道：沥青、两边的黄线、西行的箭头
      p.push(box(L + 70, 0.08, 4.2, '#55585c', L / 2 - 20, 0.3, this.laneV));
      for (const dv of [-2.05, 2.05]) p.push(box(L + 70, 0.03, 0.15, '#f0c419', L / 2 - 20, 0.38, this.laneV + dv));
      for (let u = L - 10; u > 0; u -= 36) p.push(box(2.4, 0.03, 0.3, '#f2f2ee', u, 0.38, this.laneV), box(1.1, 0.03, 0.3, '#f2f2ee', u - 1.5, 0.38, this.laneV + 0.35), box(1.1, 0.03, 0.3, '#f2f2ee', u - 1.5, 0.38, this.laneV - 0.35));
    }
    for (const v of this.legV) p.push(box(L + 30, 0.35, 0.5, '#5b6067', L / 2, 0.06, v), box(L + 30, 0.12, 1.4, '#7d7f84', L / 2, 0.06, v));
    for (const v of this.rowV) for (let u = SLOT_U / 2; u < L; u += SLOT_U) p.push(box(12.6, 0.3, 0.15, '#f2f2ee', u, 0.1, v - 1.35), box(12.6, 0.3, 0.15, '#f2f2ee', u, 0.1, v + 1.35));
    // 加的装卸线：道砟、轨枕、两根钢轨，停着一列等装卸的平车（有的装着箱）
    let seed = Math.abs(Math.round(this.A.x * 7 + this.A.z * 13)) + 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 1; k < this.tracks; k++) {
      const v = k * TRACK_GAP;
      p.push(box(L + 20, 0.35, 3.6, '#8a8278', L / 2, 0.02, v));
      for (let u = -8; u < L + 8; u += 1.2) p.push(box(0.25, 0.14, 2.6, '#5d4a3a', u, 0.36, v));
      for (const dv of [-0.75, 0.75]) p.push(box(L + 20, 0.16, 0.08, '#6b6b6b', L / 2, 0.5, v + dv));
      const n = Math.max(3, Math.floor((L - 30) / 15) - 2);
      for (let i = 0; i < n; i++) {
        const u = 18 + i * 15;
        p.push(box(14.2, 0.5, 2.6, '#3f4447', u, 1.1, v), wheel(0.42, 0.25, '#2b2b2b', u - 5, 0.42, v - 0.8), wheel(0.42, 0.25, '#2b2b2b', u + 5, 0.42, v + 0.8));
        if (rnd() < 0.55) p.push(box(12.2, BOX_H, 2.44, TRAIN_BOX[Math.floor(rnd() * TRAIN_BOX.length)] as string, u, 1.6, v));
      }
    }
    // 站房（外侧支腿外面）、两头的信号机、站台照明
    const lv = this.laneV !== undefined ? (this.legV[0] as number) - 12 : (this.legV[1] as number) + 10;
    p.push(box(22, 7, 9, '#e3ddd0', -4, 0, lv), box(23, 0.6, 10, '#7a6a5a', -4, 7, lv), box(4, 2.4, 0.2, '#2f6db3', -4, 4.2, lv + (this.laneV !== undefined ? 4.6 : -4.6)));
    for (const u of [-26, L + 26]) p.push(box(0.4, 5.5, 0.4, '#3d4650', u, 0, -2.8), box(0.9, 1.6, 0.6, '#1f2328', u, 5.2, -2.8), box(0.5, 0.5, 0.2, u < 0 ? '#2ecc71' : '#e74c3c', u, 6.3, -2.48));
    const mv = this.laneV !== undefined ? (this.legV[0] as number) - 3 : (this.legV[1] as number) + 3;
    for (let u = 10; u < L; u += 40) p.push(box(0.3, 14, 0.3, '#9aa0a6', u, 0, mv), box(2.2, 0.4, 0.8, '#f5f2e8', u, 14, mv));
    // 箱位尽头的车挡（铁路的尽头标志）
    p.push(box(1.2, 1.2, 3.2, '#d03b2a', -12, 0, 0));
    const body = new THREE.Mesh(merge(p), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    body.receiveShadow = true;
    body.rotation.y = this.yaw;
    body.position.copy(this.A);
    g.add(body);
    return g;
  }

  /** 物流园的计划（这一段站台的箱、龙门吊给集卡道上的车装卸的时段）；已经排过当天的作业就按新的计划重排 */
  setPlan(p: { boxes: RailBox[]; transfers: Transfer[] } | undefined): void {
    this.plan = p;
    if (this.works.length) this.setDay(this.works, this.initial);
  }

  /** 龙门吊给集卡道上的车装 / 卸一个箱：起点、终点（u、v、吊具落到的高度） */
  private xferEnds(x: Transfer): { from: { u: number; v: number; y: number }; to: { u: number; v: number; y: number } } {
    const lane = { u: x.laneU, v: this.laneV ?? (this.legV[1] as number) - 2, y: CHASSIS_Y + BOX_H };
    const slot = { u: x.slot.u, v: x.slot.v, y: x.slot.tier * BOX_H + BOX_H };
    return x.dir === 'out' ? { from: slot, to: lane } : { from: lane, to: slot };
  }

  /** 当天的作业（列车停在这里的时段、每节平车的位置和箱） */
  setDay(works: RailWork[], initial: RailYard['initial'] = []): void {
    this.works = works.slice().sort((a, b) => a.t0 - b.t0);
    this.initial = initial;
    this.cycles = [];
    let free = -Infinity;
    let uNow = this.park;
    let vNow = 6;
    let slotSeq = 0;
    const slots = Math.max(1, Math.floor(this.len / SLOT_U));
    for (const w of this.works) {
      const n = w.wagons.length;
      if (!n) continue;
      // 卸车：从离车头最远的一节开始卸（区域车辆层少画一个就是最后一节）；装车：从第 1 节开始装
      const order = w.mode === 'unload' ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
      let t = Math.max(w.t0 + 150, free);
      const plans: Cycle[] = [];
      for (const k of order) {
        const wag = w.wagons[k] as RailWork['wagons'][number];
        let slot: Cycle['slot'];
        const pb = w.mode === 'unload' ? this.plan?.boxes.find((x) => x.id === wag.id) : undefined;
        if (pb) slot = { ...pb.slot };
        else if (w.mode === 'unload') {
          const c = slotSeq % slots;
          const row = Math.floor(slotSeq / slots) % this.rowV.length;
          const tier = Math.floor(slotSeq / (slots * this.rowV.length)) % TIERS;
          slot = { u: SLOT_U / 2 + c * SLOT_U, v: this.rowV[row] as number, tier };
          slotSeq++;
        } else {
          const ini = this.initial.find((b) => b.id === wag.id);
          slot = ini ? { u: ini.u, v: ini.v, tier: ini.tier } : { u: wag.u, v: this.rowV[0] as number, tier: 0 };
        }
        const from = w.mode === 'unload' ? { u: wag.u, v: 0, y: DECK + BOX_H } : { u: slot.u, v: slot.v, y: slot.tier * BOX_H + BOX_H };
        const to = w.mode === 'unload' ? { u: slot.u, v: slot.v, y: slot.tier * BOX_H + BOX_H } : { u: wag.u, v: 0, y: DECK + BOX_H };
        // 时刻：0 出发 → 1 到取箱上方 → 2 吊具落到箱顶 → 3 锁好、起升到顶 → 4 到放箱上方 → 5 落到位 → 6 松开、起升到顶
        const go1 = Math.max(Math.abs(from.u - uNow) / GANTRY_V, Math.abs(from.v - vNow) / TROLLEY_V) + 6;
        const down1 = (HOOK_TOP - from.y) / HOIST_V + 4;
        const go2 = Math.max(Math.abs(to.u - from.u) / GANTRY_V, Math.abs(to.v - from.v) / TROLLEY_V) + 6;
        const down2 = (HOOK_TOP - to.y) / HOIST_V + 4;
        const ts = [t, t + go1, t + go1 + down1, t + go1 + down1 + 6 + down1, 0, 0, 0];
        ts[4] = (ts[3] as number) + go2;
        ts[5] = (ts[4] as number) + down2;
        ts[6] = (ts[5] as number) + 6 + down2;
        plans.push({ work: w, k, slot, t: ts, uW: wag.u, lift: 0, place: 0 });
        t = ts[6] as number;
        uNow = to.u;
        vNow = to.v;
      }
      // 停站时间不够：按比例压缩（最后一箱在开车前 4 分钟弄完）
      const end = w.t1 - 240;
      const first = plans[0];
      if (first && t > end) {
        const t0 = first.t[0] as number;
        const k = Math.max(0.2, (end - t0) / (t - t0));
        for (const c of plans) c.t = c.t.map((x) => t0 + (x - t0) * k);
        t = end;
      }
      for (const c of plans) {
        c.lift = ((c.t[2] as number) + (c.t[3] as number)) / 2;
        c.place = ((c.t[5] as number) + (c.t[6] as number)) / 2 - 3;
      }
      this.cycles.push(...plans);
      free = t;
    }
  }

  /** 某列车此刻平车上有几个箱（不归这里管的车返回 undefined） */
  cargo(vid: number, t: number): number | undefined {
    const ws = this.works.filter((w) => w.vid === vid);
    if (!ws.length) return undefined;
    // 停站之前：卸车的满载、装车的空着；停站之后：卸车的空了、装车的满了
    const w = ws.find((x) => t >= x.t0 && t < x.t1) ?? ws.find((x) => t < x.t0) ?? ws[ws.length - 1];
    if (!w) return undefined;
    const n = w.wagons.length;
    const done = this.cycles.filter((c) => c.work === w && t >= (w.mode === 'unload' ? c.lift : c.place)).length;
    if (t < w.t0) return w.mode === 'unload' ? n : 0;
    if (t >= w.t1) return w.mode === 'unload' ? 0 : n;
    return w.mode === 'unload' ? n - done : done;
  }
  /** 某列车在这里的作业时段 */
  window(vid: number): [number, number] | undefined {
    const w = this.works.find((x) => x.vid === vid);
    return w ? [w.t0, w.t1] : undefined;
  }
  /** 第 k 节（从 1 起）平车上的箱颜色 */
  boxColor(vid: number, k: number): string | undefined {
    const w = this.works.find((x) => x.vid === vid);
    return w?.wagons[k - 1]?.color;
  }

  update(t: number): void {
    for (const p of [this.frame, this.trolley, this.spread, this.boxes, this.ropes]) p.begin();
    // 龙门吊此刻在哪：正在做的一箱（列车作业，或给集卡道上的车装卸）；没有就停在上一件活结束的位置
    let u = this.park;
    let v = 6;
    let hook = HOOK_TOP;
    let carried: { color: string } | undefined;
    let prev: Cycle | undefined;
    let cur: Cycle | undefined;
    for (const c of this.cycles) {
      if (t >= (c.t[0] as number) && t < (c.t[6] as number)) cur = c;
      if ((c.t[6] as number) <= t) prev = c;
    }
    const xfers = this.plan?.transfers ?? [];
    let xNow: Transfer | undefined;
    let xPrev: Transfer | undefined;
    for (const x of xfers) {
      if (t >= x.t0 && t < x.t1) xNow = x;
      if (x.t1 <= t && (!xPrev || x.t1 > xPrev.t1)) xPrev = x;
    }
    const ends = (c: Cycle) => {
      const unload = c.work.mode === 'unload';
      const from = unload ? { u: c.uW, v: 0, y: DECK + BOX_H } : { u: c.slot.u, v: c.slot.v, y: c.slot.tier * BOX_H + BOX_H };
      const to = unload ? { u: c.slot.u, v: c.slot.v, y: c.slot.tier * BOX_H + BOX_H } : { u: c.uW, v: 0, y: DECK + BOX_H };
      return { from, to };
    };
    // 停的位置：最后做完的那件活（列车的或集卡道的）的终点
    if (prev && (!xPrev || (prev.t[6] as number) >= xPrev.t1)) {
      const e = ends(prev).to;
      u = e.u;
      v = e.v;
    } else if (xPrev) {
      const e = this.xferEnds(xPrev).to;
      u = e.u;
      v = e.v;
    }
    if (xNow && !cur) {
      // 集卡道：走到取箱处 → 落下锁箱 → 起升 → 走到放箱处 → 落下松开 → 起升（时段按计划，动作按比例排）
      const { from, to } = this.xferEnds(xNow);
      const f = (t - xNow.t0) / (xNow.t1 - xNow.t0);
      const u0 = u;
      const v0 = v;
      const seg = (a: number, b: number) => ease(Math.min(1, Math.max(0, (f - a) / (b - a))));
      if (f < 0.22) {
        u = lerp(u0, from.u, seg(0, 0.22));
        v = lerp(v0, from.v, seg(0, 0.22));
      } else if (f < 0.5) {
        u = from.u;
        v = from.v;
        hook = f < 0.34 ? lerp(HOOK_TOP, from.y, seg(0.22, 0.34)) : f < 0.4 ? from.y : lerp(from.y, HOOK_TOP, seg(0.4, 0.5));
        if (f >= 0.37) carried = { color: xNow.color };
      } else if (f < 0.66) {
        u = lerp(from.u, to.u, seg(0.5, 0.66));
        v = lerp(from.v, to.v, seg(0.5, 0.66));
        carried = { color: xNow.color };
      } else {
        u = to.u;
        v = to.v;
        hook = f < 0.76 ? lerp(HOOK_TOP, to.y, seg(0.66, 0.76)) : f < 0.82 ? to.y : lerp(to.y, HOOK_TOP, seg(0.82, 0.95));
        if (f < 0.79) carried = { color: xNow.color };
      }
      // 车上的箱（还没吊起来的、刚放下的）这一会儿由这里画
      if (!carried) {
        const onCar = xNow.dir === 'out' ? f >= 0.79 : f < 0.37;
        if (onCar) {
          const q = this.at(xNow.laneU, this.laneV ?? 0);
          this.boxes.put(q.x, CHASSIS_Y, q.z, this.yaw, 0, 1, 1, 1, xNow.color);
        }
      }
    }
    if (cur) {
      const T = cur.t as number[];
      const { from, to } = ends(cur);
      const u0 = u;
      const v0 = v;
      const color = (cur.work.wagons[cur.k] as RailWork['wagons'][number]).color;
      if (t < (T[1] as number)) {
        const f = ease(prog(t, T[0] as number, T[1] as number));
        u = lerp(u0, from.u, f);
        v = lerp(v0, from.v, f);
      } else if (t < (T[3] as number)) {
        u = from.u;
        v = from.v;
        const mid = ((T[2] as number) + (T[3] as number)) / 2;
        hook = t < (T[2] as number) ? lerp(HOOK_TOP, from.y, ease(prog(t, T[1] as number, T[2] as number))) : t < mid ? from.y : lerp(from.y, HOOK_TOP, ease(prog(t, mid, T[3] as number)));
        if (t >= cur.lift) carried = { color };
      } else if (t < (T[4] as number)) {
        const f = ease(prog(t, T[3] as number, T[4] as number));
        u = lerp(from.u, to.u, f);
        v = lerp(from.v, to.v, f);
        carried = { color };
      } else {
        u = to.u;
        v = to.v;
        const mid = ((T[5] as number) + (T[6] as number)) / 2;
        hook = t < (T[5] as number) ? lerp(HOOK_TOP, to.y, ease(prog(t, T[4] as number, T[5] as number))) : t < mid ? to.y : lerp(to.y, HOOK_TOP, ease(prog(t, mid, T[6] as number)));
        if (t < cur.place) carried = { color };
      }
    }
    const c0 = this.at(u, 0);
    this.frame.put(c0.x, 0, c0.z, this.yaw);
    const tr = this.at(u, v);
    this.trolley.put(tr.x, TOP + 2.0, tr.z, this.yaw);
    this.spread.put(tr.x, hook, tr.z, this.yaw);
    for (const du of [-4.5, 4.5])
      for (const dv of [-0.8, 0.8]) {
        const a = this.at(u + du, v + dv);
        this.ropes.rod({ x: a.x, y: TOP + 2.0, z: a.z }, { x: a.x, y: hook + 0.9, z: a.z }, 0.05, '#e9e9e9');
      }
    if (carried) this.boxes.put(tr.x, hook - BOX_H, tr.z, this.yaw, 0, 1, 1, 1, carried.color);
    // 箱位上的箱：一开始就在的（装车的还没吊走的）+ 前几天到的（计划给的）+ 已经卸下来的 + 拆完放回来的空箱；被集卡道上的车提走的不画
    const lifted = (id: string) => {
      const x = xfers.find((q) => q.box === id && q.dir === 'out');
      return x ? t >= x.t0 + (x.t1 - x.t0) * 0.37 : false;
    };
    for (const b of this.initial) {
      const taken = this.cycles.find((c) => c.work.mode === 'load' && (c.work.wagons[c.k] as RailWork['wagons'][number]).id === b.id);
      if (taken && t >= taken.lift) continue;
      if (t >= b.until) continue;
      const p = this.at(b.u, b.v);
      this.boxes.put(p.x, b.tier * BOX_H, p.z, this.yaw, 0, 1, 1, 1, b.color);
    }
    for (const b of this.plan?.boxes ?? []) {
      if (b.background && !lifted(b.id)) {
        const p = this.at(b.slot.u, b.slot.v);
        this.boxes.put(p.x, b.slot.tier * BOX_H, p.z, this.yaw, 0, 1, 1, 1, b.color);
      }
      if (b.emptySlot) {
        const x = xfers.find((q) => q.box === b.id && q.dir === 'in');
        if (x && t >= x.t0 + (x.t1 - x.t0) * 0.79) {
          const p = this.at(b.emptySlot.u, b.emptySlot.v);
          this.boxes.put(p.x, b.emptySlot.tier * BOX_H, p.z, this.yaw, 0, 1, 1, 1, b.color);
        }
      }
    }
    for (const c of this.cycles) {
      if (c.work.mode !== 'unload' || t < c.place) continue;
      const wag = c.work.wagons[c.k] as RailWork['wagons'][number];
      if (lifted(wag.id)) continue;
      const p = this.at(c.slot.u, c.slot.v);
      this.boxes.put(p.x, c.slot.tier * BOX_H, p.z, this.yaw, 0, 1, 1, 1, wag.color);
    }
    for (const p of [this.frame, this.trolley, this.spread, this.boxes, this.ropes]) p.end();
  }

  /** 监控面板：在站的列车、装卸进度、龙门吊此刻在干什么、箱位上有几个箱 */
  info(t: number): { title: string; trains: { vid: number; label: string; mode: string; t0: number; t1: number; done: number; n: number }[]; crane: string; yard: number } {
    const trains = this.works
      .filter((w) => t >= w.t0 - 3600 && t < w.t1 + 1800)
      .map((w) => ({ vid: w.vid, label: w.label, mode: w.mode === 'unload' ? '卸箱' : '装箱', t0: w.t0, t1: w.t1, done: this.cycles.filter((c) => c.work === w && t >= c.place).length, n: w.wagons.length }));
    const cur = this.cycles.find((c) => t >= (c.t[0] as number) && t < (c.t[6] as number));
    const xNow = (this.plan?.transfers ?? []).find((q) => t >= q.t0 && t < q.t1);
    const crane = cur ? `${cur.work.mode === 'unload' ? '卸' : '装'}第 ${cur.k + 1} 节平车的箱（${(cur.work.wagons[cur.k] as RailWork['wagons'][number]).id}）` : xNow ? `${xNow.dir === 'out' ? '把箱装上集卡道上的车' : '把空箱吊回箱位'}（${xNow.box}）` : '待命';
    const xfers = this.plan?.transfers ?? [];
    const gone = (id: string) => xfers.some((q) => q.box === id && q.dir === 'out' && t >= (q.t0 + q.t1) / 2);
    const yard =
      this.initial.filter((b) => t < b.until && !this.cycles.some((c) => c.work.mode === 'load' && (c.work.wagons[c.k] as RailWork['wagons'][number]).id === b.id && t >= c.lift)).length +
      this.cycles.filter((c) => c.work.mode === 'unload' && t >= c.place && !gone((c.work.wagons[c.k] as RailWork['wagons'][number]).id)).length +
      (this.plan?.boxes ?? []).filter((b) => (b.background && !gone(b.id)) || (b.emptyAt !== undefined && t >= b.emptyAt)).length;
    return { title: this.title, trains, crane, yard };
  }
}

/** 列车停站时每节平车的中心：沿铁路折线从车头往后排（和区域车辆层一致，近处 sc = 1） */
export function wagonPoints(rail: { at: (s: number) => { x: number; z: number } }, sHead: number, dirn: 1 | -1, n: number): { x: number; z: number }[] {
  return Array.from({ length: n }, (_, i) => rail.at(sHead - dirn * wagonBack(i + 1)));
}
export { STORE_BOX };
