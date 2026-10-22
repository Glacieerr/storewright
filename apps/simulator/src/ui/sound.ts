import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { trafficFor } from '../scene/traffic';
import { siteFor } from '../scene/useSite';
import { env } from '../scene/environment';
import { at } from './format';

/**
 * 环境音（全部用 Web Audio 实时合成，不加载音频文件）：
 * - 路上车流的低沉噪声，音量随车辆数变化；
 * - 下雨的沙沙声；
 * - 拣货扫码的提示音，频率随正在作业的拣货员人数变化；
 * - 清晨晴天的鸟鸣；
 * - 火警时的双音警报。
 * 默认关闭；浏览器要求由用户操作开启。
 */

let ctx: AudioContext | undefined;
let master: GainNode | undefined;
let trafficGain: GainNode | undefined;
let rainGain: GainNode | undefined;
let alarm: { osc: OscillatorNode; gain: GainNode } | undefined;
let timer: number | undefined;

function noiseBuffer(c: AudioContext, brown: boolean): AudioBuffer {
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

function loop(c: AudioContext, buf: AudioBuffer, filter: BiquadFilterNode, gain: GainNode): void {
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(filter).connect(gain).connect(master as GainNode);
  src.start();
}

function beep(freq: number, dur: number, vol: number): void {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = freq;
  o.type = 'sine';
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + dur + 0.02);
}

function chirp(): void {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(2600 + Math.random() * 1200, t);
  o.frequency.exponentialRampToValueAtTime(4200 + Math.random() * 800, t + 0.08);
  o.frequency.exponentialRampToValueAtTime(2400, t + 0.16);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g).connect(master);
  o.start();
  o.stop(t + 0.2);
}

function tick(): void {
  if (!ctx || !trafficGain || !rainGain || !alarm) return;
  const app = useApp.getState();
  const tl = app.timeline;
  const site = siteFor(app.simGeo, app.site);
  const cars = trafficFor(site, app.site.seed, 0).stats().cars;
  const playing = clock.playing;
  const now = ctx.currentTime;
  trafficGain.gain.setTargetAtTime(playing ? Math.min(0.35, 0.04 + cars / 500) : 0.02, now, 0.4);
  rainGain.gain.setTargetAtTime(0.18 * Math.min(1, env.rain), now, 0.6);
  const fire = (tl?.incidents.disruptions ?? []).some((d) => d.kind === 'FIRE_ALARM' && clock.time >= d.start && clock.time < d.end);
  alarm.gain.gain.setTargetAtTime(fire ? 0.06 : 0, now, 0.1);
  alarm.osc.frequency.setValueAtTime(Math.floor(performance.now() / 450) % 2 ? 960 : 720, now);
  if (!playing || !tl) return;
  // 扫码提示音：正在作业的拣货员越多越频繁
  const busy = at(tl.series, tl.series.busy.pick, clock.time);
  if (Math.random() < Math.min(0.6, busy / 25)) beep(1850, 0.07, 0.025);
  const h = (clock.time / 3600) % 24;
  if (h > 5.5 && h < 9.5 && env.night < 0.2 && env.weather === 'clear' && Math.random() < 0.12) chirp();
}

export function setSound(on: boolean): void {
  if (on) {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
      trafficGain = ctx.createGain();
      trafficGain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      loop(ctx, noiseBuffer(ctx, true), lp, trafficGain);
      rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2800;
      bp.Q.value = 0.6;
      loop(ctx, noiseBuffer(ctx, false), bp, rainGain);
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(master);
      osc.start();
      alarm = { osc, gain: g };
    }
    void ctx.resume();
    window.clearInterval(timer);
    timer = window.setInterval(tick, 200);
  } else {
    window.clearInterval(timer);
    void ctx?.suspend();
  }
}
