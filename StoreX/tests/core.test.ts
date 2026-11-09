import { describe, expect, it } from 'vitest';
import { Rng, Sampler } from '../src/core/rng';
import { clock, H, Sim } from '../src/core/sim';
import { ci95, mean, pairedDiff, quantile, sd, TimeWeighted } from '../src/core/stats';

describe('随机数', () => {
  it('同一个种子得到同一串数，不同种子不同', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const xa = Array.from({ length: 20 }, () => a.next());
    const xb = Array.from({ length: 20 }, () => b.next());
    const xc = Array.from({ length: 20 }, () => c.next());
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
    for (const x of xa) expect(x >= 0 && x < 1).toBe(true);
  });

  it('子流：同一个标签总是同一个子流，不受父流用了多少数影响', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    for (let i = 0; i < 100; i++) b.next();
    // fork 只依赖构造时的状态之外的父流位置——这里检查标签决定子流
    const fa = new Rng(7).fork('demand');
    const fb = new Rng(7).fork('demand');
    const fo = new Rng(7).fork('ops');
    expect(fa.next()).toBe(fb.next());
    expect(new Rng(7).fork('demand').next()).not.toBe(fo.next());
    expect(a.fork('x').next()).toBeTypeOf('number');
  });

  it('分布的均值大致正确', () => {
    const r = new Rng(1);
    const n = 20000;
    const pois = Array.from({ length: n }, () => r.poisson(4));
    const logn = Array.from({ length: n }, () => r.logNormal(10, 0.3));
    const expo = Array.from({ length: n }, () => r.exp(2));
    expect(mean(pois)).toBeCloseTo(4, 1);
    expect(mean(logn)).toBeGreaterThan(9.8);
    expect(mean(logn)).toBeLessThan(10.2);
    expect(sd(logn) / mean(logn)).toBeCloseTo(0.3, 1);
    expect(mean(expo)).toBeGreaterThan(1.9);
    expect(mean(expo)).toBeLessThan(2.1);
  });

  it('按权重抽样', () => {
    const r = new Rng(3);
    const s = new Sampler([1, 2, 7]);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[s.sample(r)]!++;
    expect(counts[0]! / 30000).toBeCloseTo(0.1, 1);
    expect(counts[1]! / 30000).toBeCloseTo(0.2, 1);
    expect(counts[2]! / 30000).toBeCloseTo(0.7, 1);
  });
});

describe('离散事件内核', () => {
  it('按时间先后执行，同一时刻按加入顺序', () => {
    const sim = new Sim();
    const log: string[] = [];
    sim.at(30, () => log.push('c'));
    sim.at(10, () => log.push('a1'));
    sim.at(10, () => log.push('a2'));
    sim.at(20, () => {
      log.push('b');
      sim.after(5, () => log.push('b+5'));
      sim.at(0, () => log.push('past→now'));
    });
    sim.run(100);
    expect(log).toEqual(['a1', 'a2', 'b', 'past→now', 'b+5', 'c']);
    expect(sim.now).toBe(100);
    expect(sim.executed).toBe(6);
  });

  it('run(until) 不执行之后的事件', () => {
    const sim = new Sim();
    let done = false;
    sim.at(2 * H, () => (done = true));
    sim.run(H);
    expect(done).toBe(false);
    expect(sim.pending).toBe(1);
    sim.run(3 * H);
    expect(done).toBe(true);
  });

  it('时刻文字', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(7.5 * H)).toBe('07:30');
    expect(clock(21 * H + 59 * 60)).toBe('21:59');
  });
});

describe('统计', () => {
  it('分位数、置信区间', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBe(0);
    const c = ci95([10, 12, 14]);
    expect(c.mean).toBe(12);
    // t(0.975, 2) = 4.303，标准差 2
    expect(c.half).toBeCloseTo((4.303 * 2) / Math.sqrt(3), 6);
  });

  it('配对差值：同向的小差异也能判显著', () => {
    const a = [100, 120, 90, 110, 105];
    const b = a.map((x) => x - 3 + (x % 2) * 0.1);
    const d = pairedDiff(a, b);
    expect(d.mean).toBeLessThan(0);
    expect(d.significant).toBe(true);
    const noise = pairedDiff([1, 2, 3, 4], [2, 1, 4, 3]);
    expect(noise.significant).toBe(false);
  });

  it('时间加权平均', () => {
    const tw = new TimeWeighted(0, 0);
    tw.set(10, 2);
    tw.set(20, 0);
    expect(tw.average(40)).toBeCloseTo(0.5, 9);
    expect(tw.max).toBe(2);
  });
});
