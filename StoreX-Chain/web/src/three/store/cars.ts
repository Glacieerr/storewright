import * as THREE from 'three';
import { CAR_COLORS, MODELS, SHIRTS } from '../../../../../StoreX/web/src/three/models';
import { modelOf, planPose, type CarPlan, type LotTraffic } from '../../../../src/site/motion';
import { along, corralCount, walkAt, type People, type Stand } from '../../../../src/site/people';
import type { Stay, StayPlan } from '../../../../src/site/stays';
import { partGeometry, type PartSlot } from '../fleet';
import { GeoBuilder, type V3 } from '../geo';
import { Pool } from '../ops/kit';
import type { RoadNet } from '../roadnet';
import type { Site } from '../stores';
import { usePaintMask } from '../vehicles/builder';
import type { PathState, TimedPath } from '@storewright/yard';
import { StoreRoads } from './roads';

/**
 * 综合店停车场里的车和人（画面）：车怎么走、在哪让行、停多久由 src/site/motion.ts 的时空预约排好（停车场里不重叠、
 * 给斑马线上的人和推车的回收员让行），人由 src/site/people.ts 排（下车走到店门、推车回来装车、把车推回回收栏）。
 * 这里只把它们画出来：进店路以外的那一段（从干道上游开过来、开出去一段才消失）按道路网的车道和路口转弯补上；
 * 车型用车辆模型库（轿车、两厢、SUV、MPV、皮卡、厢式车、房车和三种拖车），刹车灯、倒车灯、夜里的尾灯和大灯，装车时后备厢掀开。
 */

const SLOTS = ['car', 'hatch', 'suv', 'mpv', 'pickup', 'van', 'rv', 'camper', 'boatTrailer', 'utilityTrailer'] as const;
type Slot = (typeof SLOTS)[number];

/** 车型库还没有的车型：用一个盒子顶上（不该出现，留着兜底） */
function fallback(slot: Slot): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const L = slot === 'rv' ? 11.2 : slot === 'camper' ? 9.6 : slot === 'boatTrailer' ? 7.4 : slot === 'utilityTrailer' ? 4.3 : 4.6;
  g.color('#ffffff').box(L / 2, 0.35, 0, L, slot.endsWith('railer') ? 1.0 : 1.3, 1.8);
  return g.build();
}

export class StoreTraffic {
  readonly group = new THREE.Group();
  private readonly pools = new Map<Slot, Pool>();
  private readonly brake: Pool;
  private readonly tail: Pool;
  private readonly heads: Pool;
  private readonly trunks: Pool;
  private readonly pBody: Pool;
  private readonly pHead: Pool;
  private readonly carts: Pool;
  private readonly all: Pool[];
  /** 没找到的车型（报告给车型库） */
  readonly missing: string[] = [];
  private site: Site | undefined;
  private net: RoadNet | undefined;
  private stays: readonly Stay[] = [];
  private lot: LotTraffic | undefined;
  private people: People | undefined;
  private roads = new Map<number, { up?: { t0: number; path: TimedPath }; down?: { t0: number; path: TimedPath } } | null>();
  private stands = new Map<number, Stand[]>();
  private ways: StoreRoads | undefined;
  private night = 0;
  private readonly lp = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, rev: false, brake: false } as Parameters<typeof planPose>[2];
  private readonly st: PathState = { x: 0, z: 0, heading: 0 };
  private readonly colors: THREE.Color[] = CAR_COLORS.map((c) => new THREE.Color(c));

  constructor() {
    this.group.name = 'store-traffic';
    const mat = usePaintMask(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }));
    for (const s of SLOTS) {
      let geo: THREE.BufferGeometry;
      try {
        geo = partGeometry(s as PartSlot);
      } catch {
        this.missing.push(s);
        geo = fallback(s);
      }
      this.pools.set(s, new Pool(geo, mat, s === 'rv' || s.endsWith('railer') ? 4 : 120, `store-${s}`));
    }
    const lamp = new THREE.BoxGeometry(0.08, 0.14, 0.32);
    this.brake = new Pool(lamp, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 240, 'store-car-brake', false);
    this.tail = new Pool(lamp, new THREE.MeshBasicMaterial({ color: '#7a1410' }), 400, 'store-car-tail', false);
    this.heads = new Pool(new THREE.BoxGeometry(0.06, 0.12, 0.3), new THREE.MeshBasicMaterial({ color: '#fff4d6' }), 400, 'store-car-heads', false);
    this.trunks = new Pool(new THREE.BoxGeometry(1.0, 0.05, 1.5).translate(-0.5, 0, 0), mat, 40, 'store-car-trunks', false);
    const pm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    this.pBody = new Pool(MODELS.personBody(), pm, 200, 'store-people');
    this.pHead = new Pool(MODELS.personHead(), pm, 200, 'store-people-heads');
    const cg = new GeoBuilder();
    cg.color('#b8bec4').box(0, 0.35, 0, 0.9, 0.5, 0.55);
    cg.color('#8a9097').box(-0.5, 0.75, 0, 0.06, 0.06, 0.5);
    cg.color('#2a2d31');
    for (const x of [-0.35, 0.35]) for (const z of [-0.22, 0.22]) cg.box(x, 0, z, 0.1, 0.12, 0.05);
    cg.color('#d9822b').box(-0.52, 0.72, 0, 0.08, 0.05, 0.52);
    this.carts = new Pool(cg.build(), pm, 360, 'store-carts');
    this.all = [...this.pools.values(), this.brake, this.tail, this.heads, this.trunks, this.pBody, this.pHead, this.carts];
    for (const p of this.all) this.group.add(p.mesh);
  }

  /** 当天：车位安排、停车场里排好的车流、人；zIn / zStop 是进店路在停车场模型里的两头（本地 z） */
  setDay(site: Site, net: RoadNet, plan: StayPlan, lot: LotTraffic | undefined, people: People, zIn: number, zStop: number, ways = new StoreRoads(site, net, zIn, zStop)): void {
    this.site = site;
    this.net = net;
    this.stays = plan.stays;
    this.lot = lot;
    this.people = people;
    this.ways = ways;
    this.roads.clear();
    this.stands.clear();
    for (const s of people.stands) this.stands.set(s.id, [...(this.stands.get(s.id) ?? []), s]);
  }

  setNight(k: number): void {
    this.night = k;
  }

  /** 后台线程排好的车流 */
  setLot(lot: LotTraffic): void {
    this.lot = lot;
    this.roads.clear();
  }

  /** 进店路以外的两段（世界坐标）：从干道上游开到进店路起点、从停止线开出去一段 */
  private road(i: number, p: CarPlan): { up?: { t0: number; path: TimedPath }; down?: { t0: number; path: TimedPath } } | null {
    const cached = this.roads.get(i);
    if (cached !== undefined) return cached;
    // 一条腿上的车走同一条路线、同一条速度曲线（roads.ts，社会车流也按它让这些车），只是出发的时刻不同
    const seed = this.stays[i]?.visit.seed ?? 0.5;
    const up = this.ways?.up(seed);
    const down = this.ways?.down(seed);
    const r = up || down ? { ...(up ? { up: { t0: p.tIn - up.path.duration, path: up.path } } : {}), ...(down ? { down: { t0: p.tOut, path: down.path } } : {}) } : null;
    this.roads.set(i, r);
    return r;
  }

  update(t: number): void {
    for (const p of this.all) p.begin();
    const site = this.site;
    const lot = this.lot;
    if (!site) {
      for (const p of this.all) p.end();
      return;
    }
    const Y = 0.3;
    const c = Math.cos(site.rot);
    const s = Math.sin(site.rot);
    const W = (x: number, z: number) => ({ x: site.center.x + x * c + z * s, z: site.center.z - x * s + z * c });
    if (!lot) {
      // 车流还在后台排：先把这时候停着的车摆在车位上
      this.stays.forEach((st, i) => {
        if (t < st.arrive || t > st.leave || st.mode === 'drive' || st.mode === 'long') return;
        const sl = site.lot.stalls[st.stall];
        if (!sl) return;
        const m = modelOf(st.visit);
        const back = sl.d / 2 - (m.len / 2 + 0.3);
        const lx = sl.x + Math.sin(sl.heading) * back;
        const lz = sl.z + Math.cos(sl.heading) * back;
        const h = (st.mode === 'back' || st.mode === 'through' ? sl.heading + Math.PI : sl.heading) + site.rot;
        const w = W(lx - (Math.sin(h - site.rot) * m.len) / 2, lz - (Math.cos(h - site.rot) * m.len) / 2);
        this.pools.get(m.key as Slot)?.put(w.x, Y, w.z, h - Math.PI / 2, 0, 1, 1, 1, this.colors[Math.floor(st.visit.seed * 977) % this.colors.length] as THREE.Color);
        void i;
      });
    }
    (lot?.plans ?? []).forEach((p, i) => {
      if (!p || t < p.tIn - 400 || t > p.tOut + 400) return;
      let x: number;
      let z: number;
      let h: number;
      let speed = 0;
      let accel = 0;
      let rev = false;
      let brake = false;
      let tr: { x: number; z: number; heading: number } | undefined;
      if (planPose(p, t, this.lp)) {
        const w = W(this.lp.x, this.lp.z);
        x = w.x;
        z = w.z;
        h = this.lp.heading + site.rot;
        speed = this.lp.speed;
        accel = this.lp.accel;
        rev = this.lp.rev;
        brake = this.lp.brake;
        if (this.lp.tr) {
          const tw = W(this.lp.tr.x, this.lp.tr.z);
          tr = { x: tw.x, z: tw.z, heading: this.lp.tr.heading + site.rot };
        }
      } else {
        const r = this.road(i, p);
        const seg = r?.up && t >= r.up.t0 && t < p.tIn ? r.up : r?.down && t > p.tOut && t <= r.down.t0 + r.down.path.duration ? r.down : undefined;
        if (!seg) return;
        seg.path.at(t - seg.t0, this.st);
        x = this.st.x;
        z = this.st.z;
        h = this.st.heading;
        speed = this.st.speed ?? 0;
        accel = this.st.accel ?? 0;
      }
      const m = p.model;
      const yaw = h - Math.PI / 2;
      const dx = Math.sin(h);
      const dz = Math.cos(h);
      const color = this.colors[Math.floor((this.stays[i]?.visit.seed ?? 0) * 977) % this.colors.length] as THREE.Color;
      const L = m.len;
      const rear = { x: x - (dx * L) / 2, z: z - (dz * L) / 2 };
      this.pools.get(m.key as Slot)?.put(rear.x, Y, rear.z, yaw, Math.max(-0.03, Math.min(0.03, -accel * 0.01)), 1, 1, 1, m.key === 'rv' ? '#f2eee6' : color);
      if (m.trailer) {
        // 拖车：车轴的位置和朝向（拖车运动学），模型原点在拖车车尾
        const tt = tr ?? { x: x - dx * (m.trailer.hitch + m.trailer.tongue), z: z - dz * (m.trailer.hitch + m.trailer.tongue), heading: h };
        const tdx = Math.sin(tt.heading);
        const tdz = Math.cos(tt.heading);
        this.pools.get(m.trailer.key as Slot)?.put(tt.x - tdx * m.trailer.axleX, Y, tt.z - tdz * m.trailer.axleX, tt.heading - Math.PI / 2, 0, 1, 1, 1, '#f4f2ec');
      }
      // 车灯：刹车（减速、路上停着等）、倒车灯；夜里尾灯、开着的车开大灯
      const sx = Math.cos(h) * (m.wid / 2 - 0.25);
      const sz = -Math.sin(h) * (m.wid / 2 - 0.25);
      const nose = { x: x + (dx * L) / 2, z: z + (dz * L) / 2 };
      for (const k of [-1, 1]) {
        if (brake || rev) this.brake.put(rear.x + sx * k, Y + 0.78, rear.z + sz * k, yaw, 0, 1, 1, 1, rev ? '#ffffff' : '#ff2a1a');
        else if (this.night > 0.3) this.tail.put(rear.x + sx * k, Y + 0.78, rear.z + sz * k, yaw);
        if (this.night > 0.3 && speed > 0.05) this.heads.put(nose.x + sx * k, Y + 0.68, nose.z + sz * k, yaw);
      }
      // 后备厢：装车的时候、取货交付的时候掀开
      const v = this.stays[i]?.visit;
      const hnd = v?.handoff;
      const open = (this.stands.get(i) ?? []).some((q) => t >= q.t0 && t <= q.t1) || (hnd !== undefined && (v?.kind === 'pickup' ? t > hnd - 40 && t < hnd + 3 : v?.kind === 'drive' ? t > hnd - 25 && t < hnd + 2 : v?.kind === 'locker' ? t > hnd - 10 && t < hnd + 2 : false));
      if (open && t >= p.arrive && t <= p.leave) this.trunks.put(rear.x + dx * 1.05, Y + 1.0, rear.z + dz * 1.05, yaw, -1.05, 1, 1, 1, color);
    });
    // 人、推着的购物车、装车的人
    const people = this.people;
    if (people) {
      const ped = (lx: number, lz: number, lh: number, shirt: string, cart: boolean, moving: boolean, vest: boolean) => {
        const w = W(lx, lz);
        const hh = lh + site.rot;
        const bob = moving ? Math.abs(Math.sin(t * 7.5)) * 0.04 : 0;
        this.pBody.put(w.x, Y + 0.12 + bob, w.z, hh - Math.PI / 2, 0, 1, 1, 1, vest ? '#f2a900' : shirt);
        this.pHead.put(w.x, Y + 0.12 + bob, w.z, hh - Math.PI / 2, 0, 1, 1, 1, '#ffffff');
        if (cart) this.carts.put(w.x + Math.sin(hh) * 0.9, Y, w.z + Math.cos(hh) * 0.9, hh - Math.PI / 2);
      };
      for (const w of people.walks) if (t >= w.t0 && t <= w.t1) {
        const q = walkAt(w, t);
        ped(q.x, q.z, q.h, SHIRTS[w.shirt % SHIRTS.length] as string, w.cart, true, w.vest);
      }
      for (const q of people.stands) if (t >= q.t0 && t <= q.t1) ped(q.x, q.z, q.heading + Math.PI, SHIRTS[q.shirt % SHIRTS.length] as string, q.cart, false, false);
      for (const q of people.strays) if (t >= q.t0 && t <= q.t1) {
        const w = W(q.x, q.z);
        this.carts.put(w.x, Y, w.z, site.rot + 0.4);
      }
      site.lot.corrals.forEach((cr, ci) => {
        const n = Math.min(20, corralCount(people, ci, t));
        for (let k = 0; k < n; k++) {
          const w = W(cr.x, cr.z - cr.d / 2 + 0.7 + k * 0.32);
          this.carts.put(w.x, Y, w.z, site.rot);
        }
      });
      for (const tr of people.trains) if (t >= tr.t0 && t <= tr.t1) {
        const len = tr.cum[tr.cum.length - 1] as number;
        const sPos = Math.min(len, ((t - tr.t0) / Math.max(1, tr.t1 - tr.t0)) * len);
        const q = along(tr.pts, tr.cum, sPos);
        ped(q.x, q.z, q.h, '#f2a900', false, true, true);
        for (let k = 0; k < Math.min(20, tr.n); k++) {
          const cpos = along(tr.pts, tr.cum, Math.min(len, sPos + 1.0 + k * 0.34));
          const w = W(cpos.x, cpos.z);
          this.carts.put(w.x, Y, w.z, cpos.h + site.rot - Math.PI / 2);
        }
      }
    }
    for (const p of this.all) p.end();
  }
}
