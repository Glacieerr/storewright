import * as THREE from 'three';
import type { AgentTrace } from '../../../../../StoreX/src/ops/trace';
import type { HubDay } from '../../../../src/hub/types';
import type { Stall } from '../../../../src/site/lot';
import { siteOps } from '../../../../src/site/ops';
import { planStays, type StayPlan } from '../../../../src/site/stays';
import { storeTruckVisits, yardTurns, type TruckTurn, type TruckVisit } from '../../../../src/site/trucks';
import { deriveVisits, isPickup, type CarVisit } from '../../../../src/site/visits';
import type { WVehicle } from '../../../../src/sim/trace';
import type { LightSpot } from '../lamps';
import type { RoadNet } from '../roadnet';
import { dockXs, type Site } from '../stores';
import { scheduleYard, setSiteVisits, simVisitFor, simVisitId, siteSchedule, type YardSchedule, type YardVehicle, type YardVisit } from '@storewright/yard';
import { StoreTraffic } from './cars';
import { StoreRoads } from './roads';
import { modelOf, planSiteTraffic, type LotTraffic } from '../../../../src/site/motion';
import type { RoadRun } from '../motion';
import { planPeople, type People } from '../../../../src/site/people';
import { approachPhase, STOP_BACK } from '../signals';
import type { SiteReply, SiteRequest } from '../../siteWorker';
import type { Line } from '../roadnet';
import { buildLotView, type LotView } from './lotMesh';
import { drain, type Steps } from '../ops/kit';

/**
 * 综合店站点的三维和数据（店前停车场、即时取货区、收货场）：
 * - 静态部分（lotMesh.ts）：地面、标线、绿岛、灯杆、回收栏、雨棚、指示牌、收货场的车道线；
 * - 停车场里的车和人（cars.ts）：按车位安排（src/site/stays.ts）一辆辆走完整趟，顾客走进店门、推着购物车回来；
 * - 收货场：当天到门店卸货的车（区域仿真的轨迹）按收货场引擎排成一份排程（先到先进、一辆车调车、驶离优先），
 *   登记给区域的运动规划（motion.ts 按它开仿真的车）；值班助手的数据（src/site/ops.ts 的 HubDay）用同一份车位安排和排程。
 * StoreX 门店模型自带的格子停车场藏起来，店里的人从店门接上（setStoreAgents 时把停车场的车去掉，店外几个点挪到新的位置上）。
 */
export interface SiteInfo {
  /** 此刻：店前停着的车 / 普通车位、员工车位占用、即时取货车位、免下车取货道、在路上进出的车 */
  front: { used: number; total: number };
  staff: { used: number; total: number };
  pickup: { used: number; total: number };
  drive: { used: number; total: number; waiting: number };
  /** 今天到现在：取货的车、平均等待（分钟）、5 分钟内交付的比例 */
  pickups: number;
  waitMean: number;
  within5: number;
  /** 收货场：此刻在待命车位 / 进场道路上排队的车、今天最多排几辆、货车平均周转（分钟） */
  yardQueue: number;
  yardQueueMax: number;
  turnMean: number;
  /** 收货场布置（完整 / 紧凑 / 只有靠台车道）和说明 */
  yardLevel: string;
  yardNotes: string[];
}

export class StoreSiteView {
  readonly group = new THREE.Group();
  readonly traffic = new StoreTraffic();
  readonly lot: LotView;
  private agents: readonly AgentTrace[] = [];
  private gen: 'gen1' | 'storex' = 'storex';
  private seed = 1;
  visits: CarVisit[] = [];
  plan: StayPlan | undefined;
  trucks: TruckVisit[] = [];
  turns: TruckTurn[] = [];
  schedule: YardSchedule | undefined;
  /** 登记给收货场引擎的访问（和 trucks 一一对应） */
  yardVisits: YardVisit[] = [];
  private hubCache: HubDay | undefined;
  people: People | undefined;
  lotTraffic: LotTraffic | undefined;
  private hubJob: ((vid: number, arrive: number) => string | undefined) | undefined;

  constructor(
    readonly site: Site,
    private readonly net: RoadNet,
  ) {
    this.group.name = 'store-site-view';
    this.lot = buildLotView(site);
    this.group.add(this.lot.group, this.traffic.group);
  }

  /** 地面（交给天气） */
  get surface(): THREE.Group {
    return this.lot.surface;
  }
  get lamps(): LightSpot[] {
    return this.lot.lamps;
  }

  setSeed(seed: number): void {
    if (seed === this.seed) return;
    this.seed = seed;
    this.replan();
  }

  /** StoreX 门店仿真的轨迹（所有人和车）：排当天停车场的来车和车位 */
  setAgents(agents: readonly AgentTrace[], gen: 'gen1' | 'storex'): void {
    this.agents = agents;
    this.gen = gen;
    this.replan();
  }

  private replan(): void {
    this.visits = this.agents.length ? deriveVisits(this.agents, { seed: this.seed, generation: this.gen }) : [];
    this.plan = planStays(this.site.lot, this.visits, this.seed);
    this.people = planPeople(this.site.lot, this.plan.stays, this.seed);
    // 进店路在停车场模型里的两头：干道路口后面的起点、出去的停止线（本地 z）；干道路口的信号灯
    const net = this.net;
    const site = this.site;
    const access = net.lines[site.access.line] as Line;
    const at = net.storeAttach.get(site.st.key);
    const j = at ? net.junctions.get(at.junction) : undefined;
    const zIn = site.access.attachZ - (access.trimA + 4);
    const zStop = site.access.attachZ - (access.trimA + STOP_BACK);
    const ways = new StoreRoads(site, net, zIn, zStop);
    const legs = ways.legs;
    const stays = this.plan.stays;
    const inPhase = stays.map((st) => {
      if (!j || !at || !legs.length) return undefined;
      const leg = ways.inLeg(st.visit.seed);
      return leg ? approachPhase(j, leg.line, at.junction) : undefined;
    });
    // 进店路上 4 米 / 秒（绿灯放行时一辆接一辆，车头间隔 2 秒左右）
    // 车头过干道路口停止线比到进店路起点早几秒（按这条腿的路线和车长）：停车场的车流按它挑绿灯，和社会车流的信号配时一样
    const inLead = stays.map((st) => ways.inLead(st.visit.seed, modelOf(st.visit)));
    const road = { zIn, zStop, speed: 4.0, signal: { offset: j?.offset ?? 0, inPhase, outPhase: j && at ? approachPhase(j, access, at.junction) : undefined, inLead } };
    // 先画停着的车和人；车流在后台线程排（一整天要几秒），排好了再换上
    this.lotTraffic = undefined;
    this.ways = ways;
    this.runs = undefined;
    this.traffic.setDay(site, net, this.plan, undefined, this.people, zIn, zStop, ways);
    this.hubCache = undefined;
    const id = ++this.reqId;
    const req: SiteRequest = { id, lot: site.lot, plan: this.plan, people: this.people, road, seed: this.seed };
    if (typeof Worker === 'undefined') {
      const r = planSiteTraffic(site.lot, this.plan, this.seed, road);
      this.people = r.people;
      this.traffic.setDay(site, net, this.plan, undefined, this.people, zIn, zStop, ways);
      this.lotTraffic = r.res;
      this.traffic.setLot(this.lotTraffic);
      this.onPlan?.();
      return;
    }
    this.worker ??= new Worker(new URL('../../siteWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SiteReply>) => {
      if (e.data.id !== this.reqId || !e.data.res) {
        if (e.data.error) console.warn('停车场车流没排出来：', e.data.error);
        return;
      }
      // 换过车位的：用改过的车位安排和重排的人
      if (e.data.plan && e.data.people) {
        this.plan = e.data.plan;
        this.people = e.data.people;
        this.traffic.setDay(site, net, this.plan, undefined, this.people, zIn, zStop, ways);
      }
      this.lotTraffic = e.data.res;
      this.workerMs = e.data.ms ?? 0;
      this.traffic.setLot(e.data.res);
      this.hubCache = undefined;
      this.runs = undefined;
      this.onPlan?.();
    };
    this.worker.postMessage(req);
  }
  /** 后台线程排停车场车流用了多少毫秒（上一次） */
  workerMs = 0;
  /** 停车场的车流排好了（社会车流要按这一天的车重算：背景车让它们） */
  onPlan: (() => void) | undefined;
  private ways: StoreRoads | undefined;
  private runs: RoadRun[] | undefined;

  /** 当天每辆车在干道和进店路上的行驶（交给社会车流的后台线程，背景车跟在后面、过路口和它错开）；车流还没排好是空的 */
  roadRuns(): RoadRun[] {
    if (!this.lotTraffic || !this.plan || !this.ways) return [];
    this.runs ??= this.ways.runs(this.plan.stays, this.lotTraffic);
    return this.runs;
  }
  private worker: Worker | undefined;
  private reqId = 0;

  /**
   * 当天到门店卸货的车：排收货场（引擎的先到先进、一次一辆车调车、驶离优先），登记给区域的运动规划；
   * jobOf 给调度台的作业编号（值班助手按它把排队接到那一趟车上）。
   */
  setTrucks(list: readonly WVehicle[], resolve: (vid: number, key: string) => string | undefined, palletsOf: (vid: number) => number | undefined = () => undefined, jobOf: (vid: number) => string | undefined = () => undefined): void {
    drain(this.setTrucksSteps(list, resolve, palletsOf, jobOf));
  }

  /**
   * 和 setTrucks 一样，分三段（当天的访问、收货场排程、每辆车排队和占门的时段）：view.ts 换一天的车时分段排用，先后、结果都一样。
   * 收货场的排程（收货场引擎 scheduleYard）是一整段，排过的同一份访问直接用上次的。
   * Same as setTrucks, split into steps (visits, yard schedule, turns).
   */
  *setTrucksSteps(list: readonly WVehicle[], resolve: (vid: number, key: string) => string | undefined, palletsOf: (vid: number) => number | undefined = () => undefined, jobOf: (vid: number) => string | undefined = () => undefined): Steps {
    const key = this.site.st.key;
    const docks = dockXs(this.site.st.docks).length;
    this.trucks = storeTruckVisits(list, key, docks, resolve, undefined, palletsOf, jobOf);
    const kindOf: Record<TruckVisit['type'], YardVehicle> = { semi: 'semi', reefer: 'reefer', truck: 'truck', van: 'van' };
    // 访问的时刻用收货场引擎的 simVisitFor（和区域运动规划算的一样）；整天的访问登记成这个场地的一份排程，仿真的车和画面都按它走
    const visits: YardVisit[] = this.trucks.map((v) => {
      const seg = list.find((x) => x.id === v.vid)?.segs[v.seg];
      const sv = seg ? simVisitFor(key, v.vid, v.seg, kindOf[v.type], v.dock, seg.t0, seg.t1) : undefined;
      return sv ?? { id: simVisitId(v.vid, v.seg), vehicle: kindOf[v.type], door: v.dock, arrive: v.arrive, dockAt: v.dockAt, leaveAt: v.leaveAt, mode: 'live', own: true };
    });
    this.yardVisits = visits;
    this.turns = yardTurns(this.trucks);
    this.schedule = undefined;
    if (this.site.yard) {
      setSiteVisits(key, visits);
      yield;
      try {
        this.schedule = siteSchedule(key) ?? (visits.length ? scheduleYard(this.site.yard.plan, visits) : undefined);
      } catch {
        this.schedule = undefined;
      }
      yield;
      if (this.schedule) {
        const byId = new Map(this.schedule.timelines.map((tl) => [tl.visit.id, tl] as const));
        this.turns = this.trucks.map((v, i) => {
          const tl = byId.get((visits[i] as YardVisit).id);
          if (!tl) return this.turns[i] as TruckTurn;
          // 排队：到进场点（或场外等候）到开始进场调车；占着收货口：开始倒车到拉出离开门口
          const pull = tl.segs.find((sg) => sg.kind === 'pullout');
          return { visit: v, queue: [v.arrive, Math.max(v.arrive, tl.enterAt)], door: [tl.backAt, pull ? pull.t1 : Math.max(tl.backAt, tl.goneAt - 60)], gone: tl.goneAt } as TruckTurn;
        });
      }
    }
    this.hubCache = undefined;
  }

  /** 值班助手的数据：门店的停车场、即时取货、收货场一天的作业；jobOf 给调度台的作业编号（jobFromBoard） */
  hub(jobOf?: (vid: number, arrive: number) => string | undefined): HubDay | undefined {
    if (!this.plan) return undefined;
    if (this.hubCache && this.hubJob === jobOf) return this.hubCache;
    const turns = jobOf ? this.turns.map((t) => ({ ...t, visit: { ...t.visit, job: jobOf(t.visit.vid, t.visit.arrive) ?? t.visit.label } })) : this.turns;
    this.hubJob = jobOf;
    // 车实际停好、开走的时刻（停车场里让行以后）：画面和数一致
    const lp = this.lotTraffic?.plans;
    const plan = lp ? { ...this.plan, stays: this.plan.stays.map((st, i) => (lp[i] ? { ...st, arrive: (lp[i] as { arrive: number }).arrive, leave: (lp[i] as { leave: number }).leave } : st)) } : this.plan;
    this.hubCache = siteOps({ lot: this.site.lot, plan, turns, docks: dockXs(this.site.st.docks).length, queueSlots: this.site.yard?.plan.queue.slots ?? 0, generation: this.gen });
    return this.hubCache;
  }

  /** near = 镜头在店附近（远了不画停车场里的车和人） */
  update(t: number, near = true): void {
    this.traffic.group.visible = near;
    if (near) this.traffic.update(t);
  }

  /** 一辆车在收货口靠稳、开始拉出的时刻（收货场排程；没排上返回 undefined） */
  yardTimes(vid: number, t0: number): { docked: number; pullout: number } | undefined {
    const i = this.trucks.findIndex((x) => x.vid === vid && Math.abs(x.arrive - t0) < 1);
    if (i < 0) return undefined;
    const id = this.yardVisits[i]?.id;
    const tl = id ? this.schedule?.timelines.find((x) => x.visit.id === id) : undefined;
    if (tl) {
      const pull = tl.segs.find((sg) => sg.kind === 'pullout');
      return { docked: tl.dockedAt, pullout: pull ? pull.t0 : tl.goneAt - 60 };
    }
    const tt = this.turns[i] as TruckTurn;
    return { docked: tt.door[0] + 90, pullout: Math.max(tt.visit.leaveAt, tt.door[1] - 30) };
  }

  setNight(k: number): void {
    this.lot.setNight(k);
    this.traffic.setNight(k);
  }

  /** 设施监控的综合店页：停车场、即时取货、收货场此刻的情况 */
  info(t: number): SiteInfo {
    const lot = this.site.lot;
    const stays = this.plan?.stays ?? [];
    const staff = this.plan?.staffStalls ?? new Set<number>();
    const now = stays.filter((s) => s.arrive <= t && s.leave >= t);
    const at = (i: number) => lot.stalls[i] as Stall;
    const front = now.filter((s) => s.mode !== 'drive' && s.mode !== 'long' && at(s.stall)?.zone === 'front' && !staff.has(s.stall)).length;
    const staffN = now.filter((s) => s.mode !== 'drive' && s.mode !== 'long' && staff.has(s.stall)).length;
    const pick = now.filter((s) => s.mode !== 'drive' && s.mode !== 'long' && at(s.stall)?.zone === 'pickup').length;
    const drive = now.filter((s) => s.mode === 'drive').length;
    const driveWait = stays.filter((s) => s.mode === 'drive' && s.enter !== undefined && s.enter <= t && s.arrive > t).length;
    const done = stays.filter((s) => isPickup(s.visit.kind) && (s.visit.handoff ?? Infinity) <= t);
    const waits = done.map((s) => Math.max(0, (s.visit.handoff as number) - (s.enter ?? s.arrive)) / 60);
    const queue = this.turns.filter((tt) => tt.queue[0] <= t && tt.queue[1] > t && tt.queue[1] - tt.queue[0] > 30).length;
    let qmax = 0;
    const ev = this.turns.filter((tt) => tt.queue[1] - tt.queue[0] > 30).flatMap((tt) => [[tt.queue[0], 1], [tt.queue[1], -1]] as Array<[number, number]>).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let q = 0;
    for (const [, d] of ev) {
      q += d;
      qmax = Math.max(qmax, q);
    }
    const gone = this.turns.filter((tt) => tt.gone <= t);
    const frontTotal = lot.frontStalls.filter((i) => !staff.has(i)).length;
    const plan = this.site.yard?.plan;
    return {
      front: { used: front, total: frontTotal },
      staff: { used: staffN, total: staff.size },
      pickup: { used: pick, total: lot.pickup.length },
      drive: { used: drive, total: lot.drive.length, waiting: driveWait },
      pickups: done.length,
      waitMean: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      within5: waits.length ? (waits.filter((w) => w <= 5).length / waits.length) * 100 : 100,
      yardQueue: queue,
      yardQueueMax: qmax,
      turnMean: gone.length ? gone.reduce((a, tt) => a + (tt.gone - tt.queue[0]), 0) / gone.length / 60 : 0,
      yardLevel: plan ? (plan.level === 'full' ? '完整布置（四条车道）' : plan.level === 'compact' ? '紧凑布置（没有顶部车道）' : '只有靠台车道（在货车通道上排队）') : '—',
      yardNotes: plan?.notes ?? [],
    };
  }

  /**
   * StoreX 轨迹里走到店外的人（上一代车边交付的店员、免下车取货的送框小车）：店外的点挪到新停车场的位置上——
   * 车边交付走到对应即时取货车位那辆车的车尾，免下车取货走到取货位旁的墙边。
   */
  remapAgents(agents: readonly AgentTrace[]): AgentTrace[] {
    const lot = this.site.lot;
    const W = lot.west;
    const map = (x: number, y: number): [number, number] => {
      if (x >= 6) return [x, y];
      const lz = y - 35;
      if (y >= 44) return [W.driveX1 - 0.5 + 42, y];
      // 车边交付：最近的即时取货车位，站在车尾（车头朝墙，车尾在车道一侧）
      const s = lot.pickup.map((i) => lot.stalls[i] as Stall).sort((a, b) => Math.abs(a.z - lz) - Math.abs(b.z - lz))[0];
      if (!s) return [x, y];
      return x >= 4 ? [W.walkX + 0.5 + 42, s.z + 35] : [s.x - s.d / 2 - 0.4 + 42, s.z + 35];
    };
    return agents.map((a) => {
      if (a.kind === 'car' || a.kind === 'truck' || a.kind === 'van') return a;
      let touched = false;
      const segs = a.segs.map((sg) => {
        let out: number[] | undefined;
        for (let i = 0; i + 1 < sg.pts.length; i += 2) {
          if ((sg.pts[i] as number) < 6) {
            out ??= sg.pts.slice();
            const [nx, ny] = map(sg.pts[i] as number, sg.pts[i + 1] as number);
            out[i] = nx;
            out[i + 1] = ny;
          }
        }
        if (!out) return sg;
        touched = true;
        return { ...sg, pts: out };
      });
      return touched ? { ...a, segs } : a;
    });
  }
}
