/**
 * 离散事件仿真内核：时间单位是秒（从当天 0 点算起），事件按时间先后执行，同一时刻按加入顺序（稳定）。
 */
interface Event {
  t: number;
  seq: number;
  fn: () => void;
}

export class Sim {
  now = 0;
  private heap: Event[] = [];
  private seq = 0;
  /** 已执行的事件数（用来检查性能和死循环） */
  executed = 0;

  at(t: number, fn: () => void): void {
    const e: Event = { t: Math.max(t, this.now), seq: this.seq++, fn };
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(h[p] as Event, e)) break;
      h[i] = h[p] as Event;
      i = p;
    }
    h[i] = e;
  }

  after(dt: number, fn: () => void): void {
    this.at(this.now + Math.max(0, dt), fn);
  }

  /** 执行到时刻 until（含）或没有事件为止 */
  run(until: number): void {
    const h = this.heap;
    while (h.length) {
      const top = h[0] as Event;
      if (top.t > until) break;
      const last = h.pop() as Event;
      if (h.length) {
        let i = 0;
        const n = h.length;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= n) break;
          const r = l + 1;
          const c = r < n && before(h[r] as Event, h[l] as Event) ? r : l;
          if (before(last, h[c] as Event)) break;
          h[i] = h[c] as Event;
          i = c;
        }
        h[i] = last;
      }
      this.now = top.t;
      this.executed++;
      top.fn();
    }
    this.now = Math.max(this.now, until);
  }

  get pending(): number {
    return this.heap.length;
  }
}

function before(a: Event, b: Event): boolean {
  return a.t < b.t || (a.t === b.t && a.seq < b.seq);
}

/** 秒 ↔ 时刻文字 */
export const H = 3600;
export function clock(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
