import type { Junction, Line } from './roadnet';

/**
 * 信号灯的配时（背景车流、仿真车辆共用）：周期 80 秒，两个相位各 36 秒绿灯，绿灯结束后 3 秒黄灯；
 * 相位 1 比相位 0 晚半个周期，每个路口有自己的周期偏移（roadnet 的 phases 按路口编号算）。
 */
export const CYCLE = 80;
export const GREEN = 36;
export const AMBER = 3;
/** 排队的头车在绿灯亮后多久起步（秒） */
export const REACT = 1.2;
/** 停止线离车道终点（车道在路口退让处结束）多远：中间是 4 米宽的斑马线，车头停在停止线后面（米） */
export const STOP_BACK = 6.6;

/** 这个相位此刻在周期里的第几秒（0…CYCLE，小于 GREEN 是绿灯） */
export function phaseClock(j: Pick<Junction, 'offset'>, phase: number, t: number): number {
  const c = (((t + j.offset) % CYCLE) + CYCLE) % CYCLE;
  return phase === 0 ? c : (c + CYCLE / 2) % CYCLE;
}

export function greenAt(j: Pick<Junction, 'offset'>, phase: number, t: number): boolean {
  return phaseClock(j, phase, t) < GREEN;
}

/** 下一次绿灯亮的时刻（此刻就是绿灯返回 t） */
export function nextGreen(j: Pick<Junction, 'offset'>, phase: number, t: number): number {
  const l = phaseClock(j, phase, t);
  return l < GREEN ? t : t + (CYCLE - l);
}

/** 沿线 line 开到路口 jid 的进口道属于哪个相位；没有信号灯、T 形路口和分合流点返回 undefined */
export function approachPhase(j: Junction | undefined, line: Pick<Line, 'id' | 'ja'>, jid: string): 0 | 1 | undefined {
  if (!j || !j.signal || j.kind === 'mid' || j.kind === 'merge') return undefined;
  return j.phase.get(line.id * 2 + (jid === line.ja ? 0 : 1));
}
