/**
 * 扫描反馈：成功短震 + 高音，失败长震 + 低音（戴手套、看不清屏幕时也能分辨）。
 */
let ctx: AudioContext | undefined;

function beep(freq: number, ms: number): void {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.06;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + ms / 1000);
  } catch {
    // 不支持声音时忽略
  }
}

export function feedback(kind: 'ok' | 'error'): void {
  try {
    navigator.vibrate?.(kind === 'ok' ? 30 : [80, 60, 80]);
  } catch {
    // 忽略
  }
  if (kind === 'ok') beep(1320, 70);
  else beep(220, 220);
}
