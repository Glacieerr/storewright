import * as THREE from 'three';
import { box, merge, wheel } from '../../../../../StoreX/web/src/three/models';
import type { WVehicle } from '../../../../src/sim/trace';
import { dockXs, EXT, toWorld, type Site } from '../stores';
import { ease, lerp, Pool, prog } from './kit';
import { currentFacilities } from '../../../../src/facility/state';
import { crewOf, shiftOf } from '../../../../src/facility/config';
import type { SiteInfo } from '../store';

/**
 * 综合店收货区：百货馆北墙的收货口（门里是 1.1 米高的收货台），按第一部分的卸货口做法（决策记录 0013、0018）：
 * 车倒车靠稳以后先放轮挡、挂上车辆锁（门边的信号灯由绿变红），这时卷帘门才升起、调平板搭进车厢；
 * 电动搬运车按这一车的托盘数一趟趟进车厢把托盘拉出来（一个车厢同时只进一台设备），放到门两侧收货台上的暂存位（两列、每列 4 板），
 * 满了以后最早的几板由理货员推去后仓 / 卖场（一板板消失）。卸完卷帘门落下、松开车辆锁、撤轮挡，信号灯变绿，车再拉出。
 * 靠稳、拉出的时刻和收货场引擎排的一样（setDay 的 yard）。镜头拉近（屋顶隐藏）时看得见收货台上的搬运车和托盘。
 */

const DOCK_Y = 1.1;
const DOOR_W = 3.2;
const DOOR_H = 3.4;
/** 搬运车车身中心到托盘中心 1.6 米 */
const REACH = 1.6;
const LANE_X = [2.0, 3.2];
const LANE_Z = [2.4, 3.75, 5.1, 6.45];
const TRIP = 40;

interface Visit {
  site: Site;
  dock: number;
  vid: number;
  label: string;
  t0: number;
  docked: number;
  t1: number;
  pallets: number;
  trips: { t0: number; t1: number }[];
}

/** 电动搬运车（步行式）：电池箱、操纵杆、两根货叉；原点在车身中心的地面，货叉朝 +x */
function palletJack(): THREE.BufferGeometry {
  return merge([box(0.75, 1.25, 0.8, '#d0402b', -0.3, 0.12, 0), box(0.2, 0.05, 0.2, '#2b2f35', -0.6, 1.37, 0), box(0.06, 0.9, 0.06, '#2b2f35', -0.75, 1.0, 0), box(0.06, 0.06, 0.5, '#2b2f35', -0.95, 1.85, 0), wheel(0.12, 0.08, '#1d1d1d', -0.35, 0.12, 0)]);
}
function jackForks(): THREE.BufferGeometry {
  return merge([box(1.15, 0.08, 0.16, '#5b6067', 0.65, 0, 0.27), box(1.15, 0.08, 0.16, '#5b6067', 0.65, 0, -0.27), box(0.12, 0.5, 0.7, '#5b6067', 0.06, 0, 0)]);
}
function palletLoad(): THREE.BufferGeometry {
  return merge([box(1.0, 0.14, 1.2, '#b08a5a', 0, 0, 0), box(0.96, 1.2, 1.16, '#ffffff', 0, 0.14, 0), box(0.97, 0.05, 1.17, '#d9d9d9', 0, 1.33, 0)]);
}

export class StoreDocks {
  readonly group = new THREE.Group();
  /** 店前停车场、即时取货、收货场此刻的情况（store/ 给，监控面板的综合店页用） */
  siteInfo: ((t: number) => SiteInfo | undefined) | undefined;
  private doors: Pool;
  private lights: Pool;
  private chocks: Pool;
  private plates: Pool;
  private jacks: Pool;
  private forks: Pool;
  private pallets: Pool;
  private visits: Visit[] = [];
  private sites: Site[] = [];
  private planT: (vid: number, t: number) => number | undefined = (_, x) => x;

  constructor() {
    this.group.name = 'store-docks';
    const VC = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
    this.doors = new Pool(merge([box(DOOR_W, 1, 0.1, '#d4d8dc', 0, 0, 0), box(DOOR_W, 0.06, 0.12, '#9aa0a6', 0, 0.5, 0)]), VC, 16, 'store-dock-doors', false);
    this.plates = new Pool(merge([box(2.2, 0.08, 0.7, '#7d8288', 0, -0.08, 0.35), box(2.2, 0.05, 0.12, '#f0c419', 0, 0, 0.66)]), VC, 16, 'store-dock-plates', false);
    this.jacks = new Pool(palletJack(), VC, 16, 'pallet-jacks');
    this.forks = new Pool(jackForks(), VC, 16, 'pallet-jack-forks', false);
    this.pallets = new Pool(palletLoad(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 160, 'store-pallets');
    // 门边的信号灯（红：车靠着、不能动车；绿：可以靠台 / 可以拉出）、轮挡和车辆锁（黄色）
    this.lights = new Pool(new THREE.BoxGeometry(0.28, 0.28, 0.12), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 32, 'store-dock-lights', false);
    this.chocks = new Pool(merge([box(0.35, 0.28, 0.5, '#e9b730', 0, 0, 0), box(0.6, 0.18, 0.25, '#e9b730', 0, 0, 0.6)]), VC, 32, 'store-dock-chocks');
    for (const p of [this.doors, this.plates, this.jacks, this.forks, this.pallets, this.lights, this.chocks]) this.group.add(p.mesh);
  }

  /** 当天到门店卸货的车：哪个收货口、什么时段靠台、几板货 */
  setDay(sites: Map<string, Site>, list: WVehicle[], resolve: (vehicle: number, key: string) => string | undefined, palletsOf: (vid: number) => number | undefined, yard?: (vid: number, t0: number) => { docked: number; pullout: number } | undefined): void {
    this.sites = [...sites.values()];
    this.visits = [];
    for (const v of list) {
      v.segs.forEach((sg, si) => {
        if (!sg.place || sg.route || sg.loop) return;
        const key = resolve(v.id, sg.place) ?? sg.place;
        const [code, k] = key.split('#');
        const site = sites.get(code as string);
        if (!site || key.includes(':')) return;
        const dock = k ? Number(k) - 1 : 0;
        if (dock >= dockXs().length || dock >= site.docks.length) return;
        const prev = v.segs[si - 1];
        const dur = sg.t1 - sg.t0;
        const yt = yard?.(v.id, sg.t0);
        const docked = yt ? yt.docked : sg.t0 + (prev && (prev.route || prev.pts.length > 2) ? Math.min(100, dur * 0.35) : 0);
        const t1 = yt ? Math.max(docked + 120, yt.pullout) : sg.t1;
        const n = Math.max(2, Math.min(26, Math.round(palletsOf(v.id) ?? 10)));
        // 靠稳 → 放轮挡、挂车辆锁（20 秒）→ 门升起（10 秒）→ 第一趟；最后一趟完 → 门落下 → 松锁、撤轮挡 → 拉出
        const a0 = docked + 45;
        const a1 = t1 - 60;
        // 收货员（每人开一台电动搬运车）少于同时卸货的收货口：每一趟要多等
        const recv = Math.max(1, crewOf(currentFacilities().store.staff, 'recv', shiftOf(((docked / 3600) % 24 + 24) % 24)));
        const busy = list.filter((o) => o.segs.some((x) => x.place && !x.route && !x.loop && (resolve(o.id, x.place) ?? x.place).startsWith(site.st.key) && !(resolve(o.id, x.place) ?? x.place).includes(':') && x.t0 < sg.t1 && sg.t0 < x.t1)).length;
        const trip = Math.max(16, Math.min(TRIP * Math.max(1, busy / recv), (a1 - a0) / n));
        this.visits.push({ site, dock, vid: v.id, label: v.label, t0: sg.t0, docked, t1, pallets: n, trips: Array.from({ length: n }, (_, j) => ({ t0: a0 + j * trip, t1: a0 + (j + 1) * trip })) });
      });
    }
  }

  update(t: number, planT: (vid: number, t: number) => number | undefined): void {
    this.planT = planT;
    for (const p of [this.doors, this.plates, this.jacks, this.forks, this.pallets, this.lights, this.chocks]) p.begin();
    for (const site of this.sites) {
      const W = (lx: number, lz: number) => toWorld(site, lx, lz);
      const rot = site.rot;
      dockXs().forEach((x, k) => {
        const vs = this.visits.find((v) => v.site === site && v.dock === k && this.tv(v, t) >= v.t0 && this.tv(v, t) < v.t1 + 30);
        const tt = vs ? this.tv(vs, t) : t;
        // 靠稳 20 秒后（轮挡、车辆锁好了）门才升起；拉出前 25 秒门落下
        const open = vs ? Math.min(ease(prog(tt, vs.docked + 20, vs.docked + 30)), 1 - ease(prog(tt, vs.t1 - 25, vs.t1 - 10))) : 0;
        const held = !!vs && tt >= vs.docked + 5 && tt < vs.t1 - 5;
        // 信号灯：门右边墙上，车靠着时红、空着时绿
        const lp = W(x + 2.6, EXT.z0 - 0.08);
        this.lights.put(lp.x, 2.3, lp.z, rot, 0, 1, 1, 1, held ? '#ff3b30' : '#2ecc71');
        if (held) {
          // 轮挡：挂车后轴前面（司机一侧），车辆锁：门下面的挂钩
          const cp = W(x - 1.25, EXT.z0 - 2.7);
          this.chocks.put(cp.x, 0.3, cp.z, rot + Math.PI / 2);
          const rp = W(x, EXT.z0 - 0.35);
          this.chocks.put(rp.x, 0.55, rp.z, rot, 0, 0.8, 0.8, 0.8);
        }
        const h = DOOR_H * (1 - open * 0.92);
        const dp = W(x, EXT.z0 + 0.2);
        // 门板朝北（本地 −z）：绕 y 转 rot 让门面跟墙平行
        this.doors.put(dp.x, DOCK_Y + DOOR_H - h, dp.z, rot, 0, 1, h, 1);
        if (open > 0.5) {
          const pp = W(x, EXT.z0 + 0.2);
          this.plates.put(pp.x, DOCK_Y, pp.z, rot + Math.PI, 0, 1, 1, 1);
        }
      });
    }
    for (const vs of this.visits) this.drawVisit(vs, this.tv(vs, t));
    for (const p of [this.doors, this.plates, this.jacks, this.forks, this.pallets, this.lights, this.chocks]) p.end();
  }

  private tv(vs: Visit, t: number): number {
    return this.planT(vs.vid, t) ?? t;
  }

  /** 一次靠台：收货台上的暂存托盘、进出车厢的搬运车 */
  private drawVisit(vs: Visit, t: number): void {
    const site = vs.site;
    const x0 = dockXs()[vs.dock] as number;
    const z0 = EXT.z0;
    const W = (lx: number, lz: number) => toWorld(site, lx, lz);
    const rot = site.rot;
    // 本地朝向：朝北（进车厢）= π/2，朝东 = 0，朝西 = π
    const NORTH = Math.PI / 2;
    const slot = (j: number) => {
      const side = j % 2 === 0 ? 1 : -1;
      const q = Math.floor(j / 2);
      return { x: x0 + side * (LANE_X[q % 2] as number), z: z0 + (LANE_Z[Math.floor(q / 2) % LANE_Z.length] as number), side };
    };
    // 暂存位：每板从放下到被推走（8 趟以后，一共 16 个位置轮着用）
    for (let j = 0; j < vs.pallets; j++) {
      const tr = vs.trips[j] as { t0: number; t1: number };
      const placed = tr.t0 + (tr.t1 - tr.t0) * 0.72;
      const later = vs.trips[j + 8];
      const gone = later ? later.t0 : vs.t1 + 300 + (j % 8) * 45;
      if (t < placed || t >= gone) continue;
      const sp = slot(j);
      const p = W(sp.x, sp.z);
      this.pallets.put(p.x, DOCK_Y, p.z, rot, 0, 1, 1, 1, '#ffffff');
    }
    if (t < vs.docked || t >= vs.t1) return;
    const home = { x: x0, z: z0 + 1.4 };
    const k = vs.trips.findIndex((x) => t >= x.t0 && t < x.t1);
    if (k < 0) {
      const p = W(home.x, home.z);
      this.jacks.put(p.x, DOCK_Y, p.z, NORTH + rot);
      this.forks.put(p.x, DOCK_Y + 0.06, p.z, NORTH + rot);
      return;
    }
    const tr = vs.trips[k] as { t0: number; t1: number };
    const f = prog(t, tr.t0, tr.t1);
    const sp = slot(k);
    const deep = z0 - 3 - (k % 5) * 1.6;
    let x = home.x;
    let z = home.z;
    let yaw = NORTH;
    let carry = false;
    let forkY = DOCK_Y + 0.06;
    const face = sp.side > 0 ? 0 : Math.PI;
    if (f < 0.45) {
      // 进车厢（0–0.4）→ 叉起（0.4–0.6）→ 倒出来（0.6–1）
      const g = f / 0.45;
      z = g < 0.4 ? lerp(home.z, deep, ease(g / 0.4)) : g < 0.6 ? deep : lerp(deep, home.z, ease((g - 0.6) / 0.4));
      carry = g >= 0.5;
      forkY = DOCK_Y + (g >= 0.4 && g < 0.6 ? 0.06 + 0.1 * Math.min(1, (g - 0.4) / 0.1) : carry ? 0.16 : 0.06);
      // 车厢地板比收货台高 0.15 米
      if (z < z0) forkY += 0.15;
    } else {
      // 倒到暂存位那一排（0–0.3）→ 转向（0.3–0.45）→ 往前放下（0.45–0.55，第二列多走 1.2 米）→ 转回（0.55–0.7）→ 回门口（0.7–1）
      const g = (f - 0.45) / 0.55;
      z = g < 0.3 ? lerp(home.z, sp.z, ease(g / 0.3)) : g < 0.7 ? sp.z : lerp(sp.z, home.z, ease((g - 0.7) / 0.3));
      if (g >= 0.3 && g < 0.45) yaw = lerp(NORTH, face, ease((g - 0.3) / 0.15));
      else if (g >= 0.45 && g < 0.55) {
        yaw = face;
        x = home.x + sp.side * (Math.abs(sp.x - x0) - REACH) * Math.sin(((g - 0.45) / 0.1) * Math.PI);
      } else if (g >= 0.55 && g < 0.7) yaw = lerp(face, NORTH, ease((g - 0.55) / 0.15));
      carry = g < 0.5;
      forkY = DOCK_Y + (carry ? 0.16 : 0.06);
    }
    const p = W(x, z);
    const wy = yaw + rot;
    const y = z < z0 ? DOCK_Y + 0.15 : DOCK_Y;
    this.jacks.put(p.x, y, p.z, wy);
    this.forks.put(p.x, forkY, p.z, wy);
    if (carry) this.pallets.put(p.x + Math.cos(wy) * REACH, forkY + 0.04, p.z - Math.sin(wy) * REACH, wy, 0, 1, 1, 1, '#ffffff');
  }

  /** 设施管理台的指标：到货车次、托盘、平均卸货时间、收货员够不够 */
  kpi(): { label: string; value: string; bad?: boolean }[] {
    const v = this.visits;
    const dwell = v.map((x) => (x.t1 - x.docked) / 60);
    const slow = v.filter((x) => x.trips.length && (x.trips[0] as { t1: number; t0: number }).t1 - (x.trips[0] as { t0: number }).t0 > TRIP + 0.5).length;
    return [
      { label: '到货车次 / 托盘', value: `${v.length} 车 / ${v.reduce((a, x) => a + x.pallets, 0)} 板` },
      { label: '平均卸货时间', value: `${(dwell.reduce((a, b) => a + b, 0) / Math.max(1, dwell.length)).toFixed(0)} 分钟 / 车` },
      { label: '收货员不够要等的车次', value: `${slow} 车`, bad: slow > 0 },
      { label: '收货口', value: `${dockXs().length} 个` },
    ];
  }

  /** 门店收货监控：每个收货口此刻的车和卸货进度、下一辆 */
  info(t: number): { docks: { id: string; vid?: number; label?: string; done?: number; n?: number; until?: number; next?: { label: string; t: number } }[]; today: number; pallets: number; site?: SiteInfo } {
    const docks = this.sites.flatMap((site) =>
      dockXs().map((_, k) => {
        const vs = this.visits.find((v) => v.site === site && v.dock === k && t >= v.t0 && t < v.t1);
        const next = this.visits.filter((v) => v.site === site && v.dock === k && v.t0 > t).sort((a, b) => a.t0 - b.t0)[0];
        return { id: `收货口 ${k + 1}`, ...(vs ? { vid: vs.vid, label: vs.label, done: vs.trips.filter((x) => x.t1 <= t).length, n: vs.pallets, until: vs.t1 } : {}), ...(next ? { next: { label: next.label, t: next.t0 } } : {}) };
      }),
    );
    const site = this.siteInfo?.(t);
    return { docks, today: this.visits.length, pallets: this.visits.reduce((s, v) => s + v.pallets, 0), ...(site ? { site } : {}) };
  }
}
