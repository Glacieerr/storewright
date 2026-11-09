import { beforeAll, describe, expect, it } from 'vitest';
import { buildBoard, type Board } from '../src/sim/board';
import { g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { Field, type FieldLevel } from '../src/twin/field';
import { Loop, runLoop, type LoopInput, type LoopResult } from '../src/twin/loop';
import { sumScore, Twin } from '../src/twin/twin';
import type { WVehicle } from '../src/sim/trace';
import type { UserDecision } from '../src/twin/types';

/** 闭环孪生：现场 → 感知数据 → 孪生（估计、推演、建议）→ 指令 → 现场 */
const s = g3(1);
s.traceDay = 86;
const r = runChain(s);
const trace = r.trace!;
const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
const input = (seed: number, level: FieldLevel = 'normal'): LoopInput => ({ vehicles: trace.vehicles, ops: board.ops, board, seed, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level });
const score = (k: LoopResult['kpi']) => k.lateMin + k.hotMin * 2 + k.shortMin * 1.5 + k.cost / 12;

describe('闭环：和不用孪生比', () => {
  let runs: { open: LoopResult; auto: LoopResult; safe: LoopResult }[] = [];
  beforeAll(() => {
    runs = [1, 2, 3].flatMap((seed) =>
      (['normal', 'rough'] as const).map((level) => ({
        open: runLoop(input(seed, level), { closed: false, policy: 'manual', decisions: [] }),
        auto: runLoop(input(seed, level), { closed: true, policy: 'auto', decisions: [] }),
        safe: runLoop(input(seed, level), { closed: true, policy: 'safe', decisions: [] }),
      })),
    );
  });

  it('不用孪生：一条指令都不发', () => {
    for (const x of runs) expect(x.open.cmds).toHaveLength(0);
  });

  it('同样的现场状况，闭环（全部自动执行）合计不比不用孪生差，整体明显更好', () => {
    let open = 0;
    let auto = 0;
    for (const x of runs) {
      expect(score(x.auto.kpi)).toBeLessThanOrEqual(score(x.open.kpi) * 1.05 + 30);
      open += score(x.open.kpi);
      auto += score(x.auto.kpi);
    }
    expect(auto).toBeLessThan(open * 0.6);
  });

  it('低风险的自动执行（改门、停车检查、调设定温度）就把超温和等门压下去了', () => {
    const hot = (k: 'open' | 'safe') => runs.reduce((a, x) => a + x[k].kpi.hotMin, 0);
    const door = (k: 'open' | 'safe') => runs.reduce((a, x) => a + x[k].kpi.doorWaitMin, 0);
    // 超温至少减半（换了区域以后可能正好一半，所以是小于等于）
    expect(hot('safe')).toBeLessThanOrEqual(hot('open') * 0.5);
    expect(door('safe')).toBeLessThanOrEqual(door('open'));
  });

  it('孪生的估计跟得上现场：到店时间（提前半小时）平均误差几分钟，货温误差零点几度，门店库存误差几个百分点', () => {
    for (const x of runs) {
      const f = x.auto.fidelity;
      if (Number.isFinite(f.eta30)) expect(f.eta30).toBeLessThan(6);
      expect(f.temp).toBeLessThan(0.3);
      let err = 0;
      let base = 0;
      for (const v of x.auto.stocks.values())
        for (let i = 84; i < 264; i++) {
          if (!Number.isFinite(v.est[i] as number)) continue;
          err += Math.abs((v.est[i] as number) - (v.truth[i] as number));
          base += Math.abs(v.truth[i] as number);
        }
      expect(err / base).toBeLessThan(0.05);
    }
  });

  it('持续校准：学到的「比计划慢多少」在合理范围，夜里不慢', () => {
    for (const x of runs) {
      for (const v of x.auto.bias) expect(Math.abs(v)).toBeLessThan(0.6);
      expect(Math.abs(x.auto.bias[3]!)).toBeLessThan(0.05);
    }
  });

  it('持续校准：每跑完一程（出发 → 到站），实际比计划多花的比例记到那个小时；十程以后接近真实的 12%', () => {
    const plan = (k: number): WVehicle => ({
      id: k,
      kind: 'truck',
      label: 'test',
      segs: [
        { t0: 7 * 3600 + k * 60, t1: 7 * 3600 + k * 60 + 600, pts: [0, 0], place: 'DC', act: '在配送中心月台装车' },
        { t0: 7 * 3600 + k * 60 + 600, t1: 7 * 3600 + k * 60 + 2400, pts: [0, 0, 1000, 0], route: ['DC', 'S01'], act: '开往门店' },
        { t0: 7 * 3600 + k * 60 + 2400, t1: 7 * 3600 + k * 60 + 3000, pts: [1000, 0], place: 'S01', act: '在门店卸货' },
      ],
    });
    const fake = { ops: [], byId: new Map(), doors: [], units: [], issues: [], kpi: {} } as unknown as Board;
    const tw = new Twin([], fake, (vid) => plan(vid));
    for (let k = 0; k < 10; k++) {
      const p = plan(k);
      const dep = p.segs[0]!.t1;
      tw.ingest({ kind: 'event', t: dep, vid: k, ev: 'depart', place: 'DC' });
      tw.ingest({ kind: 'event', t: dep + 1800 * 1.12, vid: k, ev: 'arrive', place: 'S01' });
    }
    expect(tw.bias[7]).toBeGreaterThan(0.09);
    expect(tw.bias[7]).toBeLessThan(0.13);
    expect(tw.bias[12]).toBe(0);
  });

  it('建议卡：每个做法都有推演结果，推荐的是合计最好的那个', () => {
    for (const x of runs)
      for (const rc of x.safe.recs) {
        expect(rc.options.length).toBeGreaterThan(0);
        const best = rc.options[rc.best]!;
        for (const o of rc.options) expect(sumScore(best)).toBeLessThanOrEqual(sumScore(o) + 0.01);
      }
  });
});

describe('闭环：指令真的改变现场', () => {
  it('配送中心追加补货：小车开到门店，卸下的货加进门店库存', () => {
    const f = new Field({ vehicles: trace.vehicles, ops: board.ops, seed: 1, store: { stock: trace.storeStock, demand: trace.storeDemand } });
    for (let t = 0; t < 10 * 3600; t += 60) f.step(t, 60);
    const fam = 'DAIRY';
    const before = f.stock.get(fam)!;
    f.apply({ kind: 'restock', t: 10 * 3600, fam, units: 2000 }, 10 * 3600);
    const van = f.fv[f.fv.length - 1]!;
    expect(van.extra?.kind).toBe('restock');
    let sold = 0;
    for (let t = 10 * 3600; t < 13 * 3600; t += 60) {
      const s0 = f.stock.get(fam)!;
      f.step(t, 60);
      sold += Math.max(0, s0 - f.stock.get(fam)!);
    }
    expect(van.finished || van.done.has('S01')).toBe(true);
    expect(f.stock.get(fam)! + sold).toBeGreaterThan(before + 1900);
  });

  it('长途车改直送门店：这车货卸在门店，不再去配送中心', () => {
    const sup = board.ops.find((o) => o.kind === 'supplier' && o.vehicle >= 0 && o.load)!;
    expect(sup).toBeDefined();
    const f = new Field({ vehicles: trace.vehicles, ops: board.ops, seed: 1, store: { stock: trace.storeStock, demand: trace.storeDemand } });
    const fv = f.fv.find((x) => x.vid === sup.vehicle)!;
    const start = fv.v.segs[0]!.t0;
    let t = 0;
    for (; t < start + 300; t += 60) f.step(t, 60);
    f.apply({ kind: 'divert', t, vid: sup.vehicle, to: 'store' }, t);
    expect(fv.diverted).toBe('store');
    expect(fv.v.segs.some((sg) => sg.place === 'S01')).toBe(true);
    for (; t < start + 6 * 3600 && !fv.done.has('S01'); t += 60) f.step(t, 60);
    expect(fv.done.has('S01')).toBe(true);
  });

  it('长途直送车的供应商发车晚了：车载终端提前报预计进区域的时刻，车还没进区域孪生就出了迟到卡，通知门店顺延', () => {
    let checked = 0;
    let lateAuto = 0;
    let lateOpen = 0;
    // 这几个种子当天的直送车排在收货截止前不久，发车晚了就会迟到
    for (const [seed, level] of [[2, 'normal'], [2, 'rough'], [8, 'rough']] as const) {
      const sc = g3(seed);
      sc.traceDay = 86;
      const tr = runChain(sc).trace!;
      const bd = buildBoard(tr.ops, emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock });
      const inp: LoopInput = { vehicles: tr.vehicles, ops: bd.ops, board: bd, seed, store: { stock: tr.storeStock, demand: tr.storeDemand }, direct: sc.flow.direct, level };
      const auto = new Loop(inp, { closed: true, policy: 'auto', decisions: [] });
      const open = new Loop(inp, { closed: false, policy: 'manual', decisions: [] });
      while (!auto.done) auto.step();
      while (!open.done) open.step();
      for (const [vid, delay] of auto.field.d.startDelay) {
        const appear = (tr.vehicles[vid]?.segs[0]?.t0 ?? 0) + delay;
        expect(auto.messages().some((m) => m.kind === 'event' && m.ev === 'eta' && m.vid === vid && m.t < appear - 3600), `种子 ${seed}`).toBe(true);
        const card = auto.cards().find((c) => c.kind === 'late' && c.vid === vid);
        lateAuto += auto.field.stopResults.filter((x) => x.vid === vid).reduce((a, x) => a + x.late, 0);
        lateOpen += open.field.stopResults.filter((x) => x.vid === vid).reduce((a, x) => a + x.late, 0);
        if (!card) continue;
        checked++;
        expect(card.t, `种子 ${seed}`).toBeLessThan(appear);
        expect(card.status, `种子 ${seed}`).toBe('done');
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(lateOpen).toBeGreaterThan(60);
    expect(lateAuto).toBeLessThan(lateOpen * 0.3);
  });

  it('让车晚点到：车在路边等到指定时刻', () => {
    const op = board.ops.find((o) => o.kind === 'direct' && o.vehicle >= 0)!;
    const f = new Field({ vehicles: trace.vehicles, ops: board.ops, seed: 1 });
    const fv = f.fv.find((x) => x.vid === op.vehicle)!;
    const t0 = fv.v.segs[0]!.t0 + 300;
    let t = 0;
    for (; t < t0; t += 60) f.step(t, 60);
    f.apply({ kind: 'hold', t, vid: op.vehicle, until: t + 1800 }, t);
    const tau0 = fv.tau;
    for (let k = 0; k < 20; k++, t += 60) f.step(t, 60);
    expect(fv.tau).toBeCloseTo(tau0, 0);
  });
});

describe('闭环：调度员的决定', () => {
  it('在某个时刻批准一张卡：从头再跑一遍，决定在那个时刻生效；同样的输入结果完全一样', () => {
    const base = runLoop(input(2, 'rough'), { closed: true, policy: 'manual', decisions: [] });
    const card = base.recs.find((x) => x.options.some((o) => o.cmds.length) && x.status !== 'done');
    expect(card).toBeDefined();
    const opt = card!.options.find((o) => o.cmds.length)!;
    const decisions: UserDecision[] = [{ t: card!.t, key: card!.key, action: 'approve', option: opt.key }];
    const a = runLoop(input(2, 'rough'), { closed: true, policy: 'manual', decisions });
    const b = runLoop(input(2, 'rough'), { closed: true, policy: 'manual', decisions });
    const done = a.recs.find((x) => x.key === card!.key)!;
    expect(done.status).toBe('done');
    expect(done.by).toBe('user');
    expect(done.chosen).toBe(opt.key);
    expect(a.cmds.length).toBeGreaterThan(0);
    expect(a.cmds[0]!.t).toBe(card!.t);
    expect(JSON.stringify(a.kpi)).toBe(JSON.stringify(b.kpi));
  });

  it('可以一分钟一分钟地走（孪生服务按真实时间推进），走完和一口气跑完的结果一样', () => {
    const loop = new Loop(input(3), { closed: true, policy: 'safe', decisions: [] });
    while (!loop.done) loop.step();
    const all = runLoop(input(3), { closed: true, policy: 'safe', decisions: [] });
    expect(JSON.stringify(loop.result().kpi)).toBe(JSON.stringify(all.kpi));
    expect(loop.messages().length).toBe(all.msgCount);
  });
});
