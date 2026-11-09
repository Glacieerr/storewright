import { clock, STATUS_LABEL, type TrackRow, type TrackStatus } from './tracking';
import { VKIND_COLOR, type VKind } from './three/vehicles';
import { t, tx as txl } from './i18n';

/**
 * 实时跟踪面板：三维视图左边一列所有车辆（在途的按预计到达排前面），点一下选中；侧栏是选中车辆的详细信息。
 */
type Group = 'all' | 'road' | 'rail' | 'sea' | 'air';
const GROUP_LABEL: Record<Group, string> = { all: t('全部'), road: t('公路'), rail: t('铁路'), sea: t('海运'), air: t('空运') };
const groupOf = (kind: string): Group => (kind === 'train' ? 'rail' : kind === 'ship' ? 'sea' : kind === 'plane' ? 'air' : 'road');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const ORDER: Record<TrackStatus, number> = { moving: 0, working: 1, pending: 2, done: 3 };

export interface TrackHost {
  onSelect: (i: number) => void;
  onFollow: (i: number) => void;
  onOps: (i: number) => void;
  /** 面板展开 / 收起以后：三维视图左边被挡住多宽（像素） */
  onLayout: (inset: number) => void;
}

export class TrackPanel {
  private group: Group = 'all';
  private onlyLive = false;
  private collapsed = false;
  private rows: TrackRow[] = [];
  selected: number | undefined;
  private fieldNote = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly card: HTMLElement,
    private readonly host: TrackHost,
  ) {
    root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const g = el.closest<HTMLElement>('[data-g]');
      if (g) {
        this.group = g.dataset.g as Group;
        this.render();
        return;
      }
      if (el.closest('[data-live]')) {
        this.onlyLive = !this.onlyLive;
        this.render();
        return;
      }
      if (el.closest('[data-min]')) {
        this.collapsed = !this.collapsed;
        this.render();
        this.layout();
        return;
      }
      const li = el.closest<HTMLElement>('[data-i]');
      if (li) this.host.onSelect(Number(li.dataset.i));
    });
    card.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el || this.selected === undefined) return;
      if (el.dataset.act === 'follow') this.host.onFollow(this.selected);
      if (el.dataset.act === 'ops') this.host.onOps(this.selected);
    });
  }

  /** 告诉三维视图左边被挡住多宽（窗口大小变了也要调） */
  layout(): void {
    this.host.onLayout(this.collapsed ? 0 : this.root.getBoundingClientRect().width + 10);
  }

  /** 现场视图时的说明（「预计到达」用的是孪生的估计） */
  setMode(field: boolean): void {
    this.fieldNote = field ? t('现场视图：车按现场的延误走，预计到达是孪生按感知数据的估计') : t('计划视图：按仿真排的计划');
  }

  setRows(rows: TrackRow[]): void {
    this.rows = rows;
    this.render();
    this.renderCard();
  }

  select(i: number | undefined): void {
    this.selected = i;
    this.render();
    this.renderCard();
  }

  private render(): void {
    const counts: Record<TrackStatus, number> = { moving: 0, working: 0, pending: 0, done: 0 };
    for (const r of this.rows) counts[r.status]++;
    const shown = this.rows
      .filter((r) => (this.group === 'all' || groupOf(r.kind) === this.group) && (!this.onlyLive || r.status === 'moving' || r.status === 'working'))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.nextEta ?? a.nextPlan ?? a.depart ?? 0) - (b.nextEta ?? b.nextPlan ?? b.depart ?? 0));
    const groups = (Object.keys(GROUP_LABEL) as Group[]).filter((g) => g === 'all' || this.rows.some((r) => groupOf(r.kind) === g));
    this.root.classList.toggle('collapsed', this.collapsed);
    this.root.innerHTML = `
      <div class="tk-head"><b>${t('实时跟踪')}</b><span class="tk-counts">${t('在途 {moving} · 作业 {working} · 待发 {pending} · 收车 {done}', { moving: counts.moving, working: counts.working, pending: counts.pending, done: counts.done })}</span><button class="tk-min" data-min title="${this.collapsed ? t('展开') : t('收起')}">${this.collapsed ? '▸' : '▾'}</button></div>
      ${this.collapsed ? '' : `<div class="tk-filters">${groups.map((g) => `<button data-g="${g}" aria-pressed="${g === this.group}">${GROUP_LABEL[g]}</button>`).join('')}<button data-live aria-pressed="${this.onlyLive}">${t('只看在场')}</button></div>
      <ol class="tk-list">${shown.map((r) => this.row(r)).join('') || `<li class="tk-empty">${t('没有车')}</li>`}</ol>
      <p class="tk-note">${esc(this.fieldNote)}</p>`}`;
  }

  private row(r: TrackRow): string {
    const color = VKIND_COLOR[r.kind as VKind] ?? '#888';
    let tx = '';
    if (r.status === 'moving') tx = `→ ${txl(r.next)} ${r.nextEta !== undefined ? `<b>${clock(r.nextEta)}</b>` : r.nextPlan !== undefined ? clock(r.nextPlan) : ''}${r.remainKm !== undefined ? ` ${t('· {remainKm} 公里', { remainKm: r.remainKm.toFixed(1) })}` : ''}`;
    else if (r.status === 'working') tx = esc(txl(r.act).replace(/^在/, ''));
    else if (r.status === 'pending') tx = `${r.depart !== undefined ? clock(r.depart) : ''} ${t('出发 → {next}', { next: esc(txl(r.next)) })}`;
    else tx = `${t('已收车')} ${r.end !== undefined ? clock(r.end) : ''}`;
    const late = r.delayMin !== undefined && r.delayMin >= 5 ? `<span class="tk-late">${t('晚 {delayMin} 分', { delayMin: r.delayMin })}</span>` : '';
    const hot = r.temp && r.temp.value > r.temp.limit ? `<span class="tk-late">${t('超温')}</span>` : '';
    return `<li data-i="${r.i}" class="tk-row ${r.status}${r.i === this.selected ? ' sel' : ''}"><i style="background:${color}"></i><b>${esc(r.id)}</b><span class="tk-st ${r.status}">${STATUS_LABEL[r.status]}</span>${late}${hot}<span class="tk-tx">${tx}</span></li>`;
  }

  private renderCard(): void {
    const r = this.rows.find((x) => x.i === this.selected);
    this.card.hidden = !r;
    if (!r) return;
    const color = VKIND_COLOR[r.kind as VKind] ?? '#888';
    const nextLine = r.next ? `${t('{next}：计划', { next: esc(txl(r.next)) })} ${r.nextPlan !== undefined ? clock(r.nextPlan) : '—'}${r.nextEta !== undefined ? ` · <b>${t('孪生估计 {nextEta}', { nextEta: clock(r.nextEta) })}</b>` : ''}` : '—';
    const rows: [string, string][] = [
      [t('从 → 到'), `${esc(txl(r.origin))} → ${esc(txl(r.dest))}`],
      [t('出发'), `${r.depart !== undefined ? t('计划 {depart}', { depart: clock(r.depart) }) : '—'}${r.departActual !== undefined && r.status !== 'pending' ? ` ${t('· 实际 {departActual}', { departActual: clock(r.departActual) })}` : ''}`],
      [t('下一站'), nextLine],
      [t('车速'), r.status === 'moving' ? t('{speed} 公里 / 小时（这一程平均）', { speed: Math.round(r.speed) }) : t('停着')],
      [t('载重'), esc(txl(r.load))],
      [t('货物'), esc(txl(r.cargo) || '—')],
      ...(r.delayMin !== undefined ? ([[t('晚点'), r.delayMin > 0 ? t('{delayMin} 分钟（现场）', { delayMin: r.delayMin }) : t('准点')]] as [string, string][]) : []),
      ...(r.temp ? ([[t('货温'), `<span class="${r.temp.value > r.temp.limit ? 'bad' : ''}">${r.temp.value.toFixed(1)} °C</span>${t('（上限 {limit} °C）', { limit: r.temp.limit })}`]] as [string, string][]) : []),
      [t('收车'), r.end !== undefined ? clock(r.end) : '—'],
    ];
    this.card.innerHTML = `
      <div class="vc-head"><i style="background:${color}"></i><b>${esc(r.id)}</b><span>${esc(txl(r.type))}</span><span class="tk-st ${r.status}">${STATUS_LABEL[r.status]}</span></div>
      <div class="vc-where">${esc(txl(r.where))}</div>
      <div class="vc-bar" title="${t('全程进度')}"><span style="width:${Math.round(r.progress * 100)}%"></span></div>
      <dl class="vc-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${r.stops.length ? `<ol class="vc-stops">${r.stops.map((s) => `<li class="${s.passed ? 'passed' : ''}"><span>${esc(txl(s.name))}</span><span class="mono">${clock(s.plan)}${s.eta !== undefined ? ` → ${clock(s.eta)}` : ''}</span></li>`).join('')}</ol>` : ''}
      <div class="vc-actions"><button class="chip" data-act="follow">${t('在三维里跟随')}</button><button class="chip" data-act="ops">${t('在调度台看作业')}</button></div>`;
  }
}
