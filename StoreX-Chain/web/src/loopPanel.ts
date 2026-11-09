import { FAMILIES } from '../../src/region/products';
import { LEVEL_LABEL, type FieldLevel } from '../../src/twin/field';
import type { KpiPoint, LoopResult } from '../../src/twin/loop';
import { clock, sumScore } from '../../src/twin/twin';
import { ISSUE_LABEL, POLICY_LABEL, type Msg, type Policy, type Rec, type UserDecision } from '../../src/twin/types';
import { cmdText, commandTrail } from '../../src/assistant/trail';
import { QUALITY_LABEL, type DataQuality } from '../../src/twin/channel';
import { t as tr, tx, isEn } from './i18n';

/**
 * 闭环孪生面板：现场 → 感知数据 → 孪生（估计、推演）→ 建议和决策 → 指令 → 现场。
 *
 * - 设置：自动执行的范围（全部人工确认 / 低风险的自动执行 / 全部自动执行）、现场状况（平常 / 多事的一天）和编号；
 * - 闭环一圈：到此刻为止收到的数据、孪生的估计误差、待处理和已执行的建议、发出的指令、现场的结果；
 * - 建议卡：孪生发现的问题、几种做法和逐个推演的结果，推荐合计最好的；待处理的卡可以选一个做法执行或者否决，
 *   决定在此刻生效，整天从头再跑一遍；
 * - 用孪生 / 不用孪生：同样的现场状况跑两遍，比到此刻为止的迟到、超温、缺货、等门和多花的钱；
 * - 孪生的保真度、学到的「比计划慢多少」、门店库存（估计 / 实际）、现场数据流。
 */
export type LoopView = 'plan' | 'closed' | 'open';
export interface LoopSettings {
  policy: Policy;
  level: FieldLevel;
  seed: number;
  /** 通信质量：数据到孪生之前丢点、晚到 */
  quality: DataQuality;
}
export interface LoopHost {
  onSettings(s: LoopSettings): void;
  onDecision(d: UserDecision): void;
  onUndo(): void;
  onView(v: LoopView): void;
  onVehicle(vid: number): void;
  setTime(t: number): void;
}
export interface LoopData {
  closed: LoopResult;
  open: LoopResult;
  ms: number;
  decisions: readonly UserDecision[];
  /** 车辆下标 → 作业编号或车名 */
  labelOf: (vid: number) => string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const n1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const famLabel = (k: string) => FAMILIES.find((f) => f.key === k)?.label ?? k;
const STATUS: Record<Rec['status'], string> = { proposed: tr('待处理'), done: tr('已执行'), rejected: tr('调度员否了'), resolved: tr('问题自己没了'), expired: tr('没处理，发生了') };
const score = (p: KpiPoint | undefined) => (p ? p.late + p.hot * 2 + p.short * 1.5 + p.cost / 12 : 0);

export class LoopPanel {
  private data: LoopData | undefined;
  private t = 0;
  private view: LoopView = 'plan';
  private settings: LoopSettings = { policy: 'safe', level: 'normal', seed: 1, quality: 'good' };
  private showAll = false;
  private lastMinute = -1;
  private els: { root: HTMLElement; strip: HTMLElement; cards: HTMLElement; kpi: HTMLElement; trail: HTMLElement; fid: HTMLElement; dq: HTMLElement; stock: HTMLElement; feed: HTMLElement; status: HTMLElement; views: HTMLElement };

  constructor(root: HTMLElement, private readonly host: LoopHost) {
    root.innerHTML = `
      <header class="lp-head">
        <div class="lp-title"><h2>${tr('闭环孪生')}</h2><span class="lp-sub">${tr('现场 → 感知数据 → 孪生估计和推演 → 建议和决策 → 指令 → 现场')}</span></div>
        <div class="seg lp-views" id="lp-views" role="group" aria-label="${tr('三维里显示什么')}">
          <button data-v="plan" aria-pressed="true" title="${tr('三维按仿真排的计划走')}">${tr('计划')}</button>
          <button data-v="closed" aria-pressed="false" title="${tr('三维按现场实际走（用孪生：建议按设置执行）')}">${tr('现场 · 用孪生')}</button>
          <button data-v="open" aria-pressed="false" title="${tr('同样的现场状况，没有孪生、谁也不管')}">${tr('现场 · 不用孪生')}</button>
        </div>
      </header>
      <p class="note lp-intro">${tr('数字孪生不是一段动画：现场的定位、车载终端、冷机温度、装车进度、门磁、收银和盘点、路况数据一分钟一分钟地进来，孪生用模型估计现场（每辆车晚了多少、货温、门店每个商品族还剩多少），往后推演，发现问题就列出做法、逐个推演结果、推荐一个；指令发回现场，现场的变化再回到孪生，模型也跟着校准。')}</p>
      <div class="lp-controls">
        <label>${tr('自动执行')} <select id="lp-policy">${(Object.keys(POLICY_LABEL) as Policy[]).map((p) => `<option value="${p}">${tx(POLICY_LABEL[p])}</option>`).join('')}</select></label>
        <label>${tr('现场状况')} <select id="lp-level">${(Object.keys(LEVEL_LABEL) as FieldLevel[]).map((l) => `<option value="${l}">${tx(LEVEL_LABEL[l])}</option>`).join('')}</select></label>
        <label>${tr('编号')} <input id="lp-seed" type="number" min="1" max="9999" value="1"></label>
        <label title="${tr('数据到孪生之前的通道：定位丢点、数据晚到、过隧道断线')}">${tr('通信质量')} <select id="lp-quality">${(Object.keys(QUALITY_LABEL) as DataQuality[]).map((k) => `<option value="${k}">${tx(QUALITY_LABEL[k])}</option>`).join('')}</select></label>
        <button class="ghost" id="lp-run">${tr('重新跑现场')}</button>
        <button class="ghost" id="lp-undo" title="${tr('撤销调度员在建议卡上做的所有决定')}">${tr('撤销我的决定')}</button>
        <span class="note" id="lp-status"></span>
      </div>
      <div class="lp-strip" id="lp-strip"></div>
      <div class="lp-grid">
        <section class="lp-cards"><h3>${tr('建议卡')} <small id="lp-cards-sub"></small></h3><div id="lp-cards"></div></section>
        <section class="lp-right">
          <h3>${tr('用孪生 / 不用孪生（同样的现场，到此刻）')}</h3><div id="lp-kpi"></div>
          <h3>${tr('指令跟踪')} <small>${tr('下发 → 现场回执 → 完成 → 效果')}</small></h3><ol class="lp-trail" id="lp-trail"></ol>
          <h3>${tr('孪生的保真度')}</h3><div id="lp-fid"></div>
          <h3>${tr('数据质量')} <small>${tr('丢点、晚到和孪生的补偿（全天）')}</small></h3><div id="lp-dq"></div>
          <h3>${tr('门店库存（孪生估计 / 实际）')}</h3><div id="lp-stock"></div>
          <h3>${tr('现场数据流')}</h3><ol class="lp-feed" id="lp-feed"></ol>
        </section>
      </div>`;
    const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.els = { root, strip: q('lp-strip'), cards: q('lp-cards'), kpi: q('lp-kpi'), trail: q('lp-trail'), fid: q('lp-fid'), dq: q('lp-dq'), stock: q('lp-stock'), feed: q('lp-feed'), status: q('lp-status'), views: q('lp-views') };
    q<HTMLSelectElement>('lp-policy').value = this.settings.policy;
    const apply = () => {
      this.settings = { policy: q<HTMLSelectElement>('lp-policy').value as Policy, level: q<HTMLSelectElement>('lp-level').value as FieldLevel, seed: Math.max(1, Math.min(9999, Math.round(Number(q<HTMLInputElement>('lp-seed').value) || 1))), quality: q<HTMLSelectElement>('lp-quality').value as DataQuality };
      this.host.onSettings(this.settings);
    };
    q<HTMLSelectElement>('lp-policy').onchange = apply;
    q<HTMLSelectElement>('lp-level').onchange = apply;
    q<HTMLSelectElement>('lp-quality').onchange = apply;
    q('lp-run').onclick = apply;
    q('lp-undo').onclick = () => this.host.onUndo();
    for (const b of this.els.views.querySelectorAll<HTMLButtonElement>('button[data-v]'))
      b.onclick = () => {
        this.view = b.dataset.v as LoopView;
        for (const x of this.els.views.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        this.host.onView(this.view);
      };
    this.els.cards.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el || !this.data) return;
      const key = el.dataset.key as string;
      if (el.dataset.act === 'jump') this.host.setTime(Number(el.dataset.t));
      else if (el.dataset.act === 'veh') this.host.onVehicle(Number(el.dataset.vid));
      else if (el.dataset.act === 'all') {
        this.showAll = !this.showAll;
        this.render(true);
      } else if (el.dataset.act === 'reject') this.host.onDecision({ t: this.decisionTime(), key, action: 'reject' });
      else if (el.dataset.act === 'do') this.host.onDecision({ t: this.decisionTime(), key, action: 'approve', option: el.dataset.opt as string });
    });
  }

  get current(): LoopSettings {
    return this.settings;
  }

  /** 值班助手里点「看建议卡」：卡片滚到眼前并闪一下（没显示出来的先展开全部） */
  focusCard(key: string): void {
    const find = () => [...this.els.cards.querySelectorAll<HTMLElement>('[data-card]')].find((x) => x.dataset.card === key);
    let el = find();
    if (!el && !this.showAll) {
      this.showAll = true;
      this.render(true);
      el = find();
    }
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1800);
  }

  /** 从外面切换三维显示（比如点「看车」时切到现场） */
  setView(v: LoopView): void {
    this.view = v;
    for (const x of this.els.views.querySelectorAll<HTMLButtonElement>('button[data-v]')) x.setAttribute('aria-pressed', String(x.dataset.v === v));
  }

  /** 决定在此刻之后的第一次「孪生想一想」（每 5 分钟）生效 */
  private decisionTime(): number {
    return Math.ceil(this.t / 300) * 300;
  }

  setBusy(text: string | undefined): void {
    this.els.status.textContent = text ?? '';
    this.els.root.classList.toggle('busy', !!text);
  }

  setData(d: LoopData | undefined): void {
    this.data = d;
    if (d) this.els.status.textContent = `${tr('现场一整天 × 2 遍，{ms} 秒 · 现场共发出 {n0} 条数据', { ms: (d.ms / 1000).toFixed(1), n0: n0(d.closed.msgCount) })}${d.decisions.length ? ` ${tr('· 你做了 {length} 个决定', { length: d.decisions.length })}` : ''}`;
    this.render(true);
  }

  setTime(t: number): void {
    this.t = t;
    const m = Math.floor(t / 60);
    if (m !== this.lastMinute) this.render(false);
  }

  private render(force: boolean): void {
    const d = this.data;
    this.lastMinute = Math.floor(this.t / 60);
    if (!d) {
      if (force) for (const el of [this.els.strip, this.els.cards, this.els.kpi, this.els.trail, this.els.fid, this.els.stock, this.els.feed]) el.innerHTML = '';
      return;
    }
    const t = this.t;
    const slot = Math.max(0, Math.min(d.closed.msgRate.length - 1, Math.floor(t / 300)));
    const statusAt = (r: Rec): Rec['status'] => (r.doneAt !== undefined && r.doneAt <= t ? r.status : 'proposed');
    const shown = d.closed.recs.filter((r) => r.t <= t);
    const open = shown.filter((r) => statusAt(r) === 'proposed');
    const doneN = shown.filter((r) => statusAt(r) === 'done').length;
    const cmds = d.closed.cmds.filter((c) => c.t <= t);
    const recv = d.closed.msgRate.slice(0, slot + 1).reduce((a, b) => a + b, 0);
    const rate = (d.closed.msgRate[slot] ?? 0) / 5;
    const at = (s: KpiPoint[]) => {
      let p: KpiPoint | undefined;
      for (const x of s) if (x.t <= t) p = x;
      return p;
    };
    const kc = at(d.closed.series);
    const ko = at(d.open.series);
    const eta = [...d.closed.fidelitySeries].reverse().find((x) => x.t <= t)?.eta;
    // 门店库存估计的误差（此刻、所有商品族）
    let err = 0;
    let base = 0;
    for (const v of d.closed.stocks.values()) {
      const e = v.est[slot] as number;
      const tr = v.truth[slot] as number;
      if (Number.isFinite(e) && Number.isFinite(tr)) {
        err += Math.abs(e - tr);
        base += Math.abs(tr);
      }
    }
    const step = (title: string, v: string, k: string) => `<div class="lp-step"><div class="k">${title}</div><div class="v">${v}</div><div class="s">${k}</div></div>`;
    this.els.strip.innerHTML = [
      step(tr('现场'), `${n0(kc?.late ?? 0)} / ${n0(kc?.hot ?? 0)} / ${n0(kc?.short ?? 0)}`, tr('迟到 / 超温 / 缺货（分钟）')),
      step(tr('感知数据'), n0(recv), tr('此刻每分钟约 {n0} 条', { n0: n0(rate) })),
      step(tr('孪生估计'), eta !== undefined && Number.isFinite(eta) ? tr('{n1} 分钟', { n1: n1(eta) }) : '—', tr('到店时间误差（提前一小时）· 库存误差 {v1}%', { v1: base > 0 ? n1((err / base) * 100) : '—' })),
      step(tr('推演和建议'), String(open.length), tr('待处理 · 今天共 {length} 张', { length: shown.length })),
      step(tr('决策'), String(doneN), tr('已执行（{policy}）', { policy: tx(POLICY_LABEL[this.settings.policy]) })),
      step(tr('指令'), String(cmds.length), cmds.length ? tr('最近：{cmdText}', { cmdText: esc(tx(cmdText(cmds[cmds.length - 1]!, d.labelOf))) }) : tr('还没发过')),
    ].join('<span class="lp-arrow" aria-hidden="true">→</span>');

    // 建议卡：最新的在上面
    const list = [...shown].sort((a, b) => b.t - a.t);
    const max = this.showAll ? list.length : 6;
    (this.els.root.querySelector('#lp-cards-sub') as HTMLElement).textContent = shown.length ? tr('到此刻 {length} 张，待处理 {length2} 张', { length: shown.length, length2: open.length }) : tr('到此刻还没有');
    this.els.cards.innerHTML = list.length
      ? list
          .slice(0, max)
          .map((r) => this.cardHtml(r, statusAt(r), d))
          .join('') + (list.length > 6 ? `<button class="chip" data-act="all">${this.showAll ? tr('只看最近 6 张') : tr('显示全部 {length} 张', { length: list.length })}</button>` : '')
      : `<p class="note">${tr('孪生还没发现要处理的问题。拖动时间轴或播放，看现场的数据进来以后孪生怎么判断。')}</p>`;

    // 用孪生 / 不用孪生
    const row = (label: string, a: number, b: number, unit: string, digits = 0) => {
      const diff = a - b;
      const cls = Math.abs(diff) < 0.5 ? '' : diff < 0 ? 'good' : 'bad';
      return `<tr><td>${label}</td><td class="num">${digits ? n1(a) : n0(a)}</td><td class="num">${digits ? n1(b) : n0(b)}</td><td class="num delta ${cls}">${Math.abs(diff) < 0.5 ? '—' : `${diff > 0 ? '+' : '−'}${digits ? n1(Math.abs(diff)) : n0(Math.abs(diff))}`}</td><td class="unit">${unit}</td></tr>`;
    };
    this.els.kpi.innerHTML = `<div class="table-wrap"><table class="lp-table"><thead><tr><th></th><th>${tr('用孪生')}</th><th>${tr('不用')}</th><th>${tr('差')}</th><th></th></tr></thead><tbody>${[
      row(tr('迟到'), kc?.late ?? 0, ko?.late ?? 0, tr('分钟')),
      row(tr('货温超标'), kc?.hot ?? 0, ko?.hot ?? 0, tr('分钟')),
      row(tr('门店缺货'), kc?.short ?? 0, ko?.short ?? 0, tr('分钟（按商品族累计）')),
      row(tr('等月台门'), kc?.door ?? 0, ko?.door ?? 0, tr('分钟')),
      row(tr('等门店收货口'), kc?.dock ?? 0, ko?.dock ?? 0, tr('分钟')),
      row(tr('多花的钱'), kc?.cost ?? 0, ko?.cost ?? 0, tr('美元')),
      row(tr('合计'), score(kc), score(ko), tr('分（迟到 + 超温 × 2 + 缺货 × 1.5 + 钱 ÷ 12）')),
    ].join('')}</tbody></table></div>${sparkline(d.closed.series, d.open.series, t)}`;

    // 指令跟踪：最新的在上面，还没走完的标出来
    const trail = commandTrail(d.closed, t, d.labelOf).reverse().slice(0, 8);
    const step2 = (cls: string, text: string) => `<span class="${cls}">${text}</span>`;
    this.els.trail.innerHTML = trail.length
      ? trail
          .map((x) => {
            const steps = [step2('ok', tr('下发 {t}（{by}）', { t: clock(x.t), by: esc(tx(x.by)) }))];
            if (x.kind !== 'setpoint' && x.kind !== 'reassignDoor') steps.push(x.ack ? step2('ok', tr('回执 {t}「{text}」', { t: clock(x.ack.t), text: esc(tx(x.ack.text)) })) : step2('wait', tr('等回执')));
            if (x.kind === 'rescue' || x.kind === 'driverCheck') steps.push(x.done ? step2('ok', tr('完成 {t}「{text}」', { t: clock(x.done.t), text: esc(tx(x.done.text)) })) : step2('wait', tr('等完成')));
            steps.push(x.effect ? step2('ok', tr('效果：{effect}', { effect: esc(tx(x.effect)) })) : step2('wait', tr('效果要等现场的结果')));
            return `<li class="${x.closed ? 'closed' : ''}"><b>${esc(tx(x.text))}</b>${x.card ? `<small>${isEn() ? ` (${esc(tx(x.card))})` : `（${esc(x.card)}）`}</small>` : ''}<div class="lp-steps">${steps.join('<i aria-hidden="true">→</i>')}</div></li>`;
          })
          .join('')
      : `<li class="note">${tr('到此刻还没有发过指令。')}</li>`;

    // 保真度
    const f = d.closed.fidelity;
    const bias = d.closed.bias.slice(0, 24);
    const bmax = Math.max(0.05, ...bias.map((x) => Math.abs(x)));
    this.els.fid.innerHTML = `<div class="lp-fid">
        <div><b>${n1(f.eta30)}</b> / <b>${n1(f.eta60)}</b> / <b>${n1(f.eta120)}</b> ${tr('分钟')}<small>${tr('到店时间的平均误差（提前半小时 / 一小时 / 两小时预测，全天 {n0} 次）', { n0: n0(f.n) })}</small></div>
        <div><b>${f.temp.toFixed(2)}</b> °C<small>${tr('货温：孪生用自己的模型推 5 分钟，和读数比')}</small></div>
      </div>
      <div class="lp-bias" title="${tr('持续校准：每跑完一程，实际比计划多花的比例记到那个小时')}">${bias.map((x, h) => `<span style="--h:${Math.round((Math.abs(x) / bmax) * 100)}%" class="${x < 0 ? 'neg' : ''}" title="${tr('{h} 点：比计划慢 {x}%', { h, x: (x * 100).toFixed(0) })}"></span>`).join('')}</div>
      <small class="note">${tr('每小时学到的「实际比计划慢多少」（持续校准：从跑完的每一程学，推演到店时间时按小时加上）')}</small>`;

    // 数据质量：丢了多少、晚到多少、孪生怎么补偿
    const dq = d.closed.quality;
    this.els.dq.innerHTML = dq
      ? `<ul class="lp-dq">
          <li>${tr('现场发出')} <b>${n0(dq.sent)}</b> ${tr('条，送到孪生')} <b>${n0(dq.delivered)}</b> ${tr('条；丢了')} <b>${n0(dq.dropped)}</b> ${tr('条（{n1}%，其中断线丢的定位 {n0} 条）', { n1: n1((dq.dropped / Math.max(1, dq.sent)) * 100), n0: n0(dq.blackout) })}</li>
          <li>${tr('晚到')} <b>${n0(dq.late)}</b> ${tr('条，平均晚 {n0} 秒；晚到的车载终端事件、门磁按发生的时刻补记 {n02} 条；比已经收到的还旧、没用上的定位 {n03} 条', { n0: n0(dq.lateSec), n02: n0(dq.eventsLate), n03: n0(dq.stale) })}</li>
          <li>${tr('最长的定位断点：')}${dq.maxGapVid >= 0 ? tr('{labelOf} {n0} 分钟没有定位', { labelOf: esc(d.labelOf(dq.maxGapVid)), n0: n0(dq.maxGap) }) : tr('没有')}</li>
          <li>${tr('补偿：孪生按计划和最后知道的延误推算位置')} <b>${n0(dq.reckoned)}</b> ${tr('次（车 · 5 分钟，在路上超过 3 分钟没收到定位）')}</li>
        </ul><small class="note">${tr('通信质量「{quality}」。上面的保真度就是在这样的数据下的估计误差，可以和「良好」比。', { quality: tx(QUALITY_LABEL[dq.level]) })}</small>`
      : `<p class="note">${tr('通信良好：数据原样送到孪生。把上面的「通信质量」改成一般或较差，可以看丢点、晚到、断线时孪生怎么补偿，估计误差（保真度）变化多少。')}</p>`;

    // 门店库存：按「还够卖几小时」从少到多
    const rows = FAMILIES.map((fam) => {
      const v = d.closed.stocks.get(fam.key);
      const e = (v?.est[slot] as number) ?? NaN;
      const tr = (v?.truth[slot] as number) ?? NaN;
      return { fam, e, tr };
    })
      .filter((x) => Number.isFinite(x.tr))
      .sort((a, b) => a.tr - b.tr)
      .slice(0, 8);
    const top = Math.max(1, ...rows.map((x) => Math.max(x.e || 0, x.tr || 0)));
    this.els.stock.innerHTML = rows
      .map((x) => `<div class="lp-st${x.tr <= 0.5 ? ' out' : ''}"><span class="lbl" title="${esc(tx(x.fam.label))}">${esc(tx(x.fam.label))}</span><span class="bar"><i class="tr" style="width:${(Math.max(0, x.tr) / top) * 100}%"></i><i class="es" style="left:${(Math.max(0, x.e) / top) * 100}%"></i></span><span class="num">${n0(x.e)} / ${n0(x.tr)}</span></div>`)
      .join('') + `<small class="note">${tr('库存最少的 8 个商品族；条是实际，竖线是孪生的估计（收银每 15 分钟减、盘点每小时校正、到货时加）')}</small>`;

    // 现场数据流：此刻之前最近的事件（定位、收银太多，只计数）
    const recent: Msg[] = [];
    let gps = 0;
    let pos = 0;
    for (let i = d.closed.msgs.length - 1; i >= 0 && recent.length < 12; i--) {
      const m = d.closed.msgs[i] as Msg;
      if (m.t > t) continue;
      if (m.kind === 'gps') {
        gps++;
        continue;
      }
      if (m.kind === 'pos') {
        pos++;
        continue;
      }
      if (m.kind === 'stock' && recent.some((x) => x.kind === 'stock' && x.t === m.t)) continue;
      // 冷机读数只列不正常的（货温离上限不到 1 度、车厢比设定高 3 度以上）
      if (m.kind === 'temp' && m.product < (m.set < -5 ? -16 : 4) && m.air < m.set + 3) {
        pos++;
        continue;
      }
      recent.push(m);
    }
    this.els.feed.innerHTML = recent.map((m) => `<li><span class="mono">${clock(m.t)}</span> <span class="lp-k k-${m.kind}">${KIND[m.kind]}</span> ${esc(msgText(m, d.labelOf))}</li>`).join('') + `<li class="note">${tr('（定位每辆车每分钟一条、收银每 15 分钟每个商品族一条、正常的冷机读数每 5 分钟一条，这里不逐条列出）')}</li>`;
    void force;
  }

  private cardHtml(r: Rec, st: Rec['status'], d: LoopData): string {
    const best = r.options[r.best];
    const live = st === 'proposed';
    const mine = d.decisions.find((x) => x.key === r.key);
    const opts = r.options
      .map((o, i) => {
        const chosen = st === 'done' && r.chosen === o.key;
        const rec = i === r.best;
        return `<tr class="${rec ? 'rec' : ''}${chosen ? ' chosen' : ''}"><td>${esc(tx(o.label))}${rec ? `<span class="lp-tag">${tr('推荐')}</span>` : ''}${o.auto && o.cmds.length ? `<span class="lp-tag lo">${tr('低风险')}</span>` : ''}<small>${esc(tx(o.note))}</small></td><td class="num">${n0(o.late)}</td><td class="num">${n0(o.hot)}</td><td class="num">${n0(o.short)}</td><td class="num">${n0(o.cost)}</td><td class="num"><b>${n0(sumScore(o))}</b></td><td>${live && o.cmds.length ? `<button class="chip" data-act="do" data-key="${esc(r.key)}" data-opt="${esc(o.key)}">${tr('执行')}</button>` : ''}</td></tr>`;
      })
      .join('');
    const by = st === 'done' ? `${r.by === 'user' ? tr('调度员') : tr('自动')}${isEn() ? ' ' : ''}${tr('在 {doneAt} 执行了「{label}」', { doneAt: clock(r.doneAt ?? r.t), label: esc(tx(r.options.find((o) => o.key === r.chosen)?.label ?? r.chosen ?? '')) })}` : st === 'rejected' ? tr('调度员在 {doneAt} 否了', { doneAt: clock(r.doneAt ?? r.t) }) : st === 'resolved' ? `${clock(r.doneAt ?? r.t)} ${tr('不再预测到这个问题')}` : st === 'expired' ? `${clock(r.doneAt ?? r.t)}${tr('：没处理，问题真的发生了')}` : r.interim ? tr('先自动做了「{label}」，推荐的做法等你批准', { label: esc(tx(r.options.find((o) => o.key === r.interim?.key)?.label ?? '')) }) : best && !best.cmds.length ? tr('推荐不处理（处理的代价比问题大）') : tr('等调度员决定');
    return `<article class="lp-card st-${st}" data-card="${esc(r.key)}">
      <header><span class="lp-kind k-${r.kind}">${tx(ISSUE_LABEL[r.kind])}</span><b>${esc(tx(r.title))}</b><button class="link mono" data-act="jump" data-t="${r.t}" title="${tr('跳到孪生提出这条建议的时刻')}">${clock(r.t)}</button>${r.vid !== undefined ? `<button class="link" data-act="veh" data-vid="${r.vid}">${tr('看车')}</button>` : ''}<span class="lp-st-chip">${STATUS[st]}${mine ? tr('（你的决定）') : ''}</span></header>
      <p>${esc(tx(r.text))}</p>
      <div class="table-wrap"><table class="lp-opts"><thead><tr><th>${tr('做法（孪生逐个推演的结果）')}</th><th>${tr('迟到')}</th><th>${tr('超温')}</th><th>${tr('缺货')}</th><th>${tr('花费')}</th><th>${tr('合计')}</th><th></th></tr></thead><tbody>${opts}</tbody></table></div>
      <footer>${by}${live ? ` <button class="chip" data-act="reject" data-key="${esc(r.key)}">${tr('否决')}</button>` : ''}</footer>
    </article>`;
  }
}

const KIND: Record<Msg['kind'], string> = { gps: tr('定位'), event: tr('车载'), temp: tr('冷机'), load: tr('装车'), door: tr('门磁'), pos: tr('收银'), stock: tr('盘点'), traffic: tr('路况'), soc: tr('电量') };
const EV: Record<string, string> = { depart: tr('出发'), arrive: tr('到达'), leave: tr('卸完离开'), fault: tr('故障'), fixed: tr('修好'), ack: tr('收到指令'), done: tr('处理完'), eta: tr('预计到达') };

function msgText(m: Msg, labelOf: (vid: number) => string): string {
  switch (m.kind) {
    case 'gps':
      return tr('{labelOf} 定位', { labelOf: labelOf(m.vid) });
    case 'event':
      return m.vid < 0 ? `${tx(m.place ?? '')} ${tx(m.note ?? '')}` : `${labelOf(m.vid)} ${EV[m.ev] ?? m.ev}${m.place ? ` · ${tx(m.place)}` : ''}${m.note ? ` · ${tx(m.note)}` : ''}`;
    case 'temp':
      return tr('{labelOf} 车厢 {air} °C、货 {product} °C（设定 {set} °C{v5}）', { labelOf: labelOf(m.vid), air: m.air.toFixed(1), product: m.product.toFixed(1), set: m.set.toFixed(0), v5: m.door ? tr('，开着门') : '' });
    case 'load':
      return tr('{door} {labelOf} 装车 {done}/{total} 托', { door: m.door, labelOf: labelOf(m.vid), done: m.done, total: m.total });
    case 'door':
      return `${m.door} ${m.open ? tr('靠上') : tr('离开')}：${labelOf(m.vid)}`;
    case 'pos':
      return tr('{famLabel} 15 分钟卖 {n0} 件', { famLabel: tx(famLabel(m.fam)), n0: n0(m.units) });
    case 'stock':
      return tr('门店盘点（每小时，{length} 个商品族）', { length: FAMILIES.length });
    case 'traffic':
      return m.end ? tx(m.text) : tr('{text}（车速约降到 {v2}%，预计到 {until}）', { text: tx(m.text), v2: Math.round(100 / m.factor), until: clock(m.until) });
    case 'soc':
      return tr('{labelOf} 电量 {soc}%', { labelOf: labelOf(m.vid), soc: Math.round(m.soc * 100) });
  }
}

/** 全天的合计分（迟到 + 超温 × 2 + 缺货 × 1.5 + 钱 ÷ 12）：用孪生、不用孪生两条线，竖线是此刻 */
function sparkline(a: KpiPoint[], b: KpiPoint[], t: number): string {
  const W = 320;
  const H = 86;
  const end = 24 * 3600;
  const ymax = Math.max(10, score(a[a.length - 1]), score(b[b.length - 1])) * 1.08;
  const path = (s: KpiPoint[]) => s.filter((p) => p.t <= end).map((p, i) => `${i ? 'L' : 'M'}${((p.t / end) * W).toFixed(1)},${(H - 14 - (score(p) / ymax) * (H - 22)).toFixed(1)}`).join('');
  const x = (t / end) * W;
  return `<figure class="lp-spark"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${tr('全天的合计分：用孪生和不用孪生')}"><path d="${path(b)}" class="open"/><path d="${path(a)}" class="closed"/><line x1="${x}" x2="${x}" y1="4" y2="${H - 12}" class="now"/>${[0, 6, 12, 18, 24].map((h) => `<text x="${(h / 24) * W}" y="${H - 1}" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${h}</text>`).join('')}</svg><figcaption><span class="sw closed"></span>${tr('用孪生')} <span class="sw open"></span>${tr('不用孪生 · 全天合计分（越低越好）')}</figcaption></figure>`;
}
