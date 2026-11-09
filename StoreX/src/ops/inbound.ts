import type { Sim } from '../core/sim';
import type { Scenario } from '../world/config';
import type { Layout, Pt } from '../world/layout';
import type { Pool, Step } from './agents';
import type { Mfc } from './mfc';
import type { StaffPlan } from './staffing';
import type { Trace } from './trace';

/**
 * 收货：配送中心的大车、生鲜车、供应商直送。上一代由收货员卸车、点数、上架；
 * 本方案由自动托盘车卸车，收货门的 RFID / 视觉自动核对，收货员只看异常；
 * 进货里属于货格仓的商品拆箱放进货箱（拆箱站 + 机器人送空箱）。
 */
export interface InboundStats {
  trucks: number;
  pallets: number;
  cases: number;
  /** 每辆车在卸货门停留的分钟数 */
  dockMin: number[];
  decantCases: number;
}

export class Inbound {
  readonly stats: InboundStats = { trucks: 0, pallets: 0, cases: 0, dockMin: [], decantCases: 0 };

  constructor(
    readonly sim: Sim,
    readonly s: Scenario,
    readonly layout: Layout,
    readonly trace: Trace,
    private readonly pools: { receiver: Pool; pallet?: Pool },
    private readonly mfc: Mfc | undefined,
    private readonly plan: StaffPlan,
  ) {
    s.inbound.trucks.forEach((tr, i) => sim.at(tr.time, () => this.arrive(tr, i)));
  }

  private arrive(tr: Scenario['inbound']['trucks'][number], i: number): void {
    const dock = this.layout.poi.docks[i % this.layout.poi.docks.length] as { outside: Pt; inside: Pt };
    const t0 = this.sim.now;
    this.stats.trucks++;
    this.stats.pallets += tr.pallets;
    this.stats.cases += tr.cases;
    const truck = this.trace.add('truck', tr.kind === 'dc' ? '配送中心货车' : tr.kind === 'fresh' ? '生鲜车' : '供应商直送');
    this.trace.move(truck, t0 - 60, t0, [{ x: dock.outside.x - 12, y: 0 }, dock.outside], '到达');
    this.trace.event(t0, 'truck', `${tr.kind === 'dc' ? '配送中心货车' : tr.kind === 'fresh' ? '生鲜车' : '供应商直送'}到达，${tr.pallets} 托 ${tr.cases} 箱`);
    const stockPt = this.layout.poi.backroomStock[0] as Pt;
    const inb = this.s.inbound;
    let left = tr.pallets;
    const leave = () => {
      const t = this.sim.now;
      this.stats.dockMin.push((t - t0) / 60);
      this.trace.dwell(truck, t0, t, dock.outside, '卸货');
      this.trace.move(truck, t, t + 60, [dock.outside, { x: dock.outside.x + 12, y: 0 }], '离开');
      // 本方案：大车和生鲜车卸完后开始拆箱入格
      if (this.mfc && tr.kind !== 'dsd') {
        const share = tr.kind === 'dc' ? 0.75 : 0.25;
        const cases = Math.round(this.plan.decantCases * share);
        this.stats.decantCases += cases;
        this.mfc.decant(cases, t / 60, () => undefined);
      }
    };
    const casesPerPallet = tr.cases / Math.max(1, tr.pallets);
    const palletDone = () => {
      if (--left === 0) leave();
    };
    if (this.pools.pallet) {
      // 自动托盘车卸车并送到后仓暂存，收货员在门口看一眼
      for (let p = 0; p < tr.pallets; p++) {
        this.pools.pallet.submit({
          priority: t0 / 60,
          label: '卸托盘',
          steps: () => [
            { kind: 'walk', to: dock.inside, act: '去卸货门' },
            { kind: 'work', sec: inb.unloadSecPerPallet * 0.6, act: '卸托盘' },
            { kind: 'walk', to: stockPt, act: '送到后仓' },
            { kind: 'work', sec: 30, act: '放下' },
          ],
          onDone: palletDone,
        });
      }
      this.pools.receiver.submit({
        priority: t0 / 60,
        label: '收货核对',
        steps: () => [
          { kind: 'walk', to: dock.inside, act: '去卸货门' },
          { kind: 'work', sec: tr.pallets * 60 + (tr.kind === 'dsd' ? inb.dsdCheckSec : 0) + tr.cases * inb.checkSecPerCase, act: '核对' },
          { kind: 'walk', to: stockPt, act: '上架到后仓' },
          { kind: 'work', sec: tr.pallets * inb.putawaySecPerPallet, act: '整理' },
        ],
      });
      return;
    }
    // 上一代：收货员逐托卸车、点数、推到后仓
    for (let p = 0; p < tr.pallets; p++) {
      this.pools.receiver.submit({
        priority: t0 / 60,
        label: '卸车收货',
        steps: () => {
          const steps: Step[] = [
            { kind: 'walk', to: dock.inside, act: '去卸货门' },
            { kind: 'work', sec: inb.unloadSecPerPallet + casesPerPallet * inb.checkSecPerCase + (tr.kind === 'dsd' ? inb.dsdCheckSec : 0), act: '卸车点数' },
            { kind: 'walk', to: stockPt, act: '推到后仓' },
            { kind: 'work', sec: inb.putawaySecPerPallet, act: '上架' },
          ];
          return steps;
        },
        onDone: palletDone,
      });
    }
  }
}
