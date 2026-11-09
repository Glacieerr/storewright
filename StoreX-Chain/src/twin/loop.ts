import { FAMILIES } from '../region/products';
import type { Board, BoardOp } from '../sim/board';
import type { WVehicle } from '../sim/trace';
import { Channel, type DataQuality, type QualityStats } from './channel';
import { Field, type FieldLevel, type Incident, type StopResult } from './field';
import { LIMIT } from './models';
import { sumScore, Twin } from './twin';
import type { Cmd, Msg, Policy, Rec, UserDecision } from './types';

/**
 * 闭环：现场 → 感知数据 → 孪生（估计、推演、判断）→ 决策 → 控制指令 → 现场，一分钟一步跑完一整天。
 *
 * 同样的现场状况跑两遍：闭环（孪生的建议按「自动执行」的范围和调度员的决定执行）和开环（没有孪生、谁也不管），
 * 两遍的差就是孪生的作用。调度员在某个时刻批准或否决一条建议，就从头再跑一遍（一整天约零点几秒），
 * 决定在那个时刻生效，之后的现场跟着变。
 */
export interface LoopInput {
  vehicles: WVehicle[];
  ops: BoardOp[];
  board: Board;
  seed: number;
  /** 仿真里这一天 0 点门店每个商品族的库存、这一天的需求（现场从这里开始；孪生拿需求当预测） */
  store?: { stock: Record<string, number>; demand: Record<string, number> };
  /** 长途整车直送门店的商品族 */
  direct?: readonly string[];
  /** 现场状况 */
  level?: FieldLevel;
}
export interface LoopOpts {
  closed: boolean;
  policy: Policy;
  decisions: readonly UserDecision[];
  /** 通信质量（默认良好：数据原样送到孪生） */
  quality?: DataQuality;
}
export interface KpiPoint {
  t: number;
  late: number;
  hot: number;
  short: number;
  cost: number;
  lateStops: number;
  /** 月台门、门店收货口等待的分钟 */
  door: number;
  dock: number;
}
export interface LoopResult {
  closed: boolean;
  /** 现场发来的数据（定位每辆车每 10 分钟留一条，其余全留）、每 5 分钟的条数、总条数 */
  msgs: Msg[];
  msgRate: number[];
  msgCount: number;
  recs: Rec[];
  cmds: Cmd[];
  /** 现场的车（含孪生派出的救援车、追加补货车）：原来的车辆下标（新派的车接在后面）、计划轨迹（改过去处的按改后的）、每分钟的延误（秒）、收车时刻 */
  vids: number[];
  vehicles: WVehicle[];
  delays: Float32Array[];
  ends: number[];
  /** 冷机货物温度（每 5 分钟）：现场真值、孪生估计 */
  temps: Map<number, { truth: Float32Array; est: Float32Array; limit: number }>;
  /** 孪生每 5 分钟对每辆车的估计（实时跟踪用）：晚了多少秒、下一个门店站预计到达的时刻（没有就是 NaN） */
  twinEst: Map<number, { delay: Float32Array; storeEta: Float32Array }>;
  /** 门店每个商品族的库存（每 5 分钟）：现场真值、孪生估计 */
  stocks: Map<string, { truth: Float32Array; est: Float32Array }>;
  incidents: Incident[];
  series: KpiPoint[];
  kpi: Field['kpi'];
  fidelity: ReturnType<Twin['fidelity']>;
  fidelitySeries: { t: number; eta: number }[];
  bias: number[];
  /** 每个门店站开始卸货的时刻和晚了多少分钟（按收货截止） */
  stops: StopResult[];
  /** 分项：每辆车等门、等收货口的分钟，每辆车超温、每个商品族缺货的分钟（每 5 分钟一格） */
  by: Field['by'];
  /** 孪生派出来的车：救援车（接哪辆车的货）、追加补货车 */
  extras: { vid: number; kind: 'rescue' | 'restock'; of?: number }[];
  /** 通信质量不是「良好」时：丢了多少、晚到多少、孪生做了哪些补偿 */
  quality?: QualityStats;
}

const MIN = 60;
const STEP = 60;
const END = 26 * 3600;
const SLOTS = END / 300;

/** 闭环的一次运行：可以一分钟一分钟地走（孪生服务按真实时间推进），也可以一口气跑完（runLoop） */
export class Loop {
  readonly field: Field;
  readonly twin: Twin;
  /** 现在是当天的第几秒 */
  t = 0;
  private readonly recs = new Map<string, Rec>();
  /** 每个问题现在对应哪张建议卡（同一个问题过后又出现，开一张新卡：key 后面加 #2、#3） */
  private readonly current = new Map<string, string>();
  private readonly serial = new Map<string, number>();
  readonly cmds: Cmd[] = [];
  private readonly msgs: Msg[] = [];
  private readonly msgRate = new Array<number>(SLOTS).fill(0);
  private readonly delays = new Map<number, Float32Array>();
  private readonly temps: LoopResult['temps'] = new Map();
  private readonly twinEst: LoopResult['twinEst'] = new Map();
  private readonly stocks: LoopResult['stocks'] = new Map(FAMILIES.map((f) => [f.key, { truth: new Float32Array(SLOTS).fill(NaN), est: new Float32Array(SLOTS).fill(NaN) }]));
  private readonly series: KpiPoint[] = [];
  private readonly fidelitySeries: { t: number; eta: number }[] = [];
  private readonly lastGps = new Map<number, number>();
  private read = 0;
  private readonly pendingDecisions: UserDecision[];
  /** 数据到孪生之前经过的通道（通信质量不是「良好」时才有） */
  private readonly channel: Channel | undefined;

  constructor(
    input: LoopInput,
    readonly opts: LoopOpts,
  ) {
    this.field = new Field({ vehicles: input.vehicles, ops: input.ops, seed: input.seed, ...(input.store ? { store: input.store } : {}), ...(input.direct ? { direct: input.direct } : {}), ...(input.level ? { level: input.level } : {}) });
    this.twin = new Twin(input.ops, input.board, (vid: number) => this.field.fv.find((f) => f.vid === vid)?.v, input.store?.demand ?? {}, input.direct ?? []);
    this.pendingDecisions = [...opts.decisions].sort((a, b) => a.t - b.t);
    if (opts.quality && opts.quality !== 'good') this.channel = new Channel(opts.quality, input.seed);
  }

  get done(): boolean {
    return this.t >= END;
  }

  /** 现场发出的感知数据（全部），从第 from 条起 */
  messages(from = 0): Msg[] {
    return this.field.msgs.slice(from);
  }

  /** 现在的建议卡（按提出的时间） */
  cards(): Rec[] {
    return [...this.recs.values()].sort((a, b) => a.t - b.t);
  }

  /** 执行一张卡的某个做法：指令发给现场，孪生记下自己派出的车 */
  execute(r: Rec, optKey: string, t: number, by: 'auto' | 'user'): void {
    const o = r.options.find((x) => x.key === optKey);
    if (!o) return;
    r.status = 'done';
    r.by = by;
    r.chosen = o.key;
    r.doneAt = t;
    for (const c of o.cmds) this.send(c, t);
  }

  private send(c0: Cmd, t: number): void {
    const c = { ...c0, t } as Cmd;
    const before = this.field.fv.length;
    this.field.apply(c, t);
    this.cmds.push(c);
    this.twin.commanded(c);
    if (c.kind === 'rescue') {
      const nf = this.field.fv.slice(before).find((f) => f.extra?.kind === 'rescue');
      if (nf) {
        this.twin.rescueOf.set(nf.vid, c.vid);
        const e = this.twin.v.get(c.vid);
        if (e) for (const s of e.stops) e.done.add(s.key);
      }
    }
  }

  /** 否掉一张卡 */
  reject(r: Rec, t: number): void {
    r.status = 'rejected';
    r.by = 'user';
    r.doneAt = t;
  }

  /** 实时运行时（孪生服务）调度员的决定：此刻生效 */
  decide(key: string, action: 'approve' | 'reject', option?: string): Rec | undefined {
    const r = this.recs.get(key);
    if (!r || r.status !== 'proposed') return undefined;
    if (action === 'reject') this.reject(r, this.t);
    else this.execute(r, option ?? (r.options[r.best] as { key: string }).key, this.t, 'user');
    return r;
  }

  /** 外部系统（虚幻引擎的操作界面、MATLAB 控制器）直接发给现场的指令：此刻生效 */
  command(c: Cmd): void {
    this.send(c, this.t);
  }

  /** 往前走一分钟 */
  step(): void {
    const t = this.t;
    const { field, twin, opts } = this;
    field.step(t, STEP);
    // 新的感知数据交给孪生
    for (; this.read < field.msgs.length; this.read++) {
      const m = field.msgs[this.read] as Msg;
      if (this.channel) this.channel.send(m, t + STEP);
      else twin.ingest(m);
      const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(m.t / 300)));
      this.msgRate[slot] = (this.msgRate[slot] as number) + 1;
      if (m.kind === 'gps') {
        if ((this.lastGps.get(m.vid) ?? -Infinity) + 600 > m.t) continue;
        this.lastGps.set(m.vid, m.t);
      }
      this.msgs.push(m);
    }
    const t1 = t + STEP;
    // 通道送到的（晚到的这时才到）交给孪生
    if (this.channel) for (const m of this.channel.deliver(t1)) twin.ingest(m);
    this.t = t1;
    // 每分钟记延误（三维里按它平移计划的运动）
    const minute = Math.floor(t1 / 60);
    for (const f of field.fv) {
      if (!f.started || f.finished) continue;
      let arr = this.delays.get(f.vid);
      if (!arr) {
        arr = new Float32Array(END / 60 + 1).fill(NaN);
        this.delays.set(f.vid, arr);
      }
      if (minute < arr.length) arr[minute] = t1 - f.tau;
    }
    if (t1 % 300 !== 0) return;
    const slot = t1 / 300 - 1;
    // 断线、丢点时孪生按计划和最后知道的延误推算位置：在路上、超过 3 分钟没收到定位的车记一次
    if (this.channel)
      for (const f of field.fv) {
        if (!f.started || f.finished) continue;
        if (t1 - (this.channel.gpsAt(f.vid) ?? -Infinity) > 180) this.channel.stats.reckoned++;
      }
    // 每 5 分钟：孪生想一次
    const issues = twin.think(t1);
    const seen = new Set<string>();
    for (const is of issues) {
      seen.add(is.key);
      let r = this.recs.get(this.current.get(is.key) ?? '');
      if (r && r.status === 'resolved' && t1 - (r.doneAt ?? t1) < 30 * MIN) {
        // 刚消失又出现（预测在门槛上下晃）：还是原来那张卡
        r.status = 'proposed';
        delete r.doneAt;
      }
      let best = 0;
      is.options.forEach((o, i) => {
        if (sumScore(o) < sumScore(is.options[best] as typeof o) - 0.01) best = i;
      });
      if (r && r.status !== 'proposed') {
        // 调度员否掉的不再提；执行了半小时（补货、改直送等货到要一小时）问题还在、或者消失过一阵又出现，开一张新卡
        const grace = r.kind === 'stockout' ? 60 * MIN : 30 * MIN;
        if (r.status === 'rejected' || (r.status === 'done' && t1 - (r.doneAt ?? t1) < grace)) continue;
        // 上次批准的是「等着 / 不处理」：孪生推荐的还是不动，就不再开新卡（推荐变成要动手的做法时才再提）
        const wasNoop = r.status === 'done' && !r.options.find((o) => o.key === r?.chosen)?.cmds.length;
        if (wasNoop && !(is.options[best] as (typeof is.options)[number]).cmds.length) continue;
        r = undefined;
      }
      if (!r) {
        const n = (this.serial.get(is.key) ?? 0) + 1;
        this.serial.set(is.key, n);
        const key = n === 1 ? is.key : `${is.key}#${n}`;
        this.current.set(is.key, key);
        r = { key, kind: is.kind, t: t1, title: is.title, text: is.text, options: is.options, best, status: 'proposed', ...(is.vid !== undefined ? { vid: is.vid } : {}), ...(is.store ? { store: is.store } : {}) };
        this.recs.set(key, r);
      } else Object.assign(r, { title: is.title, text: is.text, options: is.options, best });
      if (!opts.closed) continue;
      const rk = r.key;
      const ud = this.pendingDecisions.find((d) => d.key === rk && d.t <= t1);
      if (ud) {
        this.pendingDecisions.splice(this.pendingDecisions.indexOf(ud), 1);
        if (ud.action === 'reject') this.reject(r, t1);
        else this.execute(r, ud.option ?? (r.options[r.best] as { key: string }).key, t1, 'user');
        continue;
      }
      const b = r.options[r.best];
      if (!b || opts.policy === 'manual') continue;
      if (opts.policy === 'auto' || b.auto) {
        if (b.cmds.length) this.execute(r, b.key, t1, 'auto');
        continue;
      }
      // 推荐的做法要人批准：先自动做一个低风险、又比不处理好的措施，卡片留着等调度员
      if (!r.interim) {
        const accept = r.options.find((o) => o.key === 'accept');
        const lo = r.options.filter((o) => o.auto && o.cmds.length && (!accept || sumScore(o) < sumScore(accept) - 0.01)).sort((x, y) => sumScore(x) - sumScore(y))[0];
        if (lo) {
          for (const c of lo.cmds) this.send(c, t1);
          r.interim = { key: lo.key, t: t1 };
        }
      }
    }
    for (const [base, key] of this.current) {
      const r = this.recs.get(key) as Rec;
      if (r.status === 'proposed' && !seen.has(base)) {
        r.status = twin.happened(r) ? 'expired' : 'resolved';
        r.doneAt = t1;
      }
    }
    // 记录：孪生对每辆车的估计（延误、到店时刻）
    for (const f of field.fv) {
      if (!f.started || f.finished) continue;
      const est = twin.estimate(f.vid, t1);
      if (!est) continue;
      let rec = this.twinEst.get(f.vid);
      if (!rec) {
        rec = { delay: new Float32Array(SLOTS).fill(NaN), storeEta: new Float32Array(SLOTS).fill(NaN) };
        this.twinEst.set(f.vid, rec);
      }
      rec.delay[slot] = est.delay;
      if (est.storeEta !== undefined) rec.storeEta[slot] = est.storeEta;
    }
    // 记录：温度、门店生鲜、闭环效果
    for (const f of field.fv) {
      if (!f.reefer || !f.started || f.finished) continue;
      let rec = this.temps.get(f.vid);
      if (!rec) {
        rec = { truth: new Float32Array(SLOTS).fill(NaN), est: new Float32Array(SLOTS).fill(NaN), limit: LIMIT[f.reefer.zone] };
        this.temps.set(f.vid, rec);
      }
      rec.truth[slot] = f.reefer.st.product;
      const e = twin.v.get(f.vid)?.reefer;
      if (e && e.t > 0) rec.est[slot] = e.product;
    }
    for (const fam of FAMILIES) {
      const s = this.stocks.get(fam.key) as { truth: Float32Array; est: Float32Array };
      s.truth[slot] = field.stock.get(fam.key) ?? NaN;
      s.est[slot] = twin.stock.get(fam.key)?.est ?? NaN;
    }
    this.series.push({ t: t1, late: field.kpi.lateMin, hot: field.kpi.hotMin, short: field.kpi.shortMin, cost: field.kpi.cost, lateStops: field.kpi.lateStops, door: field.kpi.doorWaitMin, dock: field.kpi.dockWaitMin });
    if (t1 % 3600 === 0) this.fidelitySeries.push({ t: t1, eta: twin.fidelity().eta60 });
  }

  result(): LoopResult {
    const { field, twin } = this;
    const order = field.fv.map((f) => f.vid);
    return {
      closed: this.opts.closed,
      msgs: this.msgs,
      msgRate: this.msgRate,
      msgCount: field.msgs.length,
      recs: this.cards(),
      cmds: this.cmds,
      vids: order,
      vehicles: field.fv.map((f) => f.v),
      delays: order.map((vid) => this.delays.get(vid) ?? new Float32Array(0)),
      ends: field.fv.map((f) => f.endAt ?? Infinity),
      temps: this.temps,
      stocks: this.stocks,
      incidents: field.d.incidents,
      series: this.series,
      kpi: { ...field.kpi },
      fidelity: twin.fidelity(),
      fidelitySeries: this.fidelitySeries,
      twinEst: this.twinEst,
      bias: [...twin.bias],
      stops: [...field.stopResults],
      by: field.by,
      extras: field.fv.filter((f) => f.extra).map((f) => ({ vid: f.vid, kind: (f.extra as NonNullable<typeof f.extra>).kind, ...(f.extra?.of !== undefined ? { of: f.extra.of } : {}) })),
      ...(this.channel ? { quality: this.channel.summary() } : {}),
    };
  }
}

export function runLoop(input: LoopInput, opts: LoopOpts): LoopResult {
  const loop = new Loop(input, opts);
  while (!loop.done) loop.step();
  return loop.result();
}
