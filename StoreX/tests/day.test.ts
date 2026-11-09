import { beforeAll, describe, expect, it } from 'vitest';
import { runDay, type DayResult } from '../src/ops/day';
import { gen1, storex, storex2030, storexNoMfc } from '../src/world/config';

let g: DayResult;
let x: DayResult;
beforeAll(() => {
  g = runDay(gen1(1));
  x = runDay(storex(1));
});

describe('一天的仿真：守恒和记账', () => {
  it('每张订单都完成了，件数守恒', () => {
    for (const r of [g, x]) {
      expect(r.online.done).toBe(r.demand.orders);
      for (const o of r.orders!) {
        expect(o.picked + o.substituted + o.short).toBe(o.items);
        expect(o.doneAt).toBeGreaterThanOrEqual(o.readyAt);
        expect(o.waitMin).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('同样的种子跑两次结果一样', () => {
    const again = runDay(storex(1));
    expect(again.online.waitAvg).toBe(x.online.waitAvg);
    expect(again.labor.paidTotal).toBe(x.labor.paidTotal);
    expect(again.events).toBe(x.events);
  });

  it('工时：利用率在 0–1 之间，带薪工时 = 各岗位 + 夜班 + 固定岗位', () => {
    for (const r of [g, x]) {
      expect(r.labor.utilization).toBeGreaterThan(0.2);
      expect(r.labor.utilization).toBeLessThanOrEqual(1);
      const sum = Object.values(r.labor.scheduled).reduce((a, b) => a + b, 0) + r.labor.night + r.labor.fixed;
      expect(r.labor.paidTotal).toBeCloseTo(sum, 6);
    }
  });

  it('能耗：每小时购电 ≥ 负荷 − 光伏 − 储能放电，光伏只在本方案', () => {
    for (const r of [g, x]) {
      const e = r.energy;
      for (let h = 0; h < 24; h++) {
        expect(e.gridKw[h]!).toBeGreaterThanOrEqual(0);
        expect(e.gridKw[h]! + 1e-9).toBeGreaterThanOrEqual(e.loadKw[h]! - e.solarKw[h]! - e.batteryKw[h]!);
      }
      expect(e.kwh).toBeCloseTo(e.loadKw.reduce((a, b) => a + b, 0), 6);
    }
    expect(g.energy.solarKwh).toBe(0);
    expect(x.energy.solarKwh).toBeGreaterThan(800);
  });

  it('钱：合计等于各项之和', () => {
    for (const r of [g, x]) expect(r.money.total).toBeCloseTo(r.money.labor + r.money.energy + r.money.freshLoss + r.money.lostMargin, 6);
  });
});

describe('上一代的校准（与 Storewright 优化后流程的实测对齐）', () => {
  it('线上作业约 30 分钟 / 单，拣货约 66 件 / 小时，满足率约 99%', () => {
    expect(g.online.laborMinPerOrder).toBeGreaterThan(26);
    expect(g.online.laborMinPerOrder).toBeLessThan(34);
    expect(g.online.floorItemsPerHour).toBeGreaterThan(58);
    expect(g.online.floorItemsPerHour).toBeLessThan(76);
    expect(g.online.fillPct).toBeGreaterThan(98.5);
  });

  it('现在的订单量下基本都按时，框离开暂存间约 3 分钟', () => {
    // 配送单按发车时刻放单，现在的订单量下上一代也基本按时；两代的差别在等待、工时和高峰时的弹性
    expect(g.online.onTimePct).toBeGreaterThan(95);
    expect(g.online.dwellAvg).toBeGreaterThan(2);
    expect(g.online.dwellAvg).toBeLessThan(4.5);
    expect(g.online.waitAvg).toBeGreaterThan(2.5);
  });

  it('生鲜损耗在门店常见范围（4–9%）', () => {
    expect(g.fresh.wastePct).toBeGreaterThan(4);
    expect(g.fresh.wastePct).toBeLessThan(9);
  });
});

describe('本方案相对上一代', () => {
  it('线上作业工时降到一半以下，顾客等待更短', () => {
    expect(x.online.laborMinPerOrder).toBeLessThan(g.online.laborMinPerOrder / 2);
    expect(x.online.waitAvg).toBeLessThan(g.online.waitAvg);
    expect(x.online.waitP95).toBeLessThan(g.online.waitP95);
    expect(x.online.onTimePct).toBeGreaterThanOrEqual(g.online.onTimePct - 3);
  });

  it('全店工时、缺货、生鲜损耗、购电都更少', () => {
    expect(x.labor.paidTotal).toBeLessThan(g.labor.paidTotal);
    expect(x.shelf.outOfShelfPct).toBeLessThan(g.shelf.outOfShelfPct);
    expect(x.fresh.wastePct).toBeLessThan(g.fresh.wastePct);
    expect(x.energy.gridKwh).toBeLessThan(g.energy.gridKwh);
    expect(x.money.total).toBeLessThan(g.money.total);
  });

  it('用到的机器人都在动，货格机器人不过载', () => {
    expect(x.robots.total).toBeGreaterThan(15);
    expect(x.online.mfcBotUtil).toBeGreaterThan(0.1);
    expect(x.online.mfcBotUtil).toBeLessThan(0.9);
    expect(x.online.mfcLines).toBeGreaterThan(2000);
    expect(g.robots.total).toBe(0);
  });

  it('2030 年订单翻倍时（2030 年设备）仍能全部按时完成', () => {
    const big = runDay(storex2030(1));
    expect(big.demand.orders).toBe(532);
    expect(big.online.done).toBe(532);
    expect(big.online.onTimePct).toBeGreaterThan(95);
    expect(big.online.waitAvg).toBeLessThan(3);
    expect(big.robots.counts.mfcBot).toBe(20);
  });

  it('货格仓停机 2 小时：降级到卖场拣时全部完成，不降级时会有订单拖到打烊', () => {
    const drill = (fallback: boolean) => {
      const s = storex2030(1);
      s.mfc.outage = { start: 15 * 3600, sec: 2 * 3600 };
      s.mfc.fallback = fallback;
      return runDay(s);
    };
    const withFallback = drill(true);
    const without = drill(false);
    expect(withFallback.online.done).toBe(532);
    expect(withFallback.online.fallbackItems).toBeGreaterThan(500);
    expect(withFallback.online.onTimePct).toBeGreaterThan(without.online.onTimePct + 15);
    for (const o of withFallback.orders!) expect(o.picked + o.substituted + o.short).toBe(o.items);
  });

  it('不建货格仓的对照：订单全部在卖场拣，工时介于两代之间', () => {
    const n = runDay(storexNoMfc(1));
    expect(n.online.done).toBe(n.demand.orders);
    expect(n.online.mfcLines).toBe(0);
    expect(n.labor.paidTotal).toBeGreaterThan(x.labor.paidTotal);
    expect(n.labor.paidTotal).toBeLessThan(g.labor.paidTotal);
  });

  it('打开动画不改变仿真结果（动画不用仿真的随机数）', () => {
    for (const make of [() => gen1(3), () => storex(3), () => storex2030(3)]) {
      const plain = runDay(make());
      const s = make();
      s.trace = true;
      const traced = runDay(s);
      expect(traced.events).toBe(plain.events);
      expect(traced.online.waitAvg).toBe(plain.online.waitAvg);
      expect(traced.labor.paidTotal).toBe(plain.labor.paidTotal);
      expect(traced.money.total).toBe(plain.money.total);
    }
  });

  it('动画轨迹：打开后记录每个员工和机器人的路线', () => {
    const s = storex(2);
    s.trace = true;
    const r = runDay(s);
    expect(r.trace).toBeDefined();
    expect(r.trace!.agents.length).toBeGreaterThan(20);
    const kinds = new Set(r.trace!.agents.map((a) => a.kind));
    for (const k of ['porter', 'freshPicker', 'stocker', 'amr', 'cart', 'mfcBot', 'car', 'van', 'truck']) expect(kinds.has(k as never), k).toBe(true);
    for (const a of r.trace!.agents) for (const seg of a.segs) expect(seg.t1).toBeGreaterThanOrEqual(seg.t0);
  });
});
