import { afterAll, describe, expect, it } from 'vitest';
import { runDay } from '../../StoreX/src/ops/day';
import { storex } from '../../StoreX/src/world/config';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION } from '../src/region/regionGen';
import { deriveVisits } from '../src/site/visits';
import { planStays } from '../src/site/stays';
import { planPeople } from '../src/site/people';
import { modelOf, planLotTraffic } from '../src/site/motion';
import { buildCity } from '../web/src/three/regionCity';
import { StoreRoads } from '../web/src/three/store/roads';
import { AMBER, approachPhase, CYCLE, GREEN, STOP_BACK } from '../web/src/three/signals';
import { TrafficPlanner } from '../web/src/three/traffic';

/**
 * 门店专用左转车道（门店路口左转进进店路的那条进口道，最里面那条车道只给门店的车）对干道直行车的影响：
 * 同一天的门店车流（StoreX 门店仿真 → 停车场车流 → 干道和进店路上的行驶），背景车平常负荷 9,000 趟，
 * 有 / 没有专用车道各算一遍。看进口道上直行车的高峰小时流量和通行能力之比（专用车道占掉一条车道以后剩下的车道，
 * 每条 1,800 辆 / 小时 × 绿信比），和这一截的平均通过时间多了多少秒。
 */
describe('门店专用左转车道', () => {
  afterAll(() => {
    TrafficPlanner.storeLane = true;
    setRegion(DEFAULT_REGION);
  });

  it('干道直行车：高峰小时流量 / 通行能力在 0.5 以下，专用车道让这一截平均多花的时间不到 10 秒', () => {
    setRegion(DEFAULT_REGION);
    const scx = storex(1);
    scx.trace = true;
    const agents = runDay(scx).trace?.agents ?? [];
    const { net, plan: city } = buildCity(DEFAULT_REGION);
    const site = [...city.sites.values()][0];
    expect(site).toBeDefined();
    if (!site) return;
    const access = net.lines[site.access.line] as { trimA: number; id: number; ja: string };
    const at = net.storeAttach.get(site.st.key);
    const j = at ? net.junctions.get(at.junction) : undefined;
    const zIn = site.access.attachZ - (access.trimA + 4);
    const zStop = site.access.attachZ - (access.trimA + STOP_BACK);
    const ways = new StoreRoads(site, net, zIn, zStop);
    const plan = planStays(site.lot, deriveVisits(agents, { seed: 1, generation: 'storex' }), 1);
    const people = planPeople(site.lot, plan.stays, 1);
    const inPhase = plan.stays.map((st) => {
      const leg = j && at && ways.legs.length ? ways.inLeg(st.visit.seed) : undefined;
      return leg && j && at ? approachPhase(j, leg.line, at.junction) : undefined;
    });
    const inLead = plan.stays.map((st) => ways.inLead(st.visit.seed, modelOf(st.visit)));
    const outPhase = j && at ? approachPhase(j, access, at.junction) : undefined;
    const lt = planLotTraffic(site.lot, plan, people, { zIn, zStop, speed: 4.0, signal: { offset: j?.offset ?? 0, inPhase, outPhase, inLead } });
    const runs = ways.runs(plan.stays, lt);
    expect(runs.length).toBeGreaterThan(100);
    // 绿信比：两相位，每相位绿灯 + 黄灯 − 2 秒起步损失
    const gC = (GREEN + AMBER - 2) / CYCLE;
    const rows: string[] = [];
    // 单元测试只算平常负荷（极限负荷一天背景车 25,200 趟，算一遍要几十秒；量过的数见文档）
    for (const [label, k] of [['平常', 1]] as const) {
      const got: Record<'on' | 'off', { peak: number; mean: number; lanes: number; active: boolean; n: number }> = {} as never;
      for (const on of [true, false]) {
        TrafficPlanner.storeLane = on;
        const tr = new TrafficPlanner(net);
        tr.simulate(Math.round(9000 * k), undefined, undefined, runs);
        const leg = tr.storeApproach().legs[0];
        expect(leg, '门店路口左转进口道').toBeDefined();
        if (!leg) return;
        const hours = new Array<number>(27).fill(0);
        for (const c of leg.cars) {
          const h = Math.max(0, Math.min(26, Math.floor(c.t1 / 3600)));
          hours[h] = (hours[h] ?? 0) + 1;
        }
        const mean = leg.cars.reduce((s, c) => s + (c.t1 - c.t0), 0) / Math.max(1, leg.cars.length);
        got[on ? 'on' : 'off'] = { peak: Math.max(...hours), mean, lanes: leg.lanes - (leg.storeLane ? 1 : 0), active: leg.storeLane, n: leg.cars.length };
      }
      const on = got.on;
      const off = got.off;
      const vc = on.peak / (on.lanes * 1800 * gC);
      rows.push(`${label}：直行车 ${on.n} / ${off.n} 辆（有 / 没有专用车道），高峰小时 ${on.peak} / ${off.peak} 辆，剩 ${on.lanes} 条车道，流量 / 通行能力 ${vc.toFixed(2)}，平均通过 ${on.mean.toFixed(1)} / ${off.mean.toFixed(1)} 秒（多 ${(on.mean - off.mean).toFixed(1)} 秒）`);
      // 专用车道这一天真的开着（有门店的车走那条车道），关掉以后背景车两条车道都能走
      expect(on.active).toBe(true);
      expect(off.active).toBe(false);
      expect(vc).toBeLessThan(0.5);
      expect(on.mean - off.mean).toBeLessThan(10);
    }
    console.log(rows.join('\n'));
  }, 600_000);
});
