import { useEffect, useState } from 'react';

/**
 * 播放时钟。高频变化的时间不放进 React 状态：
 * 3D 场景每帧直接读取，界面面板按需以较低频率刷新。
 */
export const clock = {
  time: 0,
  start: 0,
  end: 1,
  playing: false,
  /** 仿真秒 / 现实秒 */
  speed: 60,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function emitClock(): void {
  for (const l of listeners) l();
}

export function setTime(t: number): void {
  clock.time = Math.min(clock.end, Math.max(clock.start, t));
  emitClock();
}

export function setPlaying(p: boolean): void {
  clock.playing = p;
  emitClock();
}

export function setSpeed(s: number): void {
  clock.speed = s;
  emitClock();
}

export function setRange(start: number, end: number): void {
  clock.start = start;
  clock.end = end;
  clock.time = Math.min(end, Math.max(start, clock.time || start));
  emitClock();
}

/** 由渲染循环调用 */
export function advance(deltaSec: number): void {
  if (!clock.playing) return;
  clock.time = Math.min(clock.end, clock.time + deltaSec * clock.speed);
  if (clock.time >= clock.end) clock.playing = false;
}

/** 以 hz 频率刷新的当前时间（供界面面板使用） */
export function useClock(hz = 6): number {
  const [t, setT] = useState(clock.time);
  useEffect(() => {
    const id = window.setInterval(() => setT(clock.time), 1000 / hz);
    const l = () => setT(clock.time);
    listeners.add(l);
    return () => {
      window.clearInterval(id);
      listeners.delete(l);
    };
  }, [hz]);
  return t;
}

export function useClockState(): { playing: boolean; speed: number } {
  const [s, setS] = useState({ playing: clock.playing, speed: clock.speed });
  useEffect(() => {
    const l = () => setS({ playing: clock.playing, speed: clock.speed });
    listeners.add(l);
    const id = window.setInterval(l, 250);
    return () => {
      listeners.delete(l);
      window.clearInterval(id);
    };
  }, []);
  return s;
}
