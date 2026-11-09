import { buildContainerJourney, type Journey, type TourInput, type TourLeg, type TourSource, type TourText } from '../../src/tour/container';
import type { Scenario } from '../../src/scenario/types';
import { scenarioUrl } from '../../src/scenario/url';
import { appApi } from './appBus';
import { isEn, t } from './i18n';
import type { RegionView } from './three/view';
import './tour.css';

/**
 * 演示导览「一个集装箱从船到货架」：一键开始，按 src/tour/container.ts 串出来的每一段——跳到那个时刻、镜头飞过去、
 * 跟随那辆车（画整趟路线）、显示说明卡（几条数字、数据从哪来），每段约 7 秒自动往下走，整段约 1 分钟。
 * 顶栏的按钮、document 上的 'storex:start-tour' 事件（欢迎卡、场景里的 tour=container）都能开始；键盘 ← → 空格 Esc。
 *
 * "One container, ship to shelf" guided tour: jumps the clock, flies the camera, follows the vehicle and shows a
 * caption card per leg; about one minute end to end.
 */
export interface TourDeps {
  view: RegionView;
  /** 导览要的数据（还没仿真完返回 undefined） */
  data(): TourInput | undefined;
  setTime(t: number): void;
  setPlaying(on: boolean): void;
  isPlaying(): boolean;
  getSpeed(): number;
  setSpeed(s: number): void;
  /** 正在仿真（换方案、负荷……） */
  busy(): boolean;
}

/** 每一段停多久（毫秒）；跨天的段多停一会儿 */
const LEG_MS = 7000;
const SKIP_MS = 1500;
/** 导览时的播放速度：仿真每秒走 10 秒，车慢慢动 */
const TOUR_SPEED = 10;
/** 和导览相关的练习（港口：卸船与堆场停留） */
const RELATED_EXERCISE = 'ex02';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const pick = (x: TourText) => (isEn() ? x.en : x.zh);
const clock = (s: number) => {
  const m = Math.max(0, Math.min(1439, Math.floor(s / 60)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const SOURCE_LABEL = (): Record<TourSource, { text: string; title: string }> => ({
  record: { text: t('仿真记录'), title: t('这一段的时刻、门、车都来自仿真和作业计划的记录，动画里看得到') },
  estimate: { text: t('按规则估算'), title: t('这一段按规则推出来（例如方案的平均停留、先进先出配车），不是逐件的记录') },
  proxy: { text: t('今天的同类作业'), title: t('这个箱的这一段不在动画这一天：用今天同一个环节的另一件货演示') },
});
/**
 * 结束卡上的「换到极限负荷再看」：默认场景（默认区域、StoreX 全链路、第 1 组、没有演练、设施没改）下，平常、旺季、高负荷三档
 * 跟的箱都要在堆场停一两天才提箱，9 段里 4 段是仿真记录；极限负荷那一天本店的箱当天就从堆场提走、送进配送中心，
 * 仿真记录的段更多（scripts/check3d.mjs 在浏览器里核对两天的段数）。别的场景没有核对过，不显示。
 */
const extremeOffer = (s: Scenario | undefined): boolean =>
  !!s && !s.region && (s.gen ?? 'g3') === 'g3' && (s.seed ?? 1) === 1 && (s.drill ?? 'none') === 'none' && !s.facilities && (s.load ?? 'normal') !== 'extreme';
/** 系统设置了「减少动态」（prefers-reduced-motion） */
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class TourPlayer {
  private journey: Journey | undefined;
  private i = -1;
  private active = false;
  private paused = false;
  private everStarted = false;
  private pending = false;
  private firstReady = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private saved: { playing: boolean; speed: number } | undefined;
  private readonly card: HTMLElement;
  /** 自动往下一段走（录制动图的脚本关掉它，自己控制节奏） */
  autoAdvance = true;
  /** 打开导览前有焦点的元素（关掉以后焦点回到它） */
  private opener: HTMLElement | undefined;
  /** 镜头飞过去用的毫秒 */
  flyMs = 1500;

  constructor(
    host: HTMLElement,
    private readonly deps: TourDeps,
  ) {
    this.card = document.createElement('section');
    this.card.className = 'tour-card';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-live', 'polite');
    this.card.setAttribute('aria-label', t('演示导览：一个集装箱从船到货架'));
    this.card.tabIndex = -1;
    host.append(this.card);
    this.card.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('storex:start-tour', () => this.start());
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get isActive(): boolean {
    return this.active;
  }
  /** 正在放的导览和第几段（调试、录制脚本用） */
  get state(): { journey: Journey | undefined; index: number; paused: boolean } {
    return { journey: this.journey, index: this.i, paused: this.paused };
  }

  /** 仿真完成（换了方案、负荷、一天……）：数据变了，正在放的导览停下；之前要求开始的现在开始 */
  ready(): void {
    if (this.active) this.stop();
    this.journey = undefined;
    if (this.pending) {
      this.pending = false;
      this.start();
    }
    // 网址里有 tour=container：场景的读取和套用（分享链接）没接上导览时，第一次仿真完以后自己开始一次
    if (this.firstReady) {
      this.firstReady = false;
      const want = (() => {
        try {
          return new URLSearchParams(location.search).get('tour') === 'container';
        } catch {
          return false;
        }
      })();
      if (want) setTimeout(() => !this.everStarted && this.start(), 2500);
    }
  }

  start(): void {
    if (this.active) return;
    if (this.deps.busy()) {
      this.pending = true;
      return;
    }
    const data = this.deps.data();
    if (!data) {
      this.pending = true;
      return;
    }
    this.journey = buildContainerJourney(data);
    this.everStarted = true;
    if (!this.journey) {
      this.active = true;
      this.renderEmpty();
      return;
    }
    this.active = true;
    // 系统设置了「减少动态」：一开始就是暂停，不自动翻页（按 → 或「下一段」翻，「继续」恢复自动）
    this.paused = reducedMotion();
    this.saved = { playing: this.deps.isPlaying(), speed: this.deps.getSpeed() };
    this.deps.setSpeed(TOUR_SPEED);
    this.deps.setPlaying(true);
    this.foldPanels();
    this.card.hidden = false;
    this.go(0);
    // 焦点进导览卡（键盘、读屏能直接操作），退出时回到原来的按钮
    const prev = document.activeElement;
    this.opener = prev instanceof HTMLElement && prev !== document.body ? prev : (document.getElementById('tour-btn') ?? undefined);
    this.card.focus({ preventScroll: true });
    // 手机上三维画面在控件下面：卷到看得见画面和卡片的位置
    const r = this.card.getBoundingClientRect();
    if (r.bottom > innerHeight || r.top < 0) (this.card.parentElement ?? this.card).scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'end' });
  }

  /** 导览时把三维上面的两块面板（实时跟踪、设施监控）收起来，结束时展开（只展开导览收起的） */
  private folded: HTMLElement[] = [];
  private foldPanels(): void {
    for (const id of ['track', 'facility']) {
      const host = document.getElementById(id);
      const btn = host?.querySelector<HTMLElement>('[data-min]');
      if (host && btn && !host.classList.contains('collapsed')) {
        btn.click();
        this.folded.push(host);
      }
    }
  }
  private unfoldPanels(): void {
    for (const host of this.folded.splice(0)) if (host.classList.contains('collapsed')) host.querySelector<HTMLElement>('[data-min]')?.click();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.clearTimers();
    const hadFocus = this.card.contains(document.activeElement);
    this.card.hidden = true;
    this.card.innerHTML = '';
    if (hadFocus && this.opener?.isConnected) this.opener.focus();
    this.opener = undefined;
    const v = this.deps.view;
    v.setFollow(undefined);
    v.selectVehicle(undefined, false);
    v.setTourMark(undefined);
    this.unfoldPanels();
    if (this.saved) {
      this.deps.setSpeed(this.saved.speed);
      this.deps.setPlaying(this.saved.playing);
      this.saved = undefined;
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.followTimer) clearTimeout(this.followTimer);
    this.timer = undefined;
    this.followTimer = undefined;
  }

  private go(i: number): void {
    const j = this.journey;
    if (!j || !this.active) return;
    this.clearTimers();
    this.i = Math.max(0, Math.min(j.legs.length, i));
    if (this.i >= j.legs.length) {
      this.deps.view.setFollow(undefined);
      this.renderEnd();
      return;
    }
    const leg = j.legs[this.i] as TourLeg;
    this.deps.setTime(leg.at);
    this.aim(leg);
    this.render();
    this.schedule(leg);
  }

  private schedule(leg: TourLeg): void {
    if (this.paused || !this.autoAdvance) return;
    this.timer = setTimeout(() => this.go(this.i + 1), LEG_MS + (leg.skipDays ? SKIP_MS : 0));
  }

  /** 镜头：飞到这一段要看的地方，是车就飞到车旁边再跟随 */
  private aim(leg: TourLeg): void {
    const v = this.deps.view;
    v.selectVehicle(leg.vehicle, false);
    v.setTourMark(undefined);
    const box = this.journey?.box ?? '';
    const w = leg.where;
    const port = (x: number, z: number, off: [number, number, number]) => {
      const p = v.portToWorld(x, z);
      const d = v.portDirToWorld(off[0], off[2]);
      v.flyTo({ x: p.x, z: p.z }, { x: d.x, y: off[1], z: d.z }, this.flyMs);
    };
    switch (w.kind) {
      case 'vehicle': {
        v.vehicles.update(leg.at, 1);
        const p = v.vehicles.poseOf(w.vehicle) as { x: number; y: number; z?: number } | undefined;
        if (!p) {
          v.focus(leg.key === 'store' || leg.key === 'dispatch' ? (leg.key === 'store' ? 'flagship' : 'dc') : leg.key === 'ship' ? 'port' : 'dc');
          return;
        }
        const kind = v.vehicles.items[w.vehicle]?.kind ?? '';
        const k = kind === 'ship' ? 9 : kind === 'train' ? 3.2 : kind === 'plane' ? 4.5 : 1.35;
        v.flyTo({ x: p.x, z: p.z ?? p.y }, { x: 26 * k, y: 24 * k, z: 34 * k }, this.flyMs);
        const id = w.vehicle;
        this.followTimer = setTimeout(() => this.active && v.setFollow(id), this.flyMs + 50);
        return;
      }
      case 'port-berth': {
        const s = v.port.ownBerthSpot();
        port(s.x, s.z, [150, 105, 170]);
        const p = v.portToWorld(s.x, s.z + 30);
        v.setTourMark({ text: t('本店班轮的泊位 · 岸桥在这里卸箱'), x: p.x, y: 40, z: p.z });
        return;
      }
      case 'port-box': {
        const s = v.port.boxSpot(w.box);
        const at = s ?? v.port.ownBerthSpot();
        port(at.x, at.z, [70, 72, 96]);
        if (s) {
          const p = v.portToWorld(s.x, s.z);
          v.setTourMark({ text: t('本店的箱 {box}', { box }), x: p.x, y: s.y + 3, z: p.z });
        }
        return;
      }
      case 'port-gate':
        port(-2100, 1222, [90, 75, 110]);
        return;
      case 'store-point': {
        const p = v.storeToWorld(w.x, w.y);
        const d = v.storeDirToWorld(14, 18);
        v.flyTo({ x: p.x, z: p.z }, { x: d.x, y: 24, z: d.z }, this.flyMs);
        v.setTourMark({ text: t('在这里上架'), x: p.x, y: 3, z: p.z });
        return;
      }
      case 'preset':
        v.focus(w.preset);
        return;
    }
  }

  private header(): string {
    const j = this.journey;
    const n = j?.legs.length ?? 0;
    const step = this.i < n ? t('第 {i} / {n} 段', { i: this.i + 1, n }) : t('导览结束');
    return `<header class="tour-head"><span class="tour-kicker">${esc(t('一个集装箱从船到货架'))}</span><span class="tour-step">${esc(step)}</span><button type="button" class="tour-x" data-act="exit" aria-label="${esc(t('退出导览'))}" title="${esc(t('退出导览（Esc）'))}">×</button></header>`;
  }

  private dots(): string {
    const n = this.journey?.legs.length ?? 0;
    let h = '';
    for (let k = 0; k < n; k++) {
      const leg = this.journey?.legs[k] as TourLeg;
      h += `<button type="button" class="tour-dot src-${leg.source}${k === this.i ? ' on' : ''}${k < this.i ? ' done' : ''}" data-act="dot" data-i="${k}" aria-label="${esc(`${k + 1}. ${isEn() ? leg.titleEn : leg.title}`)}"></button>`;
    }
    return `<nav class="tour-dots" aria-label="${esc(t('各段'))}">${h}</nav>`;
  }

  private render(): void {
    const j = this.journey as Journey;
    const leg = j.legs[this.i] as TourLeg;
    const src = SOURCE_LABEL()[leg.source];
    const facts = leg.facts.map((f) => `<li>${esc(pick(f))}</li>`).join('');
    const skip = leg.skipDays ? `<p class="tour-skip">⏩ ${esc(t('跳过约 {d} 天', { d: leg.skipDays.toFixed(1) }))}</p>` : '';
    const intro = this.i === 0 ? `<p class="tour-summary">${esc(pick(j.summary))}</p>` : '';
    const dur = (LEG_MS + (leg.skipDays ? SKIP_MS : 0)) / 1000;
    this.card.innerHTML = `${this.header()}${intro}
      <h3 class="tour-title">${esc(isEn() ? leg.titleEn : leg.title)} <span class="tour-src src-${leg.source}" title="${esc(src.title)}">${esc(src.text)}</span></h3>
      <p class="tour-clock">${esc(t('动画时刻 {clock}', { clock: clock(leg.at) }))}</p>
      <ul class="tour-facts">${facts}</ul>${skip}
      ${leg.note ? `<p class="tour-note">${esc(pick(leg.note))}</p>` : ''}
      ${this.dots()}
      <div class="tour-ctl">
        <button type="button" class="chip" data-act="prev" ${this.i === 0 ? 'disabled' : ''}>◀ ${esc(t('上一段'))}</button>
        <button type="button" class="chip" data-act="pause" aria-pressed="${this.paused}">${this.paused ? `▶ ${esc(t('继续'))}` : `❚❚ ${esc(t('暂停'))}`}</button>
        <button type="button" class="chip primary" data-act="next">${esc(t('下一段'))} ▶</button>
      </div>
      <div class="tour-bar${this.paused ? ' paused' : ''}"><i style="animation-duration:${dur}s"></i></div>`;
  }

  private renderEnd(): void {
    const j = this.journey as Journey;
    const src = SOURCE_LABEL();
    const legend = (['record', 'estimate', 'proxy'] as const).map((k) => `<li><span class="tour-src src-${k}">${esc(src[k].text)}</span> ${esc(src[k].title)}</li>`).join('');
    const rec = j.legs.filter((l) => l.source === 'record').length;
    const offer = extremeOffer(appApi()?.currentScenario());
    const tally = t('这一趟 {n} 段里 {r} 段直接来自仿真记录。', { n: j.legs.length, r: rec });
    const more = offer ? `${isEn() ? ' ' : ''}${t('极限负荷（压力测试那一档）那一天，本店的箱当天就从堆场提走、送进配送中心，来自仿真记录的段更多。')}` : '';
    this.card.innerHTML = `${this.header()}
      <h3 class="tour-title">${esc(t('从船到货架，走完了'))}</h3>
      <p class="tour-summary">${esc(pick(j.summary))}</p>
      <ul class="tour-legend">${legend}</ul>
      <p class="tour-note tour-tally">${esc(tally + more)}</p>
      ${this.dots()}
      <div class="tour-ctl tour-end">
        <button type="button" class="chip primary" data-act="link">${esc(t('复制这个场景的链接'))}</button>
        ${offer ? `<button type="button" class="chip" data-act="extreme">${esc(t('换到极限负荷再看'))}</button>` : ''}
        <button type="button" class="chip" data-act="teach">${esc(t('做一道相关练习'))}</button>
        <button type="button" class="chip" data-act="again">${esc(t('再看一遍'))}</button>
        <button type="button" class="chip" data-act="exit">${esc(t('关闭'))}</button>
      </div>
      <p class="tour-copied" hidden></p>`;
  }

  private renderEmpty(): void {
    this.card.hidden = false;
    this.card.innerHTML = `${this.header().replace(/<span class="tour-step">.*?<\/span>/, '')}
      <p class="tour-note">${esc(t('这一天里找不到可以跟的本店的箱、班列或空运货（换一组仿真或换个负荷再试）。'))}</p>
      <div class="tour-ctl"><button type="button" class="chip" data-act="exit">${esc(t('关闭'))}</button></div>`;
  }

  /** 这个场景的分享链接（带上 tour=container，打开就放导览） */
  private link(): string {
    const base = location.origin + location.pathname;
    const s = appApi()?.currentScenario();
    if (s) return scenarioUrl(base, { ...s, tour: 'container' }, new URLSearchParams(location.search));
    const u = new URL(location.href);
    u.searchParams.set('tour', 'container');
    return u.toString();
  }

  private async copyLink(): Promise<void> {
    const url = this.link();
    const out = this.card.querySelector<HTMLElement>('.tour-copied');
    const ok = await navigator.clipboard.writeText(url).then(
      () => true,
      () => false,
    );
    if (out) {
      out.hidden = false;
      out.innerHTML = ok ? esc(t('链接已复制')) : `${esc(t('复制不了，请手动复制：'))}<input class="tour-url" readonly value="${esc(url)}" aria-label="${esc(t('分享链接'))}">`;
      out.querySelector<HTMLInputElement>('input')?.select();
    }
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    // 离开导览的两个按钮：练习抽屉、换到极限负荷那一天（重新仿真，排完以后从头放导览）
    if (act === 'teach') {
      this.stop();
      document.dispatchEvent(new CustomEvent('storex:open-teach', { detail: { exercise: RELATED_EXERCISE } }));
      return;
    }
    if (act === 'extreme') {
      this.toExtreme();
      return;
    }
    if (act === 'exit') this.stop();
    else if (act === 'next') this.go(this.i + 1);
    else if (act === 'prev') this.go(this.i - 1);
    else if (act === 'dot') this.go(Number(b.dataset.i));
    else if (act === 'pause') this.togglePause();
    else if (act === 'again') this.go(0);
    else if (act === 'link') void this.copyLink();
    // 翻页会重画卡片：焦点放回同一个按钮（没有了就放在卡片上），键盘可以接着按
    if (this.active && act !== 'link') (this.card.querySelector<HTMLElement>(`[data-act="${act}"]:not([disabled])`) ?? this.card).focus({ preventScroll: true });
  }

  /** 换到极限负荷那一天：套用场景（重新仿真），场景里的 tour=container 让导览在仿真和设施排完以后从头开始 */
  private toExtreme(): void {
    const api = appApi();
    const s = api?.currentScenario();
    if (!api || !s) return;
    this.stop();
    void api.applyScenario({ format: s.format, version: s.version, gen: s.gen ?? 'g3', seed: s.seed ?? 1, load: 'extreme', drill: s.drill ?? 'none', tour: 'container' });
  }

  private togglePause(): void {
    if (!this.active || !this.journey) return;
    this.paused = !this.paused;
    if (this.i >= this.journey.legs.length) return;
    if (this.paused) this.clearTimers();
    this.render();
    if (!this.paused) this.schedule(this.journey.legs[this.i] as TourLeg);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (e.key === 'Escape') this.stop();
    else if (e.key === 'ArrowRight') this.go(this.i + 1);
    else if (e.key === 'ArrowLeft') this.go(this.i - 1);
    else if (e.key === ' ') this.togglePause();
    else return;
    e.preventDefault();
  }
}
