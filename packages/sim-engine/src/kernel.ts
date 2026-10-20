/**
 * 离散事件仿真内核：按 (时间, 序号) 顺序执行事件。
 * 同一时刻的事件按加入顺序执行，因此结果完全确定，可复现。
 */
export type Action = () => void;

export class EventQueue {
  private times: number[] = [];
  private seqs: number[] = [];
  private actions: Action[] = [];
  private seq = 0;

  get size(): number {
    return this.times.length;
  }

  push(t: number, action: Action): void {
    const s = ++this.seq;
    let i = this.times.length;
    this.times.push(t);
    this.seqs.push(s);
    this.actions.push(action);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(t, s, this.times[p] as number, this.seqs[p] as number)) break;
      this.move(p, i);
      i = p;
    }
    this.times[i] = t;
    this.seqs[i] = s;
    this.actions[i] = action;
  }

  peekTime(): number | undefined {
    return this.times[0];
  }

  pop(): { t: number; action: Action } | undefined {
    const n = this.times.length;
    if (n === 0) return undefined;
    const t = this.times[0] as number;
    const action = this.actions[0] as Action;
    const lastT = this.times.pop() as number;
    const lastS = this.seqs.pop() as number;
    const lastA = this.actions.pop() as Action;
    if (n > 1) {
      let i = 0;
      const m = n - 1;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let c = i;
        let ct = lastT;
        let cs = lastS;
        if (l < m && this.less(this.times[l] as number, this.seqs[l] as number, ct, cs)) {
          c = l;
          ct = this.times[l] as number;
          cs = this.seqs[l] as number;
        }
        if (r < m && this.less(this.times[r] as number, this.seqs[r] as number, ct, cs)) c = r;
        if (c === i) break;
        this.move(c, i);
        i = c;
      }
      this.times[i] = lastT;
      this.seqs[i] = lastS;
      this.actions[i] = lastA;
    }
    return { t, action };
  }

  private less(t1: number, s1: number, t2: number, s2: number): boolean {
    return t1 < t2 || (t1 === t2 && s1 < s2);
  }

  private move(from: number, to: number): void {
    this.times[to] = this.times[from] as number;
    this.seqs[to] = this.seqs[from] as number;
    this.actions[to] = this.actions[from] as Action;
  }
}

export class Simulation {
  now = 0;
  private readonly queue = new EventQueue();
  private executed = 0;

  constructor(start = 0) {
    this.now = start;
  }

  /** 在绝对时间 t（秒）执行 */
  at(t: number, action: Action): void {
    this.queue.push(Math.max(t, this.now), action);
  }

  /** 在 delay 秒后执行 */
  after(delay: number, action: Action): void {
    this.at(this.now + Math.max(0, delay), action);
  }

  /** 运行到队列清空或到达 until */
  run(until = Number.POSITIVE_INFINITY): void {
    for (;;) {
      const t = this.queue.peekTime();
      if (t === undefined || t > until) break;
      const ev = this.queue.pop() as { t: number; action: Action };
      this.now = ev.t;
      this.executed++;
      ev.action();
    }
    if (Number.isFinite(until)) this.now = Math.max(this.now, until);
  }

  get eventsExecuted(): number {
    return this.executed;
  }
}
