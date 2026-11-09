import type { Cmd } from '../../src/twin/types';
import type { AdapterName, AdapterStats, Refs } from './common';
import { tmsInstruction, type TmsInstruction } from './tms';
import { wmsTask, type WmsTask } from './wms';

/**
 * 发件箱：孪生发出的每条指令换算成外部系统的指令（运输管理系统的调度指令、仓储系统的任务），按先后存着
 * （最近 2000 条），可以再写到一个 JSON Lines 文件里给外部系统取。数据来自模拟的现场时也照样换算，方便对接测试。
 */
export interface OutMsg {
  seq: number;
  t: number;
  adapter: 'tms' | 'wms';
  cmd: Cmd;
  out: TmsInstruction | WmsTask;
}

export class Outbox {
  readonly list: OutMsg[] = [];
  private n = 0;
  private seq = 0;

  constructor(
    private readonly refs: Refs,
    private readonly stats: ReadonlyMap<AdapterName, AdapterStats>,
    private readonly sink?: (line: string) => void,
  ) {}

  /** 把闭环里新发出的指令（从上次看到的那条往后）换算出去 */
  sync(cmds: readonly Cmd[]): void {
    for (; this.n < cmds.length; this.n++) {
      const c = cmds[this.n] as Cmd;
      const tms = tmsInstruction(c, this.refs);
      const wms = tms ? undefined : wmsTask(c, this.refs);
      const out = tms ?? wms;
      if (!out) continue;
      const adapter = tms ? 'tms' : 'wms';
      const e: OutMsg = { seq: ++this.seq, t: c.t, adapter, cmd: c, out };
      this.list.push(e);
      if (this.list.length > 2000) this.list.shift();
      const st = this.stats.get(adapter);
      if (st) st.sent++;
      this.sink?.(JSON.stringify(e));
    }
  }

  since(seq: number): OutMsg[] {
    return this.list.filter((e) => e.seq > seq);
  }
}
