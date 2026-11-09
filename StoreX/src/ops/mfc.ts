import type { Rng } from '../core/rng';
import { H, type Sim } from '../core/sim';
import type { Scenario } from '../world/config';
import type { Order, OrderLine } from '../world/demand';
import type { Layout, Rect } from '../world/layout';
import type { Pool } from './agents';
import type { Trace } from './trace';

/**
 * 立体货格仓（本方案）：货箱一层层叠在格子里，机器人在顶上跑，取出要的货箱送到站台；
 * 站台的拣货员（或机械臂）从货箱里拣出订单要的件数放进订单框，机器人再把货箱放回去。
 * 每一行订单要一次「取箱」；拆箱入格（把进货的整箱拆开放进货箱）也要机器人送空箱，优先级低于拣货。
 */
/** 一行拣完的结果：不给时按货格仓的少货率算；降级模式下由卖场拣货给出实拣、替代、缺货件数 */
export interface LineResult {
  picked: number;
  sub: number;
  short: number;
}
export interface LineReq {
  kind: 'pick';
  line: OrderLine;
  priority: number;
  order: Order;
  done: (result?: LineResult) => void;
}
interface DecantReq {
  kind: 'decant';
  priority: number;
  done: () => void;
}
type Req = LineReq | DecantReq;

interface Port {
  index: number;
  decant: boolean;
  queue: { req: Req; bot: number }[];
  busy: boolean;
}

export interface MfcStats {
  lines: number;
  items: number;
  decanted: number;
  botBusySec: number;
  portBusySec: number;
  decantBusySec: number;
  armAssists: number;
  failures: number;
  downtimeSec: number;
  /** 每小时完成的行数 */
  linesByHour: number[];
  /** 等机器人送箱的平均秒数 */
  waitSec: number[];
  /** 停机时交给卖场拣的行数 */
  drained: number;
}

export class Mfc {
  private pending: Req[] = [];
  private botsFree: number;
  private readonly botAgents: number[] = [];
  private readonly botBusy: boolean[] = [];
  private readonly botStart: number[] = [];
  private readonly ports: Port[] = [];
  readonly stats: MfcStats = { lines: 0, items: 0, decanted: 0, botBusySec: 0, portBusySec: 0, decantBusySec: 0, armAssists: 0, failures: 0, downtimeSec: 0, linesByHour: new Array<number>(24).fill(0), waitSec: [], drained: 0 };
  private readonly rect: Rect;
  private readonly portAgents: number[] = [];
  /** 整体停机开始时调用：交出还没派机器人的拣货请求（降级模式改到卖场拣） */
  onOutage?: (reqs: LineReq[]) => void;
  /** 动画专用的随机数（不能用仿真的随机数：打开动画不能改变结果） */
  private readonly anim: Rng;

  constructor(
    readonly sim: Sim,
    readonly s: Scenario,
    readonly layout: Layout,
    readonly trace: Trace,
    private readonly rng: Rng,
    private readonly porters: Pool,
    private readonly decanters: Pool,
  ) {
    this.botsFree = s.mfc.bots;
    this.anim = rng.fork('anim');
    this.rect = layout.poi.mfc as Rect;
    for (let i = 0; i < s.mfc.bots; i++) {
      this.botAgents.push(trace.add('mfcBot', `货格机器人 ${i + 1}`));
      this.botBusy.push(false);
      this.botStart.push(0);
    }
    for (let i = 0; i < s.mfc.ports; i++) {
      this.ports.push({ index: i, decant: false, queue: [], busy: false });
      this.portAgents.push(s.mfc.portPicker === 'arm' ? trace.add('loader', `站台机械臂 ${i + 1}`) : -1);
    }
    this.ports.push({ index: s.mfc.ports, decant: true, queue: [], busy: false });
    // 站台是否开放取决于在岗的站台拣货员：每小时检查一次
    for (let h = 0; h < 24; h++) sim.at(h * H + 1, () => this.pump());
    const out = s.mfc.outage;
    if (out) {
      sim.at(out.start, () => {
        trace.event(sim.now, 'robot', `货格仓停机（演练），预计 ${Math.round(out.sec / 60)} 分钟`);
        if (this.onOutage) {
          const drained = this.pending.filter((r): r is LineReq => r.kind === 'pick');
          this.pending = this.pending.filter((r) => r.kind !== 'pick');
          this.stats.drained += drained.length;
          if (drained.length) this.onOutage(drained);
        }
      });
      sim.at(out.start + out.sec, () => {
        trace.event(sim.now, 'robot', '货格仓恢复运行');
        this.pump();
      });
    }
  }

  /** 是否处在整体停机中 */
  get down(): boolean {
    const out = this.s.mfc.outage;
    return !!out && this.sim.now >= out.start && this.sim.now < out.start + out.sec;
  }

  pick(line: OrderLine, order: Order, priority: number, done: (result?: LineResult) => void): void {
    this.enqueue({ kind: 'pick', line, order, priority, done });
  }

  decant(cases: number, priority: number, done: () => void): void {
    let left = cases;
    for (let i = 0; i < cases; i++)
      this.enqueue({
        kind: 'decant',
        priority,
        done: () => {
          if (--left === 0) done();
        },
      });
  }

  private enqueue(r: Req): void {
    let i = this.pending.length;
    while (i > 0 && rank(this.pending[i - 1] as Req) > rank(r)) i--;
    this.pending.splice(i, 0, r);
    this.pump();
  }

  /** 开放的拣货站台：人工站台要有人在岗；机械臂站台一直开放 */
  /**
   * 开放的站台：人工站台要有人在岗，机械臂站台一直开放。
   * 拆箱站：有专职拆箱员时开放；拆箱由站台拣货员兼做时（本方案），有空余的人或者没有拣货请求时才开放。
   */
  private openPorts(): Port[] {
    const people = this.porters.activeCount;
    const open = this.s.mfc.portPicker === 'arm' ? this.s.mfc.ports : Math.min(this.s.mfc.ports, people);
    const list = this.ports.filter((p) => !p.decant).slice(0, open);
    const shared = this.decanters === this.porters;
    const picksWaiting = this.pending.some((r) => r.kind === 'pick');
    const decantOpen = shared ? people > 0 && (this.s.mfc.portPicker === 'arm' || people > open || !picksWaiting) : this.decanters.activeCount > 0;
    if (decantOpen) list.push(this.ports[this.ports.length - 1] as Port);
    return list;
  }

  private pump(): void {
    if (this.down) return;
    const open = this.openPorts();
    while (this.botsFree > 0 && this.pending.length) {
      // 先找能接的拣货请求，没有再做拆箱
      let idx = -1;
      let port: Port | undefined;
      for (let i = 0; i < this.pending.length; i++) {
        const r = this.pending[i] as Req;
        const candidates = open.filter((p) => p.decant === (r.kind === 'decant') && p.queue.length < 2);
        if (!candidates.length) continue;
        port = candidates.reduce((a, b) => (b.queue.length < a.queue.length ? b : a));
        idx = i;
        break;
      }
      if (idx < 0 || !port) return;
      const req = this.pending.splice(idx, 1)[0] as Req;
      this.dispatchBot(req, port);
    }
  }

  private dispatchBot(req: Req, port: Port): void {
    this.botsFree--;
    const bot = this.botBusy.indexOf(false);
    this.botBusy[bot] = true;
    const fetch = this.rng.logNormal(this.s.mfc.botCycleSec, this.s.mfc.botCycleCv) / 2;
    this.botStart[bot] = this.sim.now;
    this.animateBot(bot, this.sim.now, fetch, port);
    this.sim.after(fetch, () => {
      port.queue.push({ req, bot });
      this.servePort(port);
    });
  }

  private servePort(port: Port): void {
    if (port.busy || !port.queue.length) return;
    const { req, bot } = port.queue.shift() as { req: Req; bot: number };
    port.busy = true;
    const sec = this.serviceSec(req);
    if (req.kind === 'decant') this.stats.decantBusySec += sec;
    else this.stats.portBusySec += sec;
    const portPt = port.decant ? (this.layout.poi.decant ?? this.layout.poi.mfcPorts[0]) : this.layout.poi.mfcPorts[port.index];
    if (portPt && this.portAgents[port.index] !== undefined && (this.portAgents[port.index] as number) >= 0) this.trace.dwell(this.portAgents[port.index] as number, this.sim.now, this.sim.now + sec, portPt, '机械臂拣货');
    this.sim.after(sec, () => {
      port.busy = false;
      if (req.kind === 'pick') {
        this.stats.lines++;
        this.stats.items += req.line.qty;
        const h = Math.min(23, Math.floor(this.sim.now / H));
        this.stats.linesByHour[h] = (this.stats.linesByHour[h] as number) + 1;
      } else this.stats.decanted++;
      req.done();
      // 机器人把货箱放回去（另一半周期），可能在这一趟里出故障
      const back = this.rng.logNormal(this.s.mfc.botCycleSec, this.s.mfc.botCycleCv) / 2;
      this.animateBack(bot, this.sim.now, back, port);
      this.sim.after(back, () => {
        // 从派出到放回都算机器人忙碌（含在站台排队等拣的时间）
        this.stats.botBusySec += this.sim.now - (this.botStart[bot] as number);
        this.releaseBot(bot, back * 2);
      });
      this.servePort(port);
    });
  }

  private serviceSec(req: Req): number {
    const m = this.s.mfc;
    if (req.kind === 'decant') return m.decantSecPerCase;
    if (m.portPicker === 'human') return m.humanLineSec + m.humanItemSec * req.line.qty;
    // 机械臂：逐件拣，抓取失败的由人工补
    let sec = 2;
    for (let i = 0; i < req.line.qty; i++) {
      sec += m.armItemSec;
      if (!this.rng.chance(m.armSuccess)) {
        sec += 15;
        this.stats.armAssists++;
      }
    }
    return sec;
  }

  private releaseBot(bot: number, cycle: number): void {
    const rel = this.s.reliability;
    if (this.rng.chance(1 - Math.exp(-cycle / (rel.mtbfHours * H)))) {
      const down = this.rng.logNormal(rel.mttrMin * 60, 0.5);
      this.stats.failures++;
      this.stats.downtimeSec += down;
      this.trace.event(this.sim.now, 'robot', `货格机器人 ${bot + 1} 故障，${Math.round(down / 60)} 分钟后恢复`);
      this.sim.after(down, () => this.freeBot(bot));
      return;
    }
    this.freeBot(bot);
  }

  private freeBot(bot: number): void {
    this.botBusy[bot] = false;
    this.botsFree++;
    this.pump();
  }

  /** 动画：机器人在货格顶上从某个格子跑到站台一侧 */
  private animateBot(bot: number, t0: number, fetch: number, port: Port): void {
    if (!this.trace.enabled) return;
    const r = this.rect;
    const from = this.cell();
    const to = this.portSide(port);
    const agent = this.botAgents[bot] as number;
    // 只能沿格子的行列跑：先横后竖
    this.trace.move(agent, t0, t0 + fetch * 0.85, [from, { x: to.x + (from.x - to.x) * 0.5, y: from.y }, { x: to.x + 0.5, y: to.y }, to], '取箱');
    this.trace.dwell(agent, t0 + fetch * 0.85, t0 + fetch, to, '送箱到站台');
  }

  /** 动画：拣完把货箱放回货格里的某一格 */
  private animateBack(bot: number, t0: number, back: number, port: Port): void {
    if (!this.trace.enabled) return;
    const from = this.portSide(port);
    const to = this.cell();
    this.trace.move(this.botAgents[bot] as number, t0, t0 + back * 0.85, [from, { x: from.x + 0.5, y: from.y }, { x: from.x + (to.x - from.x) * 0.5, y: to.y }, to], '放回货箱');
  }

  private cell(): { x: number; y: number } {
    const r = this.rect;
    return { x: r.x + 1 + Math.floor(this.anim.next() * (r.w - 2)) + 0.5, y: r.y + 1 + Math.floor(this.anim.next() * (r.h - 2)) + 0.5 };
  }

  private portSide(port: Port): { x: number; y: number } {
    const portPt = port.decant ? this.layout.poi.decant : this.layout.poi.mfcPorts[port.index];
    return { x: this.rect.x + 0.6, y: portPt ? portPt.y : this.rect.y + 1 };
  }
}

function rank(r: Req): number {
  // 拣货永远排在拆箱前面；同类按优先级（时段）
  return (r.kind === 'decant' ? 1e9 : 0) + r.priority;
}
