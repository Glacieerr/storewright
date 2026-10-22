import { createRng, hashString } from '@storewright/domain';
import type { PharmacyConfig } from '@storewright/store-config';
import { Simulation } from './kernel';
import { mean, percentile } from './stats';

/**
 * 药房柜台：顾客按小时权重到达，取药（3–8 分钟）或咨询（8–15 分钟，约 25%），
 * 先到先服务，柜台数即同时服务的人数。全部为假设参数。
 */

export interface PharmacyVisit {
  id: string;
  arrive: number;
  start?: number;
  end?: number;
  counter?: number;
  consult: boolean;
}

export interface PharmacyResult {
  visits: PharmacyVisit[];
  metrics: { patients: number; served: number; avgWaitMin: number; p90WaitMin: number; utilization: number };
}

const WEIGHTS = [0, 0, 0, 0, 0, 0, 0, 0.3, 0.6, 0.9, 1.0, 1.1, 1.3, 1.1, 0.9, 0.9, 1.1, 1.4, 1.3, 0.9, 0.5, 0.2, 0, 0];

/** 未指定日客流时按门店规模估算：中型店约 90 人 */
export function defaultPatientsPerDay(cfg: PharmacyConfig, staffScale = 1): number {
  return cfg.patientsPerDay > 0 ? cfg.patientsPerDay : Math.round(90 * Math.max(0.3, staffScale));
}

export function simulatePharmacy(cfg: PharmacyConfig, seed: number, staffScale = 1): PharmacyResult {
  const rng = createRng(hashString(cfg.id, (seed * 31 + 7) >>> 0));
  const open = cfg.hours.openMin * 60;
  const close = cfg.hours.closeMin * 60;
  const last = close - 900;
  const w = WEIGHTS.map((x, h) => (h * 3600 < last && (h + 1) * 3600 > open ? x : 0));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const perDay = defaultPatientsPerDay(cfg, staffScale);
  const visits: PharmacyVisit[] = [];
  for (let h = 0; h < 24; h++) {
    const n = rng.poisson((perDay * (w[h] ?? 0)) / total);
    for (let k = 0; k < n; k++) {
      const arrive = Math.round(Math.min(last, Math.max(open, h * 3600 + rng.uniform(0, 3600))));
      visits.push({ id: '', arrive, consult: rng.chance(0.25) });
    }
  }
  visits.sort((a, b) => a.arrive - b.arrive);
  visits.forEach((v, i) => (v.id = `RX-${String(i + 1).padStart(3, '0')}`));

  const sim = new Simulation(open);
  const free: boolean[] = new Array<boolean>(cfg.counters).fill(true);
  const queue: PharmacyVisit[] = [];
  let busy = 0;
  const tryStart = () => {
    for (;;) {
      const c = free.findIndex((f) => f);
      const v = queue[0];
      if (c < 0 || !v) return;
      queue.shift();
      free[c] = false;
      v.start = sim.now;
      v.counter = c;
      const dur = (v.consult ? rng.uniform(8, 15) : rng.uniform(3, 8)) * 60;
      busy += dur;
      sim.after(dur, () => {
        v.end = sim.now;
        free[c] = true;
        tryStart();
      });
    }
  };
  for (const v of visits) sim.at(v.arrive, () => {
    queue.push(v);
    tryStart();
  });
  sim.run();
  const waits = visits.filter((v) => v.start !== undefined).map((v) => ((v.start as number) - v.arrive) / 60);
  return {
    visits,
    metrics: {
      patients: visits.length,
      served: visits.filter((v) => v.end !== undefined).length,
      avgWaitMin: mean(waits),
      p90WaitMin: percentile(waits, 0.9),
      utilization: busy / (cfg.counters * Math.max(1, close - open)),
    },
  };
}
