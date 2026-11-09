import { t as tr } from '../i18n';
/**
 * 帧时间预算和自动画质：一直量每一帧的用时（最近 240 帧，60 帧每秒时约 4 秒，的中位数和 95% 分位数），画质分高 / 中 / 低三档。
 *
 * - 自动：连续 3 秒 95% 分位数超过 40 毫秒（经常掉到 25 帧以下）或者中位数超过 24 毫秒，就降一档；
 *   有余量（连续 8 秒 95% 分位数低于 22 毫秒、中位数低于 18 毫秒）再升一档，
 *   升降之间至少隔 6 秒，免得来回跳。手机（窄屏或触屏）从「中」开始，自动最多升到「中」。
 * - 每档管：像素密度的上限、阴影（开关、阴影图大小）、监控画面多少帧画一次、标签的多少、雨滴的数量、
 *   对比回放的右半边多少帧画一次（对比时一帧画两遍场景，帧时间超了就和别的一起降档）。
 * - 页面切到后台（requestAnimationFrame 很久才来一次）、刚建好场景的头两秒（着色器编译）不算。
 */
export type QualityTier = 'high' | 'mid' | 'low';
export type QualityMode = 'auto' | QualityTier;
export const QUALITY_MODES: QualityMode[] = ['auto', 'high', 'mid', 'low'];
export const TIER_LABEL: Record<QualityTier, string> = { high: tr('高'), mid: tr('中'), low: tr('低') };

export interface TierSettings {
  /** 像素密度上限 */
  dpr: number;
  shadows: boolean;
  shadowSize: number;
  /** 监控画面每几帧画一次（其余的帧用上一次画好的） */
  monitorEvery: number;
  /** 标签：2 全部、1 少一点（不显示区域里的小地名、店里的小标签） */
  labels: 1 | 2;
  /** 雨滴最多几条 */
  rain: number;
  /** 对比回放的右半边每几帧画一次（其余的帧保留上一次画好的） */
  splitEvery: number;
}
export const TIERS: Record<QualityTier, TierSettings> = {
  high: { dpr: 2, shadows: true, shadowSize: 2048, monitorEvery: 1, labels: 2, rain: 8000, splitEvery: 1 },
  mid: { dpr: 1.5, shadows: true, shadowSize: 1024, monitorEvery: 2, labels: 2, rain: 5000, splitEvery: 2 },
  low: { dpr: 1, shadows: false, shadowSize: 1024, monitorEvery: 4, labels: 1, rain: 2000, splitEvery: 3 },
};
const ORDER: QualityTier[] = ['low', 'mid', 'high'];
/** 60 赫兹的屏幕上偶尔掉一帧就是 33 毫秒，不算超预算；经常掉两帧（40 毫秒以上）或者一半的帧都慢才降档 */
export const BUDGET_MS = 40;
const BUDGET_P50 = 24;
const HEADROOM_MS = 22;
const HEADROOM_P50 = 18;
const DOWN_AFTER = 3000;
const UP_AFTER = 8000;
const COOLDOWN = 6000;

export class FrameBudget {
  private readonly ring = new Float32Array(240);
  private readonly sorted = new Float32Array(240);
  private n = 0;
  private i = 0;
  private overSince = -1;
  private underSince = -1;
  private lastChange = 0;
  private ignoreUntil = 0;
  private nextEval = 0;
  mode: QualityMode = 'auto';
  tier: QualityTier;
  /** 自动最多升到哪一档（手机是「中」） */
  readonly cap: QualityTier;

  constructor(phone: boolean, now = performance.now()) {
    this.cap = phone ? 'mid' : 'high';
    this.tier = phone ? 'mid' : 'high';
    this.ignoreUntil = now + 2000;
  }

  /** 场景重建、切回页面时：先别算接下来两秒 */
  settle(now = performance.now()): void {
    this.ignoreUntil = now + 2000;
    this.overSince = -1;
    this.underSince = -1;
  }

  /** 记一帧的用时（毫秒） */
  push(ms: number, now = performance.now()): void {
    if (now < this.ignoreUntil || ms > 250 || ms <= 0) return;
    this.ring[this.i] = ms;
    this.i = (this.i + 1) % this.ring.length;
    this.n = Math.min(this.ring.length, this.n + 1);
  }

  private quantile(q: number): number {
    if (!this.n) return 0;
    const a = this.sorted.subarray(0, this.n);
    a.set(this.ring.subarray(0, this.n));
    a.sort();
    return a[Math.min(a.length - 1, Math.floor(q * a.length))] as number;
  }
  get p50(): number {
    return this.quantile(0.5);
  }
  get p95(): number {
    return this.quantile(0.95);
  }

  /** 自动画质：要换档就返回新的档，不换返回 undefined */
  tick(now = performance.now()): QualityTier | undefined {
    if (this.mode !== 'auto' || this.n < 60 || now < this.ignoreUntil || now < this.nextEval) return undefined;
    // 一秒看四次就够了（升降档按秒算）
    this.nextEval = now + 250;
    const p95 = this.p95;
    const p50 = this.p50;
    if (p95 > BUDGET_MS || p50 > BUDGET_P50) {
      this.underSince = -1;
      if (this.overSince < 0) this.overSince = now;
      if (now - this.overSince > DOWN_AFTER && now - this.lastChange > COOLDOWN && this.tier !== 'low') return this.change(ORDER[ORDER.indexOf(this.tier) - 1] as QualityTier, now);
    } else if (p95 < HEADROOM_MS && p50 < HEADROOM_P50) {
      this.overSince = -1;
      if (this.underSince < 0) this.underSince = now;
      if (now - this.underSince > UP_AFTER && now - this.lastChange > COOLDOWN && ORDER.indexOf(this.tier) < ORDER.indexOf(this.cap)) return this.change(ORDER[ORDER.indexOf(this.tier) + 1] as QualityTier, now);
    } else {
      this.overSince = -1;
      this.underSince = -1;
    }
    return undefined;
  }

  private change(t: QualityTier, now: number): QualityTier {
    this.tier = t;
    this.lastChange = now;
    this.overSince = -1;
    this.underSince = -1;
    // 换档后的帧时间重新量
    this.n = 0;
    this.i = 0;
    this.ignoreUntil = now + 1500;
    return t;
  }

  /** 手动选一档，或者回到自动（自动从现在这一档开始） */
  setMode(m: QualityMode, now = performance.now()): QualityTier {
    this.mode = m;
    if (m !== 'auto') this.tier = m;
    this.lastChange = now;
    this.settle(now);
    return this.tier;
  }
}
