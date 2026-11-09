import { currentRegion, STORES } from '../../src/region/network';
import { RAIL } from '../../src/region/region';
import { DIR_LABEL, dirOf } from '../../src/region/regionGen';
import { applyFix, autoFix, DOORS, RECEIVING_DOORS, UNIT_LABEL, UNIT_PREFIX, unitClass, type Board, type BoardOp, type DayKpi, type Issue, type UnitClass } from '../../src/sim/board';
import { hhmm as hhmmZh, ZONE_LABEL, type DayPlan, type StandingPlan, type Zone } from '../../src/sim/plan';
import type { OpKind, OpStop } from '../../src/sim/trace';
import { sharePlan, SolvePanel } from './solvePanel';
import { t as tr, tx, isEn } from './i18n';

/**
 * 调度台：在孪生里查看和安排当天的全部作业。
 *
 * - 甘特图：港口泊位和铁路、航班、供应商和区域生鲜进货、配送中心的每樘月台门、配送车队的每辆车、门店收货口、线上配送，
 *   一行一个资源，时间轴和三维的时钟同步；点一下选中（三维里高亮、跟随），拖动就是改计划：
 *   左右拖改时刻（配送车次的出发、供应商的到达、班轮 / 航班 / 班列的时刻），上下拖到别的门、别的车上就是改派；
 * - 作业清单：按时间排的全部作业，可以按类型、状态筛、搜；
 * - 问题：月台门冲突、车辆没回来、迟到、门外等、高峰、赶不上分配、门店收货口不够，能修的一键修，也可以全部自动排；
 * - 常规计划：出车时段、门店收货时段、供应商预约、区域生鲜集货、航班、船期、铁路班列，改了重新仿真 18 周，和原计划比；
 * - 求解：排门、派车、门店补货的优化解，和现在的排法比，说明改了什么，门和车可以一键采用（solvePanel.ts）。
 */
export interface DispatchHost {
  setTime(t: number): void;
  /** 选中一个作业（三维里高亮它的车、画路线）；focus = 镜头飞过去 */
  onSelect(op: BoardOp | undefined, focus: boolean): void;
  /** 当天调度变了：只改门和车不用重新仿真，改时刻要 */
  onDay(day: DayPlan, rerun: boolean): void;
  /** 常规计划变了（要重新仿真） */
  onStanding(p: StandingPlan): void;
}

export interface CompareRow {
  label: string;
  unit: string;
  digits: number;
  base: number;
  plan: number;
  better: 'lower' | 'higher' | 'none';
}
export interface DispatchData {
  board: Board;
  day: DayPlan;
  standing: StandingPlan;
  defaults: StandingPlan;
  /** 原计划（没改任何东西）的当天指标；计划改过时显示变化 */
  baseKpi?: DayKpi;
  /** 改过常规计划时：18 周平均的对比 */
  compare?: CompareRow[];
  /** 最早几点能发车、门店默认的收货时段说明 */
  earliest: number;
  receiveNote: string;
  receiveFrom: number;
  genLabel: string;
  dayNo: number;
  /** 分配库存的时刻（当天的小时，配送车之前不能装车）；不给就按最早发车推 */
  allocation?: number;
  /** 门店每个商品族每天的需求（件，补货求解用）；不给就按当天送到门店的量估 */
  storeDemand?: Record<string, number>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
/** 钟点：英文界面把「前日」「次日」换成英文（中文原样） */
const hhmm = (h: number): string => (isEn() ? hhmmZh(h).replace('次日 ', 'next day ').replace('前日 ', 'prev. day ') : hhmmZh(h));
const hm = (s: number) => hhmm(s / 3600);
const toInput = (h: number) => {
  const m = Math.round(h * 60);
  const r = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
};
const fromInput = (v: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) + Number(m[2]) / 60 : undefined;
};
const WEEK = [tr('周一'), tr('周二'), tr('周三'), tr('周四'), tr('周五'), tr('周六'), tr('周日')];
const KIND_LABEL: Record<OpKind, string> = { delivery: tr('门店配送'), bakery: tr('面包直送'), supplier: tr('长途进仓'), direct: tr('长途直送门店'), farm: tr('区域生鲜集货'), airTruck: tr('空运冷藏车'), drayage: tr('集装箱提箱'), rail: tr('港口铁路接驳'), train: tr('洲际班列'), vessel: tr('班轮靠泊'), flight: tr('货运航班'), van: tr('线上配送') };
const FILTERS: { key: string; label: string; kinds: OpKind[] }[] = [
  { key: 'out', label: tr('门店配送'), kinds: ['delivery', 'bakery'] },
  { key: 'in', label: tr('进货'), kinds: ['supplier', 'direct', 'farm', 'airTruck'] },
  { key: 'port', label: tr('港口铁路'), kinds: ['drayage', 'rail', 'train', 'vessel'] },
  { key: 'air', label: tr('航班'), kinds: ['flight'] },
  { key: 'van', label: tr('线上配送'), kinds: ['van'] },
];

export function opColor(o: BoardOp): string {
  switch (o.kind) {
    case 'delivery':
      return o.ev ? '#1baf7a' : o.zone === 'ambient' ? '#2a78d6' : o.zone === 'multi' ? '#3f8fd0' : o.zone === 'frozen' ? '#5b7fd0' : '#4fa3dc';
    case 'bakery':
      return '#c98a2e';
    case 'supplier':
      return '#6f7f97';
    case 'direct':
      return '#8a6d3b';
    case 'farm':
      return '#5f8f43';
    case 'airTruck':
      return '#a88a2a';
    case 'drayage':
      return '#c75400';
    case 'rail':
      return '#6d6b66';
    case 'train':
      return '#4f4a43';
    case 'vessel':
      return '#2c3e50';
    case 'flight':
      return '#857f72';
    case 'van':
      return '#8c6cba';
  }
}

/** 作业的简称：配送车次「多温区 03」、进货「供应商 · 常温食品」等 */
export function opName(o: BoardOp): string {
  switch (o.kind) {
    case 'delivery':
    case 'bakery':
      return `${tx(ZONE_LABEL[(o.zone as Zone | 'bakery') ?? 'multi'] ?? '')} ${o.id.slice(1)}${o.ev ? ` ${tr('· 电动')}` : ''}`;
    case 'supplier':
    case 'direct':
    case 'drayage':
      return tx(o.label.split(' · ')[1] ?? KIND_LABEL[o.kind]);
    case 'farm':
    case 'airTruck':
      return `${Math.round(o.pallets ?? 0)} ${tr('托')}`;
    case 'rail':
    case 'train':
      return `${/(\d+) 箱/.exec(o.label)?.[1] ?? ''} ${tr('个自己的箱')}`;
    case 'vessel':
      return o.id === 'VS0' ? tr('在锚地等泊位') : tr('本周班轮');
    case 'flight':
      return tx(/（(.*)）/.exec(o.label)?.[1] ?? '') || tr('货运航班');
    case 'van':
      return tx(o.label.replace('线上配送车', ''));
  }
}

type Role = 'trip' | 'door' | 'stop' | 'span';
interface Item {
  op: BoardOp;
  t0: number;
  t1: number;
  role: Role;
  label: string;
  /** 条里面的分段：装车 / 路上 / 门外等 / 卸货 / 回程 / 在港 */
  blocks: { t0: number; t1: number; cls: string }[];
  stop?: OpStop;
}
interface Lane {
  id: string;
  label: string;
  sub?: string;
  items: Item[];
  /** 拖到这一行上算改派：月台门、车辆 */
  drop?: { kind: 'door'; group: 'cold' | 'dry'; id: string } | { kind: 'unit'; cls: UnitClass; id: string };
  /** 门店的收货时段（画成浅色底） */
  window?: [number, number];
}
interface Group {
  id: string;
  label: string;
  lanes: Lane[];
  open: boolean;
}

/** 资源名那一列的宽度（窄屏窄一些） */
const narrow = () => typeof window !== 'undefined' && window.innerWidth < 700;
// 资源列宽：英文名字长，加宽一些（中文不变）
const labelW = () => (narrow() ? (isEn() ? 116 : 96) : isEn() ? 180 : 132);
let LABEL_W = labelW();

export class Dispatch {
  private data: DispatchData | undefined;
  private selected: string | undefined;
  private time = 0;
  private zoom = narrow() ? 12 : 24;
  private tab = 'gantt';
  private filter = new Set<string>(FILTERS.map((f) => f.key));
  private status = 'all';
  private query = '';
  private openGroups = new Map<string, boolean>([['port', true], ['air', true], ['inbound', true], ['cold', true], ['dry', false], ['fleet', true], ['stores', false], ['vans', false]]);
  private groups: Group[] = [];
  private pxh = 40;
  private drag: { op: BoardOp; role: Role; lane: string; x0: number; y0: number; el: HTMLElement; moved: boolean; ghost?: HTMLElement } | undefined;
  private els: { root: HTMLElement; kpis: HTMLElement; sub: HTMLElement; tabs: HTMLElement; gantt: HTMLElement; list: HTMLElement; issues: HTMLElement; plan: HTMLElement; card: HTMLElement; badge: HTMLElement; tip: HTMLElement };
  private readonly solver: SolvePanel;

  constructor(root: HTMLElement, card: HTMLElement, private readonly host: DispatchHost) {
    root.innerHTML = `
      <header class="dp-head">
        <div class="dp-title"><h2>${tr('调度台')}</h2><span class="dp-sub" id="dp-sub"></span></div>
        <div class="dp-actions">
          <button class="ghost" id="dp-auto" title="${tr('把能自动修的问题都修掉：月台门冲突改门、车辆冲突改派、迟到的车次提前出发')}">${tr('自动排程')}</button>
          <button class="ghost" id="dp-reset" title="${tr('撤销当天的所有改动（月台门、车辆、出发和到达时刻）')}">${tr('撤销当天改动')}</button>
        </div>
      </header>
      <div class="dp-kpis" id="dp-kpis"></div>
      <div class="dp-tabs" role="tablist" id="dp-tabs">
        <button role="tab" data-dp="gantt" aria-selected="true">${tr('甘特图')}</button>
        <button role="tab" data-dp="list" aria-selected="false">${tr('作业清单')}</button>
        <button role="tab" data-dp="issues" aria-selected="false">${tr('问题')} <span class="dp-badge" id="dp-badge"></span></button>
        <button role="tab" data-dp="plan" aria-selected="false">${tr('常规计划')}</button>
        <button role="tab" data-dp="curves" aria-selected="false">${tr('当天曲线')}</button>
        <button role="tab" data-dp="solve" aria-selected="false" title="${tr('排门、派车、门店补货的优化解：和现在的排法比，说明改了什么')}">${tr('求解')}</button>
        <label class="dp-zoom">${tr('时间轴')} <select id="dp-zoom"><option value="24">${tr('24 小时')}</option><option value="12">${tr('12 小时')}</option><option value="6">${tr('6 小时')}</option><option value="2">${tr('2 小时')}</option></select></label>
      </div>
      <div class="dp-pane" id="dp-gantt"></div>
      <div class="dp-pane" id="dp-list" hidden></div>
      <div class="dp-pane" id="dp-issues" hidden></div>
      <div class="dp-pane" id="dp-plan" hidden></div>
      <div class="dp-pane" id="dp-solve" hidden></div>
      <div class="dp-tip" id="dp-tip" hidden></div>`;
    const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.els = { root, kpis: q('dp-kpis'), sub: q('dp-sub'), tabs: q('dp-tabs'), gantt: q('dp-gantt'), list: q('dp-list'), issues: q('dp-issues'), plan: q('dp-plan'), card, badge: q('dp-badge'), tip: q('dp-tip') };
    this.solver = new SolvePanel(q('dp-solve'), { onDay: (day, rerun) => this.host.onDay(day, rerun) });
    for (const b of this.els.tabs.querySelectorAll<HTMLButtonElement>('button[data-dp]')) b.onclick = () => this.setTab(b.dataset.dp as string);
    q<HTMLSelectElement>('dp-zoom').value = String(this.zoom);
    q<HTMLSelectElement>('dp-zoom').onchange = (e) => {
      this.zoom = Number((e.target as HTMLSelectElement).value);
      this.renderGantt(true);
    };
    q('dp-auto').onclick = () => this.auto();
    q('dp-reset').onclick = () => {
      if (!this.data) return;
      this.host.onDay({ depart: {}, arrive: {}, door: {}, unit: {} }, Object.keys(this.data.day.depart).length + Object.keys(this.data.day.arrive).length > 0);
    };
    this.bindGantt();
    new ResizeObserver(() => this.renderGantt(false)).observe(this.els.gantt);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.selected) this.select(undefined, false);
    });
  }

  /** 「当天曲线」页放仿真的小时曲线（由外面提供的容器） */
  attachCurves(el: HTMLElement): void {
    const pane = document.createElement('div');
    pane.className = 'dp-pane';
    pane.id = 'dp-curves';
    pane.hidden = true;
    pane.append(el);
    this.els.root.append(pane);
  }

  setData(d: DispatchData): void {
    this.data = d;
    const shared = { board: d.board, day: d.day, genLabel: d.genLabel, earliest: d.earliest, ...(d.allocation !== undefined ? { allocation: d.allocation } : {}), ...(d.storeDemand ? { storeDemand: d.storeDemand } : {}) };
    sharePlan(shared);
    this.solver.setPlan(shared);
    if (this.selected && !d.board.byId.has(this.selected)) this.selected = undefined;
    this.groups = this.buildGroups(d.board);
    this.renderKpis();
    this.renderGantt(false);
    this.renderList();
    this.renderIssues();
    this.renderPlan();
    this.renderCard();
  }

  setTime(t: number): void {
    this.time = t;
    const now = this.els.gantt.querySelector<HTMLElement>('.gt-now');
    if (now) now.style.left = `${LABEL_W + (t / 3600) * this.pxh}px`;
    const clock = this.els.gantt.querySelector<HTMLElement>('.gt-now-label');
    if (clock) clock.textContent = hm(t);
  }

  /** 选中作业（来自调度台或三维里点车） */
  select(id: string | undefined, focus: boolean, fromView = false): void {
    this.selected = id;
    for (const el of this.els.root.querySelectorAll('.sel')) el.classList.remove('sel');
    if (id) for (const el of this.els.root.querySelectorAll(`[data-op="${CSS.escape(id)}"]`)) el.classList.add('sel');
    this.renderCard();
    const op = id ? this.data?.board.byId.get(id) : undefined;
    if (!fromView) this.host.onSelect(op, focus);
    if (op && fromView) this.scrollTo(op);
  }

  selectByVehicle(vehicle: number): void {
    const op = this.data?.board.ops.find((o) => o.vehicle === vehicle);
    if (op) this.select(op.id, false, true);
  }

  private setTab(tab: string): void {
    this.tab = tab;
    for (const b of this.els.tabs.querySelectorAll<HTMLButtonElement>('button[data-dp]')) b.setAttribute('aria-selected', String(b.dataset.dp === tab));
    for (const p of this.els.root.querySelectorAll<HTMLElement>('.dp-pane')) p.hidden = p.id !== `dp-${tab}`;
    (this.els.tabs.querySelector('.dp-zoom') as HTMLElement).hidden = tab !== 'gantt';
    if (tab === 'gantt') this.renderGantt(true);
    this.solver.show(tab === 'solve');
  }

  // ———————————————————————— 指标 ————————————————————————

  private renderKpis(): void {
    const d = this.data as DispatchData;
    const k = d.board.kpi;
    const b = d.baseKpi;
    const delta = (v: number, base: number | undefined, better: 'lower' | 'higher', digits = 0) => {
      if (base === undefined || Math.abs(v - base) < 10 ** -digits / 2) return '';
      const good = (v < base) === (better === 'lower');
      return `<span class="dp-delta ${good ? 'good' : 'bad'}">${v > base ? '+' : '−'}${Math.abs(v - base).toFixed(digits)}</span>`;
    };
    const pct = k.stops ? (k.onTime / k.stops) * 100 : 100;
    const bpct = b ? (b.stops ? (b.onTime / b.stops) * 100 : 100) : undefined;
    const tiles: [string, string, string][] = [
      [`${k.ops}`, tr('作业'), tr('其中配送 {trips} 趟、到店 {stops} 站', { trips: k.trips, stops: k.stops })],
      [`${pct.toFixed(1)}%`, tr('到店准点') + delta(pct, bpct, 'higher', 1), tr('{onTime} / {stops} 站在收货截止前开始卸货', { onTime: k.onTime, stops: k.stops })],
      [`${k.late}`, tr('迟到') + delta(k.late, b?.late, 'lower'), tr('合计晚 {lateMin} 分钟', { lateMin: Math.round(k.lateMin) })],
      [`${Math.round(k.waitMin)}`, tr('门外等（分钟）') + delta(k.waitMin, b?.waitMin, 'lower'), tr('到了门店还没到收货时间，在门外等的合计')],
      [`${k.units}`, tr('用车') + delta(k.units, b?.units, 'lower'), Object.entries(k.unitsBy).map(([c, n]) => `${tx(UNIT_LABEL[c as UnitClass])} ${n}`).join(isEn() ? ', ' : '、')],
      [`${k.doorPeak.cold}/${DOORS.cold.length} · ${k.doorPeak.dry}/${DOORS.dry.length}`, tr('月台门峰值（冷链 · 干货）'), tr('全天占用 {cold}% · {dry}%', { cold: (k.doorUse.cold * 100).toFixed(0), dry: (k.doorUse.dry * 100).toFixed(0) })],
      [`${k.errors} · ${k.warns}`, tr('问题（要处理 · 提醒）'), tr('点「问题」看详情和修法')],
    ];
    this.els.kpis.innerHTML = tiles.map(([v, label, title]) => `<div class="dp-kpi" title="${esc(title)}"><div class="v">${esc(v)}</div><div class="k">${label}</div></div>`).join('');
    this.els.badge.textContent = k.errors ? String(k.errors) : k.warns ? String(k.warns) : '';
    this.els.badge.className = `dp-badge ${k.errors ? 'err' : k.warns ? 'warn' : ''}`;
    const moved = d.board.ops.filter((o) => o.moved).length;
    this.els.sub.textContent = `${tr('{genLabel} · 第 {dayNo} 天 · {ops} 个作业', { genLabel: d.genLabel, dayNo: d.dayNo, ops: k.ops })}${moved ? ` ${tr('· 当天改了 {moved} 个', { moved })}` : ''}`;
  }

  // ———————————————————————— 甘特图 ————————————————————————

  private buildGroups(b: Board): Group[] {
    const packed = (ops: BoardOp[], label: string, item: (o: BoardOp) => Item): Lane[] => {
      const rows: { end: number; items: Item[] }[] = [];
      for (const o of [...ops].sort((x, y) => x.t0 - y.t0)) {
        const it = item(o);
        let row = rows.find((r) => r.end + 120 <= it.t0);
        if (!row) {
          row = { end: -Infinity, items: [] };
          rows.push(row);
        }
        row.items.push(it);
        row.end = it.t1;
      }
      return rows.map((r, i) => ({ id: `${label}-${i}`, label: rows.length > 1 ? `${label} ${i + 1}` : label, items: r.items }));
    };
    const span = (o: BoardOp): Item => {
      const blocks: Item['blocks'] = [];
      if (o.kind === 'vessel' && o.dock) blocks.push({ t0: o.t0, t1: o.dock[0], cls: 'drive' }, { t0: o.dock[0], t1: o.dock[1], cls: 'berth' }, { t0: o.dock[1], t1: o.t1, cls: 'drive' });
      else if (o.kind === 'flight' && o.dock) blocks.push({ t0: o.t0, t1: o.dock[0], cls: 'drive' }, { t0: o.dock[0], t1: o.dock[1], cls: 'berth' }, { t0: o.dock[1], t1: o.t1, cls: 'drive' });
      else if (o.dockAt) blocks.push({ t0: o.t0, t1: o.arrive ?? o.dockAt[0], cls: 'drive' }, ...(o.yardWait ? [{ t0: o.dockAt[0] - o.yardWait, t1: o.dockAt[0], cls: 'wait' }] : []), { t0: o.dockAt[0], t1: o.dockAt[1], cls: 'unload' });
      return { op: o, t0: o.t0, t1: Math.max(o.t1, o.dockAt?.[1] ?? 0), role: 'span', label: opName(o), blocks };
    };
    const trip = (o: BoardOp): Item => {
      const blocks: Item['blocks'] = [];
      const dep = o.depart ?? o.t0;
      if (o.dock) blocks.push({ t0: o.t0, t1: dep, cls: 'load' });
      let tPrev = dep;
      for (const st of o.stops ?? []) {
        blocks.push({ t0: tPrev, t1: st.arrive, cls: 'drive' });
        if (st.start - st.arrive > 60) blocks.push({ t0: st.arrive, t1: st.start, cls: 'wait' });
        blocks.push({ t0: st.start, t1: st.end, cls: st.onTime ? 'unload' : 'unload late' });
        tPrev = st.end;
      }
      blocks.push({ t0: tPrev, t1: o.t1, cls: 'back' });
      return { op: o, t0: o.t0, t1: o.t1, role: 'trip', label: o.id, blocks };
    };
    const by = (k: OpKind[]) => b.ops.filter((o) => k.includes(o.kind));
    const groups: Group[] = [];
    // 长途直送车：路上、门外等、在门店卸货、回程
    const directItem = (o: BoardOp): Item => {
      const st = (o.stops ?? [])[0];
      const blocks: Item['blocks'] = st ? [{ t0: o.t0, t1: st.arrive, cls: 'drive' }, ...(st.start - st.arrive > 60 ? [{ t0: st.arrive, t1: st.start, cls: 'wait' }] : []), { t0: st.start, t1: st.end, cls: st.onTime ? 'unload' : 'unload late' }, { t0: st.end, t1: o.t1, cls: 'back' }] : [];
      return { op: o, t0: o.t0, t1: o.t1, role: 'span', label: opName(o), blocks };
    };
    groups.push({ id: 'port', label: tr('港口与铁路'), open: true, lanes: [...packed(by(['vessel']), tr('泊位'), span), ...packed(by(['train']), tr('洲际班列'), span), ...packed(by(['rail']), tr('港口铁路接驳'), span), ...packed(by(['drayage']), tr('集装箱拖车'), span)] });
    groups.push({ id: 'air', label: tr('空运'), open: true, lanes: [...packed(by(['flight']), tr('货运航班'), span), ...packed(by(['airTruck']), tr('空运冷藏车'), span)] });
    groups.push({ id: 'inbound', label: tr('长途与进货'), open: true, lanes: [...packed(by(['direct']), tr('长途直送门店'), directItem), ...packed(by(['supplier']), tr('长途进配送中心'), span), ...packed(by(['farm']), tr('区域生鲜集货车'), span)] });
    for (const g of ['cold', 'dry'] as const) {
      groups.push({
        id: g,
        label: g === 'cold' ? tr('冷链月台门 {length}', { length: DOORS.cold.length }) : tr('干货月台门 {length}', { length: DOORS.dry.length }),
        open: true,
        lanes: DOORS[g].map((id, i) => {
          const door = b.doors.find((x) => x.id === id);
          return {
            id: `door-${id}`,
            label: id,
            sub: i < RECEIVING_DOORS[g] ? tr('收货') : tr('发货'),
            drop: { kind: 'door' as const, group: g, id },
            items: (door?.bookings ?? []).map((bk) => {
              const o = b.byId.get(bk.op) as BoardOp;
              return { op: o, t0: bk.t0, t1: bk.t1, role: 'door' as const, label: o.id, blocks: [{ t0: bk.t0, t1: bk.t1, cls: bk.mode === 'load' ? 'load' : 'unload' }] };
            }),
          };
        }),
      });
    }
    groups.push({
      id: 'fleet',
      label: tr('配送车队 {length} 辆', { length: b.units.length }),
      open: true,
      lanes: b.units.map((u) => ({ id: `unit-${u.id}`, label: u.id, sub: tx(UNIT_LABEL[u.cls]), drop: { kind: 'unit' as const, cls: u.cls, id: u.id }, items: u.ops.map((x) => trip(b.byId.get(x) as BoardOp)) })),
    });
    // 门店收货口：每个口一行（调度台按先到先用排的口），配送中心的车和长途直送车都在这里
    groups.push({
      id: 'stores',
      label: `${tr('门店收货口')} ${STORES.reduce((a, st) => a + st.docks, 0)}`,
      open: true,
      lanes: STORES.flatMap((st) =>
        Array.from({ length: st.docks }, (_, k) => {
          const items: Item[] = [];
          let win: [number, number] | undefined;
          for (const o of b.ops)
            for (const s of o.stops ?? [])
              if (s.key === st.key && (o.docks?.[st.key] ?? 0) === k) {
                if (o.kind !== 'direct') win = [s.open, s.close];
                items.push({ op: o, t0: s.arrive, t1: s.end, role: 'stop', label: o.id, stop: s, blocks: [...(s.start - s.arrive > 60 ? [{ t0: s.arrive, t1: s.start, cls: 'wait' }] : []), { t0: s.start, t1: s.end, cls: s.onTime ? 'unload' : 'unload late' }] });
              }
          return { id: `store-${st.key}-${k}`, label: tr('收货口 {k}', { k: k + 1 }), sub: st.name, items, ...(win ? { window: win } : {}) };
        }),
      ),
    });
    groups.push({
      id: 'vans',
      label: tr('线上配送'),
      open: true,
      lanes: STORES.map((st) => ({ id: `van-${st.key}`, label: st.name, items: b.ops.filter((o) => o.kind === 'van' && o.from === st.key).map((o) => ({ op: o, t0: o.t0, t1: o.t1, role: 'span' as const, label: '', blocks: [] })) })),
    });
    for (const g of groups) g.open = this.openGroups.get(g.id) ?? true;
    return groups.filter((g) => g.lanes.length);
  }

  private renderGantt(keepNow: boolean): void {
    const d = this.data;
    const el = this.els.gantt;
    if (!d || el.hidden) return;
    LABEL_W = labelW();
    el.style.setProperty('--gt-label', `${LABEL_W}px`);
    const width = Math.max(200, el.clientWidth - LABEL_W - 4);
    this.pxh = this.zoom >= 24 ? width / 24 : width / this.zoom;
    const W = this.pxh * 24;
    const x = (t: number) => (Math.max(-3600, Math.min(25 * 3600, t)) / 3600) * this.pxh;
    const ticks: string[] = [];
    const step = this.pxh > 90 ? 0.25 : this.pxh > 45 ? 1 : 2;
    for (let h = 0; h <= 24; h += step) {
      const major = Math.abs(h - Math.round(h)) < 1e-6;
      ticks.push(`<span class="gt-tick ${major ? '' : 'minor'}" style="left:${h * this.pxh}px">${major ? `${String(h).padStart(2, '0')}` : ''}</span>`);
    }
    const lanesHtml: string[] = [];
    for (const g of this.groups) {
      // 收起的组：在标题行画占用的小柱子（每 15 分钟同时进行的数量）
      let spark = '';
      if (!g.open) {
        const bins = new Array<number>(96).fill(0);
        for (const l of g.lanes) for (const it of l.items) for (let k = Math.max(0, Math.floor(it.t0 / 900)); k < Math.min(96, Math.ceil(it.t1 / 900)); k++) bins[k] = (bins[k] as number) + 1;
        const max = Math.max(1, ...bins);
        spark = bins.map((n, k) => (n ? `<i style="left:${k * 0.25 * this.pxh}px;width:${Math.max(1, 0.25 * this.pxh - 1)}px;height:${Math.round((n / max) * 14) + 2}px"></i>` : '')).join('');
      }
      lanesHtml.push(`<div class="gt-group" data-group="${g.id}"><div class="gt-label"><button class="gt-toggle" aria-expanded="${g.open}">${g.open ? '▾' : '▸'}</button>${esc(tx(g.label))}</div><div class="gt-track gt-spark" style="width:${W}px">${spark}</div></div>`);
      if (!g.open) continue;
      for (const l of g.lanes) {
        const bars = l.items
          .map((it) => {
            const o = it.op;
            const left = x(it.t0);
            const w = Math.max(3, x(it.t1) - left);
            const issues = o.issues;
            const cls = ['gt-bar', `r-${it.role}`, issues.some((i) => i.level === 'error') ? 'err' : issues.some((i) => i.level === 'warn') ? 'warn' : '', o.moved ? 'moved' : '', o.id === this.selected ? 'sel' : '', canDrag(o, it.role) ? 'drag' : ''].filter(Boolean).join(' ');
            const blocks = it.blocks
              .filter((bk) => bk.t1 > bk.t0)
              .map((bk) => `<i class="b-${bk.cls.replace(' ', ' b-')}" style="left:${x(bk.t0) - left}px;width:${Math.max(1, x(bk.t1) - x(bk.t0))}px"></i>`)
              .join('');
            const label = w > 34 && it.label ? `<span>${esc(tx(it.label))}</span>` : '';
            return `<div class="${cls}" data-op="${esc(o.id)}" data-role="${it.role}" data-lane="${l.id}" style="left:${left}px;width:${w}px;--c:${opColor(o)}">${blocks}${label}</div>`;
          })
          .join('');
        const win = l.window ? `<div class="gt-window" style="left:${x(l.window[0] * 3600)}px;width:${Math.max(0, x(l.window[1] * 3600) - x(l.window[0] * 3600))}px" title="${tr('收货时段 {window}–{window2}', { window: hhmm(l.window[0]), window2: hhmm(l.window[1]) })}"></div>` : '';
        lanesHtml.push(`<div class="gt-lane" data-lane="${l.id}"${l.drop ? ` data-drop="${l.drop.kind}:${l.drop.kind === 'door' ? l.drop.group : l.drop.cls}:${l.drop.id}"` : ''}><div class="gt-label" title="${esc(tx(l.label))}${l.sub ? ` · ${esc(tx(l.sub))}` : ''}">${esc(tx(l.label))}${l.sub ? `<small>${esc(tx(l.sub))}</small>` : ''}</div><div class="gt-track" style="width:${W}px">${win}${bars}</div></div>`);
      }
    }
    const scroll = el.querySelector<HTMLElement>('.gt-scroll');
    const prev = scroll ? { left: scroll.scrollLeft, top: scroll.scrollTop } : undefined;
    el.innerHTML = `<div class="gt-scroll"><div class="gt-inner" style="width:${LABEL_W + W}px"><div class="gt-axis"><div class="gt-label gt-corner">${tr('资源')}</div><div class="gt-track" style="width:${W}px">${ticks.join('')}</div></div>${lanesHtml.join('')}<div class="gt-now" style="left:${LABEL_W + (this.time / 3600) * this.pxh}px"><span class="gt-now-label">${hm(this.time)}</span></div></div></div>
      <p class="gt-legend"><i class="b-load"></i>${tr('装车')} <i class="b-drive"></i>${tr('路上')} <i class="b-wait"></i>${tr('等待')} <i class="b-unload"></i>${tr('装卸')} <i class="b-back"></i>${tr('回程')} <i class="b-berth"></i>${tr('靠泊 / 落地 ·')} <span class="lg-moved">${tr('虚线框')}</span> ${tr('= 当天改过 ·')} <span class="lg-err">${tr('红框')}</span> ${tr('= 有问题 · 左右拖动改时刻，拖到别的门、别的车上改派')}</p>`;
    const sc = el.querySelector<HTMLElement>('.gt-scroll') as HTMLElement;
    if (prev && !keepNow) {
      sc.scrollLeft = prev.left;
      sc.scrollTop = prev.top;
    } else if (keepNow && this.zoom < 24) sc.scrollLeft = Math.max(0, (this.time / 3600) * this.pxh - (sc.clientWidth - LABEL_W) / 3);
    else if (prev) sc.scrollTop = prev.top;
  }

  private bindGantt(): void {
    const el = this.els.gantt;
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const tog = t.closest('.gt-group');
      if (tog && t.closest('.gt-label')) {
        const id = (tog as HTMLElement).dataset.group as string;
        this.openGroups.set(id, !(this.openGroups.get(id) ?? true));
        for (const g of this.groups) g.open = this.openGroups.get(g.id) ?? true;
        this.renderGantt(false);
        return;
      }
      if (t.closest('.gt-axis .gt-track')) {
        const track = t.closest('.gt-track') as HTMLElement;
        const r = track.getBoundingClientRect();
        this.host.setTime(Math.max(0, Math.min(86340, ((e.clientX - r.left) / this.pxh) * 3600)));
      }
    });
    el.addEventListener('pointerdown', (e) => {
      const bar = (e.target as HTMLElement).closest<HTMLElement>('.gt-bar');
      if (!bar || e.button !== 0) return;
      const op = this.data?.board.byId.get(bar.dataset.op as string);
      if (!op) return;
      this.drag = { op, role: bar.dataset.role as Role, lane: bar.dataset.lane as string, x0: e.clientX, y0: e.clientY, el: bar, moved: false };
      bar.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const bar = (e.target as HTMLElement).closest<HTMLElement>('.gt-bar');
      if (!this.drag) {
        if (bar) this.showTip(bar, e);
        else this.els.tip.hidden = true;
        return;
      }
      const dr = this.drag;
      const dx = e.clientX - dr.x0;
      const dy = e.clientY - dr.y0;
      if (!dr.moved && Math.hypot(dx, dy) < 5) return;
      if (!canDrag(dr.op, dr.role)) return;
      dr.moved = true;
      if (!dr.ghost) {
        dr.ghost = dr.el.cloneNode(true) as HTMLElement;
        dr.ghost.classList.add('ghost');
        dr.el.parentElement?.append(dr.ghost);
        dr.el.classList.add('dragging');
      }
      const dt = snap((dx / this.pxh) * 3600);
      const target = this.dropTarget(e, dr);
      dr.ghost.style.transform = `translate(${(dt / 3600) * this.pxh}px, ${target ? target.dy : 0}px)`;
      this.els.tip.hidden = false;
      this.els.tip.innerHTML = this.dragText(dr.op, dr.role, dt, target?.label);
      this.placeTip(e);
    });
    el.addEventListener('pointerup', (e) => {
      const dr = this.drag;
      this.drag = undefined;
      this.els.tip.hidden = true;
      if (!dr) return;
      dr.ghost?.remove();
      dr.el.classList.remove('dragging');
      if (!dr.moved) {
        this.select(dr.op.id === this.selected ? undefined : dr.op.id, false);
        return;
      }
      const dt = snap(((e.clientX - dr.x0) / this.pxh) * 3600);
      const target = this.dropTarget(e, dr);
      if (target?.apply) target.apply();
      else if (dt !== 0) this.shift(dr.op, dr.role, dt);
    });
    el.addEventListener('pointerleave', () => {
      if (!this.drag) this.els.tip.hidden = true;
    });
  }

  /** 拖到了哪一行：同组的门、同车型的车才算 */
  private dropTarget(e: PointerEvent, dr: NonNullable<Dispatch['drag']>): { dy: number; label: string; apply: () => void } | undefined {
    const lane = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.gt-lane');
    if (!lane || lane.dataset.lane === dr.lane || !lane.dataset.drop) return undefined;
    const [kind, group, id] = (lane.dataset.drop as string).split(':') as [string, string, string];
    const d = this.data as DispatchData;
    const dy = lane.getBoundingClientRect().top - (dr.el.closest('.gt-lane') as HTMLElement).getBoundingClientRect().top;
    if (kind === 'door' && dr.role === 'door' && dr.op.door?.startsWith(group === 'cold' ? 'C' : 'D')) {
      return { dy, label: tr('改到 {id}', { id }), apply: () => this.host.onDay({ ...d.day, door: { ...d.day.door, [dr.op.id]: id } }, false) };
    }
    if (kind === 'unit' && dr.role === 'trip' && unitClass(dr.op) === group) {
      return { dy, label: tr('改派 {id}', { id }), apply: () => this.host.onDay({ ...d.day, unit: { ...d.day.unit, [dr.op.id]: id } }, false) };
    }
    return undefined;
  }

  /** 左右拖：改出发 / 到达时刻，或者常规计划里的班次时刻 */
  private shift(op: BoardOp, role: Role, dt: number): void {
    const d = this.data as DispatchData;
    const e = op.edit;
    if (!e) return;
    if (e.mode === 'depart') {
      const hour = clampH(((op.depart ?? op.t0) + dt) / 3600, e.min ?? 0, e.max ?? 23.5);
      this.host.onDay({ ...d.day, depart: { ...d.day.depart, [e.key]: hour } }, true);
    } else if (e.mode === 'arrive') {
      const base = Math.min(...d.board.ops.filter((o) => o.edit?.key === e.key).map((o) => o.arrive ?? o.t0));
      const hour = clampH((base + dt) / 3600, e.min ?? 0, e.max ?? 23.5);
      this.host.onDay({ ...d.day, arrive: { ...d.day.arrive, [e.key]: hour } }, true);
    } else {
      const p = structuredClone(d.standing);
      const dh = dt / 3600;
      if (e.key === 'vessel') p.vessel.hour = wrap(p.vessel.hour + dh);
      else if (e.key === 'rail') p.rail.hour = clampH(p.rail.hour + dh, 0, 22);
      else if (e.key === 'train') p.train.hour = clampH(p.train.hour + dh, 0, 23.5);
      else if (e.key === 'flight') p.flight = wrap(p.flight + dh);
      this.host.onStanding(p);
    }
    void role;
  }

  private dragText(op: BoardOp, role: Role, dt: number, target?: string): string {
    void role;
    if (target) return `<b>${esc(op.id)}</b> ${esc(tx(target))}`;
    const e = op.edit;
    if (!e) return tr('这个作业不能拖');
    if (e.mode === 'depart') return `<b>${esc(op.id)}</b> ${tr('出发')} ${hm((op.depart ?? op.t0) + dt)}<small>${tr('原来 {hm}，放开后重新仿真', { hm: hm(op.depart ?? op.t0) })}</small>`;
    if (e.mode === 'arrive') return `<b>${esc(e.key)}</b> ${tr('到达')} ${hm((op.arrive ?? op.t0) + dt)}<small>${tr('同一批的车一起挪，放开后重新仿真')}</small>`;
    const what = e.key === 'vessel' ? tr('班轮靠泊') : e.key === 'rail' ? tr('港口铁路接驳发车') : e.key === 'train' ? tr('洲际班列到站') : tr('航班落地');
    return `<b>${what}</b> ${dt > 0 ? tr('推迟') : tr('提前')} ${tr('{dt} 分钟', { dt: Math.abs(Math.round(dt / 60)) })}<small>${tr('这是常规计划（每天 / 每周都这样），放开后重新仿真 18 周')}</small>`;
  }

  private showTip(bar: HTMLElement, e: PointerEvent): void {
    const op = this.data?.board.byId.get(bar.dataset.op as string);
    if (!op) return;
    const role = bar.dataset.role as Role;
    const lines = [`<b>${esc(op.id)} · ${esc(opName(op))}</b>`, esc(tx(op.label))];
    if (op.depart !== undefined && (op.kind === 'delivery' || op.kind === 'bakery')) lines.push(tr('出发 {hm}{v2} · 回场 {hm2}', { hm: hm(op.depart), v2: op.planned !== undefined && Math.abs(op.planned - op.depart) > 30 ? tr('（原计划 {hm}）', { hm: hm(op.planned) }) : '', hm2: hm(op.t1) }));
    if (op.arrive !== undefined && op.kind !== 'delivery') lines.push(tr('到达 {hm}', { hm: hm(op.arrive) }));
    if (op.door) lines.push(`${tr('月台门 {door}', { door: op.door })}${op.dockAt ? ` ${hm(op.dockAt[0])}–${hm(op.dockAt[1])}` : ''}${op.preload ? tr('（提前装好，挂车在场地等发车）') : ''}${op.yardWait ? tr('（在场地排队 {yardWait} 分钟）', { yardWait: Math.round(op.yardWait / 60) }) : ''}`);
    if (op.unitId) lines.push(tr('车辆 {unitId}', { unitId: op.unitId }));
    if (role === 'stop') {
      const st = (op.stops ?? []).find((s) => bar.dataset.lane?.startsWith(`store-${s.key}`));
      if (st) lines.push(`${tr('到 {hm} · 卸货 {hm2}–{hm3} · 收货时段 {open}–{close}', { hm: hm(st.arrive), hm2: hm(st.start), hm3: hm(st.end), open: hhmm(st.open), close: hhmm(st.close) })}${st.onTime ? '' : ` ${tr('· 迟到')}`}`);
    }
    for (const i of op.issues.slice(0, 3)) lines.push(`<span class="tip-${i.level}">${esc(tx(i.title))}${isEn() ? ': ' : '：'}${esc(tx(i.text))}</span>`);
    if (canDrag(op, role)) lines.push(`<small>${tr('拖动改时刻 / 改派，点一下看详情')}</small>`);
    else if (op.kind === 'van') lines.push(`<small>${tr('线上配送由门店的订单系统安排，这里只看')}</small>`);
    this.els.tip.hidden = false;
    this.els.tip.innerHTML = lines.join('<br>');
    this.placeTip(e);
  }

  private placeTip(e: PointerEvent): void {
    const r = this.els.root.getBoundingClientRect();
    const tip = this.els.tip;
    tip.style.left = `${Math.min(r.width - 300, Math.max(0, e.clientX - r.left + 14))}px`;
    tip.style.top = `${e.clientY - r.top + 16}px`;
  }

  private scrollTo(op: BoardOp): void {
    if (this.tab !== 'gantt') return;
    const bar = this.els.gantt.querySelector<HTMLElement>(`.gt-bar[data-op="${CSS.escape(op.id)}"]`);
    const sc = this.els.gantt.querySelector<HTMLElement>('.gt-scroll');
    if (!bar || !sc) return;
    const br = bar.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    if (br.top < sr.top + 30 || br.bottom > sr.bottom) sc.scrollTop += br.top - sr.top - sr.height / 2;
    if (br.left < sr.left + LABEL_W || br.right > sr.right) sc.scrollLeft += br.left - sr.left - LABEL_W - 40;
  }

  // ———————————————————————— 清单 ————————————————————————

  private renderList(): void {
    const d = this.data as DispatchData;
    const chips = FILTERS.map((f) => `<button class="chip" data-f="${f.key}" aria-pressed="${this.filter.has(f.key)}">${f.label}</button>`).join('');
    const kinds = new Set(FILTERS.filter((f) => this.filter.has(f.key)).flatMap((f) => f.kinds));
    const q = this.query.trim();
    const rows = d.board.ops
      .filter((o) => kinds.has(o.kind))
      .filter((o) => (this.status === 'issues' ? o.issues.some((i) => i.level !== 'info') : this.status === 'moved' ? o.moved : this.status === 'now' ? o.t0 <= this.time && o.t1 >= this.time : true))
      .filter((o) => !q || `${o.id} ${o.label} ${o.unitId ?? ''} ${o.door ?? ''} ${(o.stops ?? []).map((s) => s.name).join(' ')}`.includes(q));
    const head = `<div class="dp-filters">${chips}<select id="dp-status"><option value="all">${tr('全部')}</option><option value="now">${tr('此刻在进行')}</option><option value="issues">${tr('有问题')}</option><option value="moved">${tr('当天改过')}</option></select><input id="dp-q" type="search" placeholder="${tr('搜编号、门店、车辆、月台门')}" value="${esc(this.query)}"><span class="note">${tr('{length} 个', { length: rows.length })}</span></div>`;
    const body = rows
      .map((o) => {
        const route = o.stops?.length ? o.stops.map((s) => `${tx(s.name)}${s.onTime ? '' : tr('（迟）')}`).join(' → ') : `${placeName(o.from)} → ${placeName(o.to)}`;
        const tags = [o.moved ? `<span class="tag moved">${tr('已改')}</span>` : '', ...o.issues.filter((i) => i.level !== 'info').slice(0, 2).map((i) => `<span class="tag ${i.level}">${esc(tx(i.title))}</span>`)].join('');
        return `<tr data-op="${esc(o.id)}" class="${o.id === this.selected ? 'sel' : ''}"><td class="mono">${hm(o.t0)}–${hm(o.t1)}</td><td class="mono">${esc(o.id)}</td><td>${esc(KIND_LABEL[o.kind])}<small>${esc(opName(o))}</small></td><td class="mono">${esc(o.unitId ?? '—')}</td><td class="mono">${esc(o.door ?? '—')}</td><td>${esc(route)}</td><td>${tags}</td></tr>`;
      })
      .join('');
    this.els.list.innerHTML = `${head}<div class="table-wrap dp-table"><table><thead><tr><th>${tr('时间')}</th><th>${tr('编号')}</th><th>${tr('作业')}</th><th>${tr('车辆')}</th><th>${tr('月台门')}</th><th>${tr('路线 / 地点')}</th><th>${tr('状态')}</th></tr></thead><tbody>${body}</tbody></table></div>`;
    for (const b of this.els.list.querySelectorAll<HTMLButtonElement>('.chip[data-f]'))
      b.onclick = () => {
        const k = b.dataset.f as string;
        if (this.filter.has(k)) this.filter.delete(k);
        else this.filter.add(k);
        this.renderList();
      };
    const st = this.els.list.querySelector<HTMLSelectElement>('#dp-status') as HTMLSelectElement;
    st.value = this.status;
    st.onchange = () => {
      this.status = st.value;
      this.renderList();
    };
    const qi = this.els.list.querySelector<HTMLInputElement>('#dp-q') as HTMLInputElement;
    qi.oninput = () => {
      this.query = qi.value;
      const pos = qi.selectionStart;
      this.renderList();
      const again = this.els.list.querySelector<HTMLInputElement>('#dp-q') as HTMLInputElement;
      again.focus();
      if (pos !== null) again.setSelectionRange(pos, pos);
    };
    for (const tr of this.els.list.querySelectorAll<HTMLElement>('tbody tr')) tr.onclick = () => this.select(tr.dataset.op, true);
  }

  // ———————————————————————— 问题 ————————————————————————

  private renderIssues(): void {
    const d = this.data as DispatchData;
    const levels: [Issue['level'], string][] = [
      ['error', tr('要处理')],
      ['warn', tr('提醒')],
      ['info', tr('提示')],
    ];
    const fixable = d.board.issues.filter((i) => i.fix && i.code !== 'wait').length;
    const parts = levels.map(([lv, name]) => {
      const list = d.board.issues.filter((i) => i.level === lv);
      if (!list.length) return '';
      return `<h3>${name}（${list.length}）</h3><ul class="dp-issues">${list
        .map((i, k) => `<li class="lv-${lv}"><time class="mono">${hm(i.at)}</time><div><b>${esc(tx(i.title))}</b> ${esc(tx(i.text))}</div><span class="dp-acts"><button class="chip" data-go="${lv}:${k}">${tr('定位')}</button>${i.fix ? `<button class="chip fix" data-fix="${lv}:${k}">${esc(tx(i.fix.text))}</button>` : ''}</span></li>`)
        .join('')}</ul>`;
    });
    this.els.issues.innerHTML = `<div class="dp-filters"><span>${d.board.issues.length ? tr('{errors} 个要处理、{warns} 个提醒', { errors: d.board.kpi.errors, warns: d.board.kpi.warns }) : tr('没有问题')}</span>${fixable ? `<button class="primary" id="dp-fixall">${tr('全部自动修复（{fixable}）', { fixable })}</button>` : ''}</div>${parts.join('') || `<p class="note">${tr('当天的作业没有冲突，也没有迟到。')}</p>`}`;
    const find = (key: string) => {
      const [lv, k] = key.split(':');
      return d.board.issues.filter((i) => i.level === lv)[Number(k)];
    };
    for (const b of this.els.issues.querySelectorAll<HTMLButtonElement>('[data-go]'))
      b.onclick = () => {
        const i = find(b.dataset.go as string);
        if (!i) return;
        this.host.setTime(Math.max(0, Math.min(86340, i.at)));
        this.select(i.ops[0], true);
      };
    for (const b of this.els.issues.querySelectorAll<HTMLButtonElement>('[data-fix]'))
      b.onclick = () => {
        const i = find(b.dataset.fix as string);
        if (!i?.fix) return;
        this.host.onDay(applyFix(d.day, i.fix), i.fix.kind === 'depart' || i.fix.kind === 'arrive');
      };
    const all = this.els.issues.querySelector<HTMLButtonElement>('#dp-fixall');
    if (all) all.onclick = () => this.auto();
  }

  private auto(): void {
    const d = this.data;
    if (!d) return;
    const r = autoFix(d.board, d.day);
    if (r.changed) this.host.onDay(r.day, r.needsRun);
  }

  // ———————————————————————— 常规计划 ————————————————————————

  private renderPlan(): void {
    const d = this.data as DispatchData;
    const p = d.standing;
    const def = d.defaults;
    const t = (id: string, h: number, min?: number) => `<input type="time" step="300" id="${id}" value="${toInput(h)}"${min !== undefined ? ` min="${toInput(min)}"` : ''}>`;
    const zones = (Object.keys(p.windows) as Zone[])
      .map((z) => {
        const w = p.windows[z] as [number, number];
        const dw = def.windows[z] as [number, number];
        return `<label class="pl-row"><span>${tr('{zone}车', { zone: tx(ZONE_LABEL[z]) })}</span>${t(`pw-${z}-0`, w[0], d.earliest)}<i>${tr('到')}</i>${t(`pw-${z}-1`, w[1])}<small>${tr('默认 {dw}–{dw2}', { dw: hhmm(dw[0]), dw2: hhmm(dw[1]) })}</small></label>`;
      })
      .join('');
    const storeRows = STORES.map((st) => {
      const w = p.receive[st.key];
      return `<label class="pl-row"><span>${tr('配送中心的车')}</span>${t(`pr-${st.key}-0`, w ? w[0] : d.receiveFrom)}<i>${tr('到')}</i><input type="time" step="300" id="pr-${st.key}-1" value="${w ? toInput(w[1]) : ''}" placeholder="${tr('默认')}">${w ? `<button class="chip" data-clear="${st.key}">${tr('恢复默认')}</button>` : `<small>${esc(tx(d.receiveNote))}</small>`}</label>`;
    }).join('');
    const week = (sel: number) => WEEK.map((w, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${w}</option>`).join('');
    const rail = WEEK.map((w, i) => `<label class="check"><input type="checkbox" id="prd-${i}"${p.rail.days.includes(i) ? ' checked' : ''}>${w}</label>`).join('');
    const changed = JSON.stringify(p) !== JSON.stringify(def);
    const compare = d.compare?.length
      ? `<h3>${tr('改了以后（18 周平均，和原计划比）')}</h3><div class="table-wrap"><table class="pl-compare"><thead><tr><th>${tr('指标')}</th><th>${tr('原计划')}</th><th>${tr('现在的计划')}</th><th>${tr('变化')}</th></tr></thead><tbody>${d.compare
          .map((r) => {
            const diff = r.plan - r.base;
            const rel = Math.abs(r.base) > 1e-9 ? (diff / Math.abs(r.base)) * 100 : 0;
            const good = r.better === 'none' || Math.abs(rel) < 0.5 ? '' : (diff < 0) === (r.better === 'lower') ? 'good' : 'bad';
            return `<tr><td>${esc(tx(r.label))}</td><td class="num">${r.base.toFixed(r.digits)} ${esc(tx(r.unit))}</td><td class="num">${r.plan.toFixed(r.digits)} ${esc(tx(r.unit))}</td><td class="num delta ${good}">${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(r.digits)}${Math.abs(rel) >= 0.05 ? `（${rel >= 0 ? '+' : '−'}${Math.abs(rel).toFixed(1)}%）` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : '';
    this.els.plan.innerHTML = `
      <p class="note">${tr('常规计划是每天都照着排的时刻表。改了以后按新计划重新仿真 18 周，结果和原计划比（同一组需求、船期和路况）。当天的单个作业在甘特图里拖动就能改。')}</p>
      <div class="pl-grid">
        <section><h3>${tr('门店配送 · 出车时段')}</h3>${zones}<p class="note">${tr('车在时段里按远近依次出发；最早 {earliest}（分配库存以后才能装车）。', { earliest: hhmm(d.earliest) })}</p></section>
        <section><h3>${tr('进货')}</h3>
          <label class="pl-row"><span>${tr('供应商到货预约')}</span>${t('pi-0', p.inbound[0])}<i>${tr('到')}</i>${t('pi-1', p.inbound[1])}<small>${tr('默认 {inbound}–{inbound2}', { inbound: hhmm(def.inbound[0]), inbound2: hhmm(def.inbound[1]) })}</small></label>
          <label class="pl-row"><span>${tr('区域生鲜集货车到达')}</span>${t('pf', p.farm)}<small>${tr('默认 {farm}', { farm: hhmm(def.farm) })}</small></label>
          <label class="pl-row"><span>${tr('货运航班落地')}</span>${t('pa', p.flight)}<small>${tr('默认 {flight}', { flight: hhmm(def.flight) })}</small></label>
        </section>
        <section><h3>${tr('门店收货（{name}，{docks} 个收货口）', { name: esc(tx(STORES[0]?.name ?? '')), docks: STORES[0]?.docks ?? 0 })}</h3>${storeRows}
          <label class="pl-row"><span>${tr('长途直送车')}</span>${t('pd-0', p.direct[0])}<i>${tr('到')}</i>${t('pd-1', p.direct[1])}<small>${tr('默认 {direct}–{direct2}', { direct: hhmm(def.direct[0]), direct2: hhmm(def.direct[1]) })}</small></label>
          <p class="note">${tr('开门前到的车在门外等，过了截止时刻开始卸货算迟到。')}</p>
        </section>
        <section><h3>${tr('港口与铁路')}</h3>
          <label class="pl-row"><span>${tr('班轮靠泊')}</span><select id="pv-d">${week(p.vessel.day)}</select>${t('pv-h', p.vessel.hour)}<small>${tr('默认 {week} {hour}', { week: WEEK[def.vessel.day], hour: hhmm(def.vessel.hour) })}</small></label>
          <div class="pl-row"><span>${tr('港口铁路接驳')}</span><span class="pl-days">${rail}</span></div>
          <label class="pl-row"><span>${tr('接驳发车')}</span>${t('pt-h', p.rail.hour)}<small>${tr('默认 {hour}', { hour: hhmm(def.rail.hour) })}</small></label>
          <label class="pl-row"><span>${tr('洲际班列到站')}</span><select id="ptr-d">${week(p.train.day)}</select>${t('ptr-h', p.train.hour)}<small>${tr('默认 {week} {hour}', { week: WEEK[def.train.day], hour: hhmm(def.train.hour) })}</small></label>
        </section>
      </div>
      <div class="pl-actions"><button class="primary" id="pl-run">${tr('按这个计划重新仿真')}</button><button class="ghost" id="pl-reset"${changed ? '' : ' disabled'}>${tr('恢复默认计划')}</button><span class="note" id="pl-msg">${changed ? tr('计划和默认的不一样') : tr('现在是默认计划')}</span></div>
      ${compare}`;
    const root = this.els.plan;
    const val = (id: string) => (root.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? '';
    const read = (): StandingPlan => {
      const n = structuredClone(p);
      for (const z of Object.keys(n.windows) as Zone[]) {
        const a = fromInput(val(`pw-${z}-0`));
        const b = fromInput(val(`pw-${z}-1`));
        if (a !== undefined && b !== undefined) n.windows[z] = [Math.max(d.earliest, a), Math.max(a + 0.25, b)];
      }
      const i0 = fromInput(val('pi-0'));
      const i1 = fromInput(val('pi-1'));
      if (i0 !== undefined && i1 !== undefined) n.inbound = [i0, Math.max(i0 + 0.5, i1)];
      n.farm = fromInput(val('pf')) ?? n.farm;
      n.flight = fromInput(val('pa')) ?? n.flight;
      n.vessel = { day: Number(val('pv-d')), hour: fromInput(val('pv-h')) ?? n.vessel.hour };
      n.rail = { days: WEEK.map((_, i) => i).filter((i) => (root.querySelector(`#prd-${i}`) as HTMLInputElement).checked), hour: fromInput(val('pt-h')) ?? n.rail.hour };
      n.train = { day: Number(val('ptr-d')), hour: fromInput(val('ptr-h')) ?? n.train.hour };
      const d0 = fromInput(val('pd-0'));
      const d1 = fromInput(val('pd-1'));
      if (d0 !== undefined && d1 !== undefined) n.direct = [d0, Math.max(d0 + 0.5, d1)];
      const receive: Record<string, [number, number]> = {};
      for (const st of STORES) {
        const a = fromInput(val(`pr-${st.key}-0`));
        const b = fromInput(val(`pr-${st.key}-1`));
        if (a !== undefined && b !== undefined) receive[st.key] = [a, Math.max(a + 0.5, b)];
      }
      n.receive = receive;
      return n;
    };
    (root.querySelector('#pl-run') as HTMLButtonElement).onclick = () => this.host.onStanding(read());
    (root.querySelector('#pl-reset') as HTMLButtonElement).onclick = () => this.host.onStanding(structuredClone(def));
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-clear]'))
      b.onclick = () => {
        const n = read();
        delete n.receive[b.dataset.clear as string];
        this.host.onStanding(n);
      };
  }

  // ———————————————————————— 详情卡 ————————————————————————

  private renderCard(): void {
    const el = this.els.card;
    const d = this.data;
    const op = this.selected && d ? d.board.byId.get(this.selected) : undefined;
    if (!op || !d) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const now = this.time;
    const state = now < op.t0 ? tr('未开始') : now > op.t1 ? tr('已完成') : tr('进行中');
    const rows: string[] = [];
    if (op.unitId) {
      const cls = unitClass(op);
      const units = d.board.units.filter((u) => u.cls === cls).map((u) => u.id);
      const next = `${UNIT_PREFIX[cls]}${String(units.length + 1).padStart(2, '0')}`;
      rows.push(`<label><span>${tr('车辆')}</span><select id="oc-unit">${[...units, next].map((u) => `<option value="${u}"${u === op.unitId ? ' selected' : ''}>${u}${u === next ? tr('（加一辆）') : ''}</option>`).join('')}</select></label>`);
    }
    if (op.door) {
      const g = op.door.startsWith('C') ? 'cold' : 'dry';
      rows.push(`<label><span>${tr('月台门')}</span><select id="oc-door">${DOORS[g].map((x) => `<option value="${x}"${x === op.door ? ' selected' : ''}>${x}</option>`).join('')}</select><small>${op.dockAt ? `${hm(op.dockAt[0])}–${hm(op.dockAt[1])}` : ''}${op.preload ? ` ${tr('· 提前装好')}` : ''}${op.yardWait ? ` ${tr('· 排队 {yardWait} 分钟', { yardWait: Math.round(op.yardWait / 60) })}` : ''}</small></label>`);
    }
    if (op.edit?.mode === 'depart') rows.push(`<label><span>${tr('出发')}</span><input type="time" step="300" id="oc-time" value="${toInput((op.depart ?? op.t0) / 3600)}"><small>${op.planned !== undefined && Math.abs((op.planned ?? 0) - (op.depart ?? 0)) > 30 ? tr('原计划 {hm}', { hm: hm(op.planned) }) : tr('原计划')} ${tr('· 回场 {hm}', { hm: hm(op.t1) })}</small></label>`);
    if (op.edit?.mode === 'arrive') rows.push(`<label><span>${tr('到达')}</span><input type="time" step="300" id="oc-time" value="${toInput((op.arrive ?? op.t0) / 3600)}"><small>${op.edit.key === 'FR' ? tr('区域生鲜集货车一起挪') : tr('这家供应商当天的车一起挪')}</small></label>`);
    if (op.edit?.mode === 'standing') rows.push(`<p class="note">${tr('这是常规班次，时刻在「常规计划」里改（或在甘特图里左右拖）。')}</p>`);
    const facts = [op.km !== undefined ? tr('{km} 公里', { km: Math.round(op.km) }) : '', op.pallets !== undefined ? tr('{pallets}{v2} 托', { pallets: Math.round(op.pallets), v2: op.cap ? ` / ${op.cap}` : '' }) : '', `${hm(op.t0)}–${hm(op.t1)}`].filter(Boolean).join(' · ');
    const stops = op.stops?.length
      ? `<table class="oc-stops"><thead><tr><th>${tr('门店')}</th><th>${tr('到达')}</th><th>${tr('卸货')}</th><th>${tr('收货时段')}</th></tr></thead><tbody>${op.stops
          .map((s) => `<tr class="${s.onTime ? '' : 'late'}"><td>${esc(tx(s.name))}</td><td class="mono">${hm(s.arrive)}</td><td class="mono">${hm(s.start)}–${hm(s.end)}</td><td class="mono">${hhmm(s.open)}–${hhmm(s.close)}${s.onTime ? '' : ` ${tr('迟到')}`}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
    const issues = op.issues.length ? `<ul class="oc-issues">${op.issues.map((i, k) => `<li class="lv-${i.level}"><b>${esc(tx(i.title))}</b> ${esc(tx(i.text))}${i.fix ? ` <button class="chip fix" data-fix="${k}">${esc(tx(i.fix.text))}</button>` : ''}</li>`).join('')}</ul>` : `<p class="note">${tr('没有问题。')}</p>`;
    el.innerHTML = `<div class="oc-head"><div><b>${esc(op.id)}</b> ${esc(opName(op))}<small>${esc(KIND_LABEL[op.kind])} · ${state}${op.moved ? ` ${tr('· 当天改过')}` : ''}</small></div><button class="oc-close" aria-label="${tr('关闭')}">×</button></div>
      <p class="oc-label">${esc(tx(op.label))}</p><p class="oc-facts mono">${esc(tx(facts))}</p>
      <div class="oc-form">${rows.join('')}</div>${stops}${issues}
      <div class="oc-acts"><button class="chip" id="oc-follow">${tr('在三维里跟随')}</button><button class="chip" id="oc-jump">${tr('跳到开始')}</button>${op.moved ? `<button class="chip" id="oc-undo">${tr('恢复原计划')}</button>` : ''}</div>`;
    (el.querySelector('.oc-close') as HTMLButtonElement).onclick = () => this.select(undefined, false);
    (el.querySelector('#oc-follow') as HTMLButtonElement).onclick = () => this.host.onSelect(op, true);
    (el.querySelector('#oc-jump') as HTMLButtonElement).onclick = () => {
      this.host.setTime(Math.max(0, Math.min(86340, op.t0)));
      this.host.onSelect(op, true);
    };
    const unit = el.querySelector<HTMLSelectElement>('#oc-unit');
    if (unit) unit.onchange = () => this.host.onDay({ ...d.day, unit: { ...d.day.unit, [op.id]: unit.value } }, false);
    const door = el.querySelector<HTMLSelectElement>('#oc-door');
    if (door) door.onchange = () => this.host.onDay({ ...d.day, door: { ...d.day.door, [op.id]: door.value } }, false);
    const time = el.querySelector<HTMLInputElement>('#oc-time');
    if (time)
      time.onchange = () => {
        const h = fromInput(time.value);
        if (h === undefined || !op.edit) return;
        const hh = clampH(h, op.edit.min ?? 0, op.edit.max ?? 23.5);
        if (op.edit.mode === 'depart') this.host.onDay({ ...d.day, depart: { ...d.day.depart, [op.edit.key]: hh } }, true);
        else this.host.onDay({ ...d.day, arrive: { ...d.day.arrive, [op.edit.key]: hh } }, true);
      };
    const undo = el.querySelector<HTMLButtonElement>('#oc-undo');
    if (undo)
      undo.onclick = () => {
        const n: DayPlan = { depart: { ...d.day.depart }, arrive: { ...d.day.arrive }, door: { ...d.day.door }, unit: { ...d.day.unit } };
        const rerun = !!op.edit && ((op.edit.mode === 'depart' && n.depart[op.edit.key] !== undefined) || (op.edit.mode === 'arrive' && n.arrive[op.edit.key] !== undefined));
        if (op.edit?.mode === 'depart') delete n.depart[op.edit.key];
        if (op.edit?.mode === 'arrive') delete n.arrive[op.edit.key];
        delete n.door[op.id];
        delete n.unit[op.id];
        this.host.onDay(n, rerun);
      };
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-fix]'))
      b.onclick = () => {
        const i = op.issues[Number(b.dataset.fix)];
        if (i?.fix) this.host.onDay(applyFix(d.day, i.fix), i.fix.kind === 'depart' || i.fix.kind === 'arrive');
      };
  }
}

function canDrag(o: BoardOp, role: Role): boolean {
  if (role === 'door') return true;
  if (role === 'trip') return true;
  if (role === 'stop') return o.edit?.mode === 'depart' || (o.kind === 'direct' && o.edit?.mode === 'arrive');
  return !!o.edit;
}
const snap = (s: number) => Math.round(s / 300) * 300;
const clampH = (h: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, h)) * 12) / 12;
const wrap = (h: number) => Math.round((((h % 24) + 24) % 24) * 12) / 12;
const PLACE: Record<string, string> = { DC: tr('配送中心'), BAKERY: tr('面包房'), PORT: tr('港口'), AIR: tr('机场'), SEA: tr('海上'), RAIL_DC: tr('物流园货运站'), AIR_IN: tr('航线'), ANCHORAGE: tr('锚地') };
function placeName(k: string): string {
  // 高速出口、洲际铁路的方向跟着区域走
  const plan = currentRegion();
  if (k === 'NORTH') return tr('{dir}面高速口（国内长途）', { dir: tx(DIR_LABEL[dirOf(plan.offmap.NORTH)]) });
  if (k === 'EAST') return tr('{dir}面高速口（跨境长途）', { dir: tx(DIR_LABEL[dirOf(plan.offmap.EAST)]) });
  if (k === 'RAIL_EAST') return `${tx(DIR_LABEL[dirOf(RAIL[RAIL.length - 1] ?? { x: 1, y: 0 })])}${tr('面铁路（洲际）')}`;
  return PLACE[k] ?? tx(STORES.find((s) => s.key === k)?.name ?? k);
}
