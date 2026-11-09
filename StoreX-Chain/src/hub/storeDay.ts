import type { AgentTrace } from '../../../StoreX/src/ops/trace';
import type { StoreLot } from '../site/lot';
import { siteOps } from '../site/ops';
import { planStays, type StayPlan } from '../site/stays';
import { storeTruckVisits, yardTurns, type TruckTurn, type TruckVisit } from '../site/trucks';
import { deriveVisits } from '../site/visits';
import type { WVehicle } from '../sim/trace';
import { scheduleYard, simVisitFor, simVisitId, type YardPlan, type YardSchedule, type YardVehicle, type YardVisit } from '@storewright/yard';
import type { HubDay } from './types';

/**
 * 门店一天的作业（停车场、即时取货、收货场），没有三维的地方（孪生服务）用：和网页的门店场地（web/src/three/store/index.ts）同样的几步——
 * StoreX 门店仿真的轨迹 → 来车（deriveVisits）→ 车位安排（planStays）→ 到店货车（storeTruckVisits，访问时刻用收货场引擎的 simVisitFor）
 * → 收货场排程（scheduleYard，排队按待命车位先到先进）→ siteOps 出 HubDay。
 *
 * 和网页的一处差别：网页还在后台线程排停车场里的车流（让行以后车实际停好、开走的时刻，planLotTraffic，一天两三千辆车要排几秒），
 * 这里不排，停车时段按车位安排（网页在车流排好以前也是这样），停车场的几个数和网页会差一点；收货场、货车排队的数一样。
 */
export interface StoreDayInput {
  agents: readonly AgentTrace[];
  generation: 'gen1' | 'storex';
  seed: number;
  /** 门店的键（S01）和停车场 */
  store: string;
  lot: StoreLot;
  /** 收货口个数 */
  docks: number;
  /** 门店收货场：登记过的场地的键、场地布置（没有就按固定的进场、出场时间估货车的周转） */
  yard?: { key: string; plan: YardPlan };
  vehicles: readonly WVehicle[];
  resolve: (vid: number, key: string) => string | undefined;
  palletsOf?: (vid: number) => number | undefined;
  /** 调度台的作业编号（jobFromBoard）：值班助手按它把排队接到那一趟车上 */
  jobOf?: (vid: number, arrive: number) => string | undefined;
}

export interface StoreDay {
  hub: HubDay;
  plan: StayPlan;
  trucks: TruckVisit[];
  /** 登记给收货场引擎的访问（和 trucks 一一对应）、排出来的排程 */
  yardVisits: YardVisit[];
  schedule?: YardSchedule;
  /** 预约错峰用的场地排程输入：场地布置、当天的访问、HubDay 里货车的 flow 编号 → 访问编号（没有收货场就没有） */
  yard?: { plan: YardPlan; visits: YardVisit[]; visitOf: (flowId: string) => string | undefined };
}

const KIND: Record<TruckVisit['type'], YardVehicle> = { semi: 'semi', reefer: 'reefer', truck: 'truck', van: 'van' };

/** siteOps 里一辆到店货车的 flow 编号 */
export const truckFlowId = (v: Pick<TruckVisit, 'vid' | 'arrive'>): string => `T${v.vid}-${Math.round(v.arrive)}`;

export function storeDay(i: StoreDayInput): StoreDay {
  const visits = i.agents.length ? deriveVisits(i.agents, { seed: i.seed, generation: i.generation }) : [];
  const plan = planStays(i.lot, visits, i.seed);
  const trucks = storeTruckVisits(i.vehicles, i.store, i.docks, i.resolve, undefined, i.palletsOf ?? (() => undefined));
  const yardVisits: YardVisit[] = trucks.map((v) => {
    const seg = i.vehicles.find((x) => x.id === v.vid)?.segs[v.seg];
    const sv = seg && i.yard ? simVisitFor(i.yard.key, v.vid, v.seg, KIND[v.type], v.dock, seg.t0, seg.t1) : undefined;
    return sv ?? { id: simVisitId(v.vid, v.seg), vehicle: KIND[v.type], door: v.dock, arrive: v.arrive, dockAt: v.dockAt, leaveAt: v.leaveAt, mode: 'live', own: true };
  });
  let turns: TruckTurn[] = yardTurns(trucks);
  let schedule: YardSchedule | undefined;
  if (i.yard && yardVisits.length) {
    try {
      schedule = scheduleYard(i.yard.plan, yardVisits);
    } catch {
      schedule = undefined;
    }
  }
  if (schedule) {
    const byId = new Map(schedule.timelines.map((tl) => [tl.visit.id, tl] as const));
    turns = trucks.map((v, k) => {
      const tl = byId.get((yardVisits[k] as YardVisit).id);
      if (!tl) return turns[k] as TruckTurn;
      // 排队：到进场点（或场外等候）到开始进场调车；占着收货口：开始倒车到拉出离开门口（和网页一样）
      const pull = tl.segs.find((sg) => sg.kind === 'pullout');
      return { visit: v, queue: [v.arrive, Math.max(v.arrive, tl.enterAt)], door: [tl.backAt, pull ? pull.t1 : Math.max(tl.backAt, tl.goneAt - 60)], gone: tl.goneAt } as TruckTurn;
    });
  }
  const jobOf = i.jobOf;
  const named = jobOf ? turns.map((t) => ({ ...t, visit: { ...t.visit, job: jobOf(t.visit.vid, t.visit.arrive) ?? t.visit.label } })) : turns;
  const hub = siteOps({ lot: i.lot, plan, turns: named, docks: i.docks, queueSlots: i.yard?.plan.queue.slots ?? 0, generation: i.generation });
  return { hub, plan, trucks, yardVisits, ...(schedule ? { schedule } : {}), ...(i.yard ? { yard: storeYardOf(i.yard.plan, trucks, yardVisits) } : {}) };
}

/**
 * 预约错峰用的门店收货场输入（值班助手的 AssistCtx.yards）：场地布置、当天登记的访问、HubDay 里货车的 flow 编号 → 访问编号。
 * trucks 和 visits 一一对应（网页的门店场地有同样的 trucks、yardVisits，可以直接用它）。
 */
export function storeYardOf(plan: YardPlan, trucks: readonly TruckVisit[], visits: readonly YardVisit[]): { plan: YardPlan; visits: YardVisit[]; visitOf: (flowId: string) => string | undefined } {
  const ids = new Map(trucks.map((v, k) => [truckFlowId(v), visits[k]?.id] as const));
  return { plan, visits: [...visits], visitOf: (id) => ids.get(id) };
}
