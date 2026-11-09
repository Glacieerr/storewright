import type { Pt } from '../world/layout';

/**
 * 动画轨迹：每个员工、机器人、顾客、车辆是一条轨迹，由一段段「移动」和「原地作业」组成。
 * 批量实验时不记录（enabled = false），只在网页模拟器里打开。
 */
export type AgentKind =
  | 'shopper'
  | 'picker'
  | 'dispenser'
  | 'porter'
  | 'decanter'
  | 'freshPicker'
  | 'handoff'
  | 'stocker'
  | 'receiver'
  | 'cashier'
  | 'host'
  | 'robotTech'
  | 'amr'
  | 'scanner'
  | 'scrubber'
  | 'cart'
  | 'pallet'
  | 'loader'
  | 'mfcBot'
  | 'truck'
  | 'car'
  | 'van';

export interface Segment {
  t0: number;
  t1: number;
  /** 拐点坐标（x0, y0, x1, y1, …）；原地作业时只有一个点 */
  pts: number[];
  act?: string;
}

export interface AgentTrace {
  id: number;
  kind: AgentKind;
  label: string;
  segs: Segment[];
  /** 排班的员工：在岗时段（开始, 结束, 开始, 结束, …；最后一段没结束时结束是 NaN） */
  on?: number[];
  /** 待命的位置 [x, y]（还没动过、或者一直不走动的员工，例如站台拣货员） */
  home?: number[];
}

export interface TraceEvent {
  t: number;
  kind: 'order' | 'pickup' | 'stockout' | 'restock' | 'truck' | 'robot' | 'shift' | 'info';
  text: string;
}

export class Trace {
  agents: AgentTrace[] = [];
  events: TraceEvent[] = [];

  constructor(readonly enabled: boolean) {}

  add(kind: AgentKind, label: string, home?: Pt): number {
    if (!this.enabled) return -1;
    this.agents.push({ id: this.agents.length, kind, label, segs: [], ...(home ? { home: [home.x, home.y] } : {}) });
    return this.agents.length - 1;
  }

  move(id: number, t0: number, t1: number, path: readonly Pt[], act?: string): void {
    if (!this.enabled || id < 0 || t1 <= t0) return;
    const pts: number[] = [];
    for (const p of path) pts.push(p.x, p.y);
    (this.agents[id] as AgentTrace).segs.push({ t0, t1, pts, ...(act ? { act } : {}) });
  }

  dwell(id: number, t0: number, t1: number, at: Pt, act?: string): void {
    if (!this.enabled || id < 0 || t1 <= t0) return;
    (this.agents[id] as AgentTrace).segs.push({ t0, t1, pts: [at.x, at.y], ...(act ? { act } : {}) });
  }

  /** 员工上岗 / 下岗 */
  shift(id: number, t: number, on: boolean): void {
    if (!this.enabled || id < 0) return;
    const a = this.agents[id] as AgentTrace;
    const list = (a.on ??= []);
    if (on) list.push(t, NaN);
    else if (list.length && Number.isNaN(list[list.length - 1] as number)) list[list.length - 1] = t;
  }

  event(t: number, kind: TraceEvent['kind'], text: string): void {
    if (this.enabled) this.events.push({ t, kind, text });
  }
}
