import { createRng, hashString } from '@storewright/domain';
import type { AutoServiceConfig } from '@storewright/store-config';
import { Simulation } from './kernel';
import { mean, percentile } from './stats';
import { trafficDelaySec, type TrafficParams } from './traffic';

/**
 * 汽车快修中心（换机油、换轮胎）的离散事件仿真。
 *
 * 顾客按小时到达率随机到店；每个作业需要一个对应类型的工位和一名在岗技师，先到先服务。
 * 排队太长时，新到的顾客会直接离开（流失）。所有参数都是公开常识级的假设，可在场景中调整。
 */

export type ServiceKind = 'OIL' | 'TIRE';

export interface ServiceJob {
  id: string;
  kind: ServiceKind;
  arrive: number;
  start?: number;
  end?: number;
  /** 工位序号：机油工位在前，轮胎工位在后 */
  bay?: number;
  balked: boolean;
  revenue: number;
}

export interface AutoServiceParams {
  /** 各小时到店权重（长度 24，营业时间外自动为 0） */
  hourlyWeights: number[];
  tireShare: number;
  oilMin: [number, number];
  tireMin: [number, number];
  /** 某类作业排队车辆超过「工位数 × balkFactor」时，新到顾客离开 */
  balkFactor: number;
  /** 收入假设（美元） */
  oilPrice: [number, number];
  tireLabor: [number, number];
  /** 换轮胎的顾客同时购买一套新轮胎的比例与单价 */
  tirePurchaseRate: number;
  tirePrice: [number, number];
}

export const DEFAULT_AUTO_SERVICE: AutoServiceParams = {
  hourlyWeights: [0, 0, 0, 0, 0, 0, 0, 0.5, 0.8, 1.1, 1.2, 1.2, 1.1, 1.0, 0.9, 1.0, 1.2, 1.3, 0.9, 0.5, 0.2, 0, 0, 0],
  tireShare: 0.4,
  oilMin: [18, 32],
  tireMin: [30, 70],
  balkFactor: 2,
  oilPrice: [45, 85],
  tireLabor: [60, 140],
  tirePurchaseRate: 0.35,
  tirePrice: [90, 180],
};

export interface AutoServiceMetrics {
  arrivals: number;
  served: number;
  balked: number;
  avgWaitMin: number;
  p90WaitMin: number;
  avgTurnaroundMin: number;
  /** 工位利用率：作业时间 / 营业时间内的工位总时间 */
  bayUtil: number;
  revenue: number;
}

export interface AutoServiceResult {
  jobs: ServiceJob[];
  metrics: AutoServiceMetrics;
  /** 每小时在岗技师 */
  techs: number[];
}

/** 未指定日到店量时按工位数估算：每个机油工位约 9 辆、每个轮胎工位约 6 辆 */
export function defaultCarsPerDay(cfg: AutoServiceConfig): number {
  return cfg.carsPerDay > 0 ? cfg.carsPerDay : Math.round(cfg.oilBays * 9 + cfg.tireBays * 6);
}

export function simulateAutoService(cfg: AutoServiceConfig, seed: number, params: AutoServiceParams = DEFAULT_AUTO_SERVICE, traffic?: TrafficParams, demandFactor = 1): AutoServiceResult {
  const rng = createRng(hashString(cfg.id, seed >>> 0));
  const open = cfg.hours.openMin * 60;
  const close = cfg.hours.closeMin * 60;
  const bays = cfg.oilBays + cfg.tireBays;
  const techs = cfg.techs ?? Array.from({ length: 24 }, (_, h) => (h * 3600 >= open && h * 3600 < close ? bays : 0));

  // 到店时间：按营业时间内的小时权重分配全天车辆数（泊松），堵车让到店推后
  const lastArrival = close - 600;
  const weights = params.hourlyWeights.map((w, h) => (h * 3600 < lastArrival && (h + 1) * 3600 > open ? w : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const perDay = defaultCarsPerDay(cfg) * demandFactor;
  const jobs: ServiceJob[] = [];
  for (let h = 0; h < 24; h++) {
    const n = rng.poisson((perDay * (weights[h] ?? 0)) / total);
    for (let k = 0; k < n; k++) {
      const planned = h * 3600 + rng.uniform(0, 3600);
      const delay = trafficDelaySec(traffic, planned - 900, 900, rng.next());
      const arrive = Math.round(Math.min(lastArrival, Math.max(open, planned + delay)));
      let kind: ServiceKind = rng.chance(params.tireShare) ? 'TIRE' : 'OIL';
      if (kind === 'TIRE' && cfg.tireBays === 0) kind = 'OIL';
      if (kind === 'OIL' && cfg.oilBays === 0) kind = 'TIRE';
      jobs.push({ id: '', kind, arrive, balked: false, revenue: 0 });
    }
  }
  jobs.sort((a, b) => a.arrive - b.arrive);
  jobs.forEach((j, i) => (j.id = `SVC-${String(i + 1).padStart(3, '0')}`));

  const sim = new Simulation(open);
  const bayBusy: boolean[] = new Array<boolean>(bays).fill(false);
  const queues: Record<ServiceKind, ServiceJob[]> = { OIL: [], TIRE: [] };
  let active = 0;
  let busySec = 0;
  // 打烊后不再接新车，在岗技师加班把已经排队的车做完
  const lastOpenHour = Math.max(0, Math.ceil(close / 3600) - 1);
  const techsAt = (t: number) => techs[t < close ? Math.min(23, Math.floor(t / 3600)) : lastOpenHour] ?? 0;
  const bayRange = (kind: ServiceKind): [number, number] => (kind === 'OIL' ? [0, cfg.oilBays] : [cfg.oilBays, bays]);

  function tryStart(): void {
    for (;;) {
      if (active >= techsAt(sim.now)) return;
      // 两类队列中最早到达且有空工位的作业
      let pick: ServiceJob | undefined;
      let bay = -1;
      for (const kind of ['OIL', 'TIRE'] as const) {
        const head = queues[kind][0];
        if (!head || (pick && pick.arrive <= head.arrive)) continue;
        const [a, b] = bayRange(kind);
        const free = bayBusy.findIndex((busy, i) => !busy && i >= a && i < b);
        if (free >= 0) {
          pick = head;
          bay = free;
        }
      }
      if (!pick) return;
      queues[pick.kind].shift();
      const job = pick;
      bayBusy[bay] = true;
      active++;
      job.start = sim.now;
      job.bay = bay;
      const [lo, hi] = job.kind === 'OIL' ? params.oilMin : params.tireMin;
      const dur = rng.uniform(lo, hi) * 60;
      job.revenue =
        job.kind === 'OIL'
          ? Math.round(rng.uniform(...params.oilPrice))
          : Math.round(rng.uniform(...params.tireLabor) + (rng.chance(params.tirePurchaseRate) ? 4 * rng.uniform(...params.tirePrice) : 0));
      sim.after(dur, () => {
        job.end = sim.now;
        busySec += dur;
        bayBusy[bay] = false;
        active--;
        tryStart();
      });
    }
  }

  for (const job of jobs) {
    sim.at(job.arrive, () => {
      const [a, b] = bayRange(job.kind);
      if (queues[job.kind].length >= (b - a) * params.balkFactor) {
        job.balked = true;
        return;
      }
      queues[job.kind].push(job);
      tryStart();
    });
  }
  // 技师换班时重新尝试开工
  for (let h = Math.floor(open / 3600); h <= Math.ceil(close / 3600); h++) sim.at(Math.max(open, h * 3600), tryStart);
  sim.at(close, tryStart);
  sim.run();

  const served = jobs.filter((j) => j.end !== undefined);
  const waits = served.map((j) => ((j.start as number) - j.arrive) / 60);
  return {
    jobs,
    techs,
    metrics: {
      arrivals: jobs.length,
      served: served.length,
      balked: jobs.filter((j) => j.balked).length,
      avgWaitMin: mean(waits),
      p90WaitMin: percentile(waits, 0.9),
      avgTurnaroundMin: mean(served.map((j) => ((j.end as number) - j.arrive) / 60)),
      bayUtil: bays > 0 ? busySec / (bays * Math.max(1, close - open)) : 0,
      revenue: served.reduce((n, j) => n + j.revenue, 0),
    },
  };
}
