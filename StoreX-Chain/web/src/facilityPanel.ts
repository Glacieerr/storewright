import { clock } from './tracking';
import type { PortInfo } from './three/ops/port';
import type { AirInfo } from './three/ops/airport';
import type { ParkYardInfo } from './three/ops/parkYard';
import type { SiteInfo } from './three/store';
import { isEn, t as tr, tx } from './i18n';

/**
 * 设施监控面板（三维视图右边）：港口、机场、物流园、综合店四页，每页是这个设施此刻的全部状态——
 * 在场的车船飞机和它们的作业进度、每台设备在干什么、本店的货走到哪一步、库存和今天的统计。
 * 点车辆编号就在三维里选中那辆车（左边的跟踪面板和侧栏一起跟着变）。
 */
export type FacTab = 'group' | 'port' | 'air' | 'dc' | 'store';
const TAB_LABEL: Record<FacTab, string> = { group: tr('集团总览'), port: tr('港口'), air: tr('机场'), dc: tr('物流园'), store: tr('综合店') };

export interface RailInfo {
  title: string;
  trains: { vid: number; label: string; mode: string; t0: number; t1: number; done: number; n: number }[];
  crane: string;
  yard: number;
}
export interface DcInfo {
  doors: { id: string; cold: boolean; open: boolean; vid?: number; label?: string; mode?: string; done?: number; n?: number; since?: number; until?: number; next?: { label: string; t: number; mode: string } }[];
  staged: { out: number; in: number };
  cranesBusy: number;
  cranes: number;
  amrBusy: number;
  amrTotal: number;
  trucksToday: { load: number; unload: number; pallets: number };
  /** 园区场地：门外排队、待命停车场、甩挂区、铁路转运仓、短驳和场内牵引车、本店的铁路箱、今天的场地指标 */
  yard?: ParkYardInfo;
}
export interface StoreDockInfo {
  docks: { id: string; vid?: number; label?: string; done?: number; n?: number; until?: number; next?: { label: string; t: number } }[];
  today: number;
  pallets: number;
  /** 店前停车场、即时取货、收货场（综合店站点） */
  site?: SiteInfo;
}
export interface FacData {
  t: number;
  /** 车辆下标 → 显示的编号（和跟踪面板一致） */
  idOf: (vid: number) => string;
  /** 集团总览：场景、网络的关键指标、每个设施一行状态、人工成本、异常 */
  group?: {
    scene: [string, string][];
    kpi: [string, string][];
    facilities: { tab: FacTab; name: string; status: string; bad?: boolean }[];
    labor: { name: string; cost: number; hours: number }[];
    alerts: { text: string; vid?: number }[];
  };
  /** 只算正在看的那一页 */
  port?: { info: PortInfo; rail: RailInfo; shipVid?: number };
  air?: AirInfo & { vidOf: (id: string) => number | undefined };
  dc?: { info: DcInfo; rail: RailInfo[]; dcDays?: number };
  store?: {
    docks: StoreDockInfo;
    deliveries: { vid: number; id: string; label: string; plan: number; eta?: number; status: string; pallets: number; late: boolean }[];
    stock: { label: string; units: number; days?: number; est?: number }[];
    stockNote: string;
    vans: { out: number; done: number; total: number };
    days?: number;
    lost?: number;
  };
}
export interface FacHost {
  onVehicle: (vid: number) => void;
  onFocus: (tab: FacTab) => void;
  /** 打开这个设施的管理台（布局、设备、人员排班） */
  onManage: (tab: FacTab) => void;
  /** 面板展开 / 收起：三维视图右边被挡住多宽 */
  onLayout: (inset: number) => void;
}

/** 时刻：前一天、次日的加上说明（跨零点的靠泊、航班） */
const when = (t: number): string => (t < 0 ? tr('前一天 {t}', { t: clock(t) }) : t >= 86400 ? tr('次日 {t}', { t: clock(t) }) : clock(t));
/** 潮汐的时刻（过了半夜的写「次日」） */
const tideClock = (t: number): string => {
  const m = Math.round(t / 60);
  const d = Math.floor(m / 1440);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${d > 0 ? `${tr('次日')} ` : ''}${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
/** 太长的名字截短：中文照旧截前 n 个字；英文先翻译，按英文的长度在词边上截。Shorten a label (English: translate first, cut at a word) */
const cut = (s: string, n: number): string => {
  if (!isEn()) return s.slice(0, n);
  const e = tx(s);
  if (e.length <= n * 3) return e;
  const k = e.lastIndexOf(' ', n * 3);
  return `${e.slice(0, k > n ? k : n * 3).replace(/[\s,;:(·]+$/, '')}…`;
};
/** 指标的值（「12 车」「4 个」）：英文按字典翻，只有数字加「个」的写成数字。A metric value in the current language */
const kv = (v: string): string => (isEn() && /^[\d.,]+ 个$/.test(v) ? v.slice(0, -2) : tx(v));
/** 「指标：值」：英文把指标和值分开翻（整句查时，带括号、斜杠的指标名会先被通用的连接条目拆开） */
const metric = (s: string): string => {
  const i = s.indexOf('：');
  return isEn() && i > 0 ? `${tx(s.slice(0, i))}: ${kv(s.slice(i + 1))}` : tx(s);
};
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const bar = (a: number, b: number) => `<span class="fc-bar"><span style="width:${pct(a, b)}%"></span></span>`;

export class FacilityPanel {
  tab: FacTab = 'group';
  private collapsed = false;
  private data: FacData | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: FacHost,
  ) {
    root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const tb = el.closest<HTMLElement>('[data-tab]');
      if (tb) {
        this.setTab(tb.dataset.tab as FacTab);
        return;
      }
      if (el.closest('[data-min]')) {
        this.collapsed = !this.collapsed;
        this.render();
        this.layout();
        return;
      }
      if (el.closest('[data-focus]')) {
        this.host.onFocus(this.tab);
        return;
      }
      if (el.closest('[data-manage]')) {
        this.host.onManage(this.tab);
        return;
      }
      const v = el.closest<HTMLElement>('[data-vid]');
      if (v) this.host.onVehicle(Number(v.dataset.vid));
      const go = el.closest<HTMLElement>('[data-go]');
      if (go) this.setTab(go.dataset.go as FacTab);
    });
  }

  layout(): void {
    this.host.onLayout(this.collapsed ? 0 : this.root.getBoundingClientRect().width + 10);
  }

  setTab(tab: FacTab): void {
    this.tab = tab;
    this.render();
  }

  setData(d: FacData): void {
    this.data = d;
    this.render();
  }

  private veh(vid: number | undefined, text?: string): string {
    if (vid === undefined || !this.data) return esc(text ?? '—');
    return `<button class="fc-veh" data-vid="${vid}">${esc(text ?? this.data.idOf(vid))}</button>`;
  }

  private render(): void {
    const tabs = (Object.keys(TAB_LABEL) as FacTab[]).map((k) => `<button data-tab="${k}" aria-pressed="${k === this.tab}">${TAB_LABEL[k]}</button>`).join('');
    this.root.classList.toggle('collapsed', this.collapsed);
    const d = this.data;
    const body = this.collapsed || !d ? '' : this.tab === 'group' && d.group ? this.group(d.group) : this.tab === 'port' && d.port ? this.port(d, d.port) : this.tab === 'air' && d.air ? this.air(d, d.air) : this.tab === 'dc' && d.dc ? this.dc(d, d.dc) : this.tab === 'store' && d.store ? this.store(d.store) : `<p class="fc-muted">${tr('运行后显示')}</p>`;
    this.root.innerHTML = `
      <div class="tk-head"><b>${tr('设施监控')}</b><span class="tk-counts">${this.data ? clock(this.data.t) : ''}</span><button class="tk-min" data-min title="${this.collapsed ? tr('展开') : tr('收起')}">${this.collapsed ? '◂' : '▾'}</button></div>
      ${this.collapsed ? '' : `<div class="tk-filters">${tabs}${this.tab !== 'group' ? `<button data-focus title="${tr('三维镜头飞到这个设施')}">${tr('定位')}</button>` : ''}<button data-manage title="${tr('设施的布局、设备、人员排班和指标')}">${tr('管理')}</button></div><div class="fc-body">${body}</div>`}`;
  }

  private group(g: NonNullable<FacData['group']>): string {
    const total = g.labor.reduce((a, x) => a + x.cost, 0);
    return `
      <p class="fc-kv">${g.scene.map(([k, v]) => `<span>${esc(tx(k))}</span><b>${esc(tx(v))}</b>`).join('')}</p>
      <h4>${tr('网络')}</h4>
      <p class="fc-kv">${g.kpi.map(([k, v]) => `<span>${esc(tx(k))}</span><b>${esc(tx(v))}</b>`).join('')}</p>
      <h4>${tr('设施')}</h4>
      <table class="fc-t">${g.facilities.map((f) => `<tr class="${f.bad ? 'fc-bad' : ''}"><td><button class="fc-veh" data-go="${f.tab}">${esc(tx(f.name))}</button></td><td>${esc(tx(f.status))}</td></tr>`).join('')}</table>
      <h4>${tr('每天人工（按排班）')}</h4>
      <table class="fc-t">${g.labor.map((x) => `<tr><td>${esc(tx(x.name))}</td><td>$${Math.round(x.cost).toLocaleString('en-US')}</td><td class="fc-muted">${tr('{hours} 工时', { hours: x.hours })}</td></tr>`).join('')}<tr><td><b>${tr('合计')}</b></td><td><b>$${Math.round(total).toLocaleString('en-US')}</b></td><td></td></tr></table>
      <h4>${tr('异常（{length}）', { length: g.alerts.length })}</h4>
      ${g.alerts.length ? `<ul class="fc-alerts">${g.alerts.map((a) => `<li>${a.vid !== undefined ? this.veh(a.vid, a.text) : esc(metric(a.text))}</li>`).join('')}</ul>` : `<p class="fc-muted">${tr('没有异常')}</p>`}`;
  }

  private rail(r: RailInfo): string {
    const trains = r.trains.length ? r.trains.map((x) => `<tr><td>${this.veh(x.vid)}</td><td>${esc(tx(x.mode))}</td><td>${when(x.t0)}–${when(x.t1)}</td><td>${x.done}/${x.n} ${bar(x.done, x.n)}</td></tr>`).join('') : `<tr><td colspan="4" class="fc-muted">${tr('前后一小时没有列车')}</td></tr>`;
    return `<h4>${esc(tx(r.title))}</h4><table class="fc-t"><tr><th>${tr('列车')}</th><th>${tr('作业')}</th><th>${tr('停站')}</th><th>${tr('吊箱')}</th></tr>${trains}</table><p class="fc-kv"><span>${tr('龙门吊')}</span><b>${esc(tx(r.crane))}</b><span>${tr('箱位上')}</span><b>${tr('{yard} 箱', { yard: r.yard })}</b></p>`;
  }

  private port(d: FacData, pd: NonNullable<FacData['port']>): string {
    const p = pd.info;
    const v = p.vessel;
    const boxes = p.boxes.filter((b) => b.store);
    const now = (b: (typeof boxes)[number]) => [...b.steps].reverse().find((s) => s.t <= d.t);
    // 别家的船的船期：泊位、靠泊 / 离泊（在锚地等过的注上锚泊时段）、此刻的状态和岸桥作业进度
    const anchor = (c: (typeof p.calls)[number]) => (c.anchor ? `<div class="fc-muted">${tr('锚地 {v1}–', { v1: Number.isFinite(c.anchor[0]) ? when(c.anchor[0]) : tr('零点前') })}${Number.isFinite(c.anchor[1]) ? when(c.anchor[1]) : tr('待定')}</div>` : '');
    const calls = p.calls.map((c) => `<tr><td><b>${esc(tx(c.name))}</b><div class="fc-muted">${esc(tx(c.cls))}</div></td><td>${esc(c.berth.replace(' 号泊位', ` ${tr('号')}`))}</td><td>${c.fast !== undefined ? `${when(c.fast)}<div class="fc-muted">${c.cast !== undefined ? when(c.cast) : '—'}</div>` : `<span class="fc-muted">${tr('到港 {when}', { when: when(c.eta) })}</span>`}${anchor(c)}</td><td>${esc(tx(c.status))}${c.moves ? `<div>${c.done}/${c.moves} ${bar(c.done, c.moves)}</div>` : ''}</td></tr>`).join('');
    return `
      <h4>${tr('本店班轮')}</h4>
      ${v ? `<p class="fc-kv"><span>${tr('船')}</span><b>${this.veh(pd.shipVid, cut(v.label, 18))}</b><span>${tr('靠泊')}</span><b>${when(v.berth[0])}–${when(v.berth[1])}</b><span>${tr('卸船')}</span><b>${tr('{discharge} 箱', { discharge: v.discharge })}</b><span>${tr('装船')}</span><b>${tr('{loaded} 箱', { loaded: v.loaded })}</b></p><p class="fc-kv"><span>${tr('本船进度')}</span><b>${v.done}/${v.moves} ${bar(v.done, v.moves)}</b><span>${tr('别家的船（今天）')}</span><b>${tr('{done}/{moves} 箱', { done: p.other.done, moves: p.other.moves })}</b></p>` : `<p class="fc-muted">${tr('今天没有本店的班轮')}</p>`}
      <h4>${tr('泊位')}</h4>
      <table class="fc-t"><tr><th>${tr('泊位')}</th><th>${tr('船')}</th><th>${tr('状态')}</th></tr>${p.berths.map((b) => `<tr><td><b>${esc(tx(b.label))}</b><div class="fc-muted">${tr('{cranes} 台岸桥', { cranes: b.cranes })}${b.own ? ` ${tr('· 本店')}` : ''}</div></td><td>${esc(tx(b.ship ?? '—'))}</td><td>${esc(tx(b.status))}</td></tr>`).join('')}</table>
      <h4>${tr('别家的船 · 今天的船期（{length}）', { length: p.calls.length })}</h4>
      <table class="fc-t"><tr><th>${tr('船')}</th><th>${tr('泊位')}</th><th>${tr('靠泊 / 离泊')}</th><th>${tr('状态 · 岸桥作业')}</th></tr>${calls || `<tr><td colspan="4" class="fc-muted">${tr('今天没有别家的船')}</td></tr>`}</table>
      <h4>${tr('本店的箱（{length}）', { length: boxes.length })}</h4>
      <table class="fc-t"><tr><th>${tr('箱号')}</th><th>${tr('现在')}</th></tr>${boxes.map((b) => `<tr><td class="mono">${esc(b.id)}</td><td>${esc(tx(now(b)?.text ?? tr('还在船上')))}${now(b) ? ` <span class="fc-muted">${clock((now(b) as { t: number }).t)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="2" class="fc-muted">—</td></tr>'}</table>
      <h4>${tr('设备')}</h4>
      <table class="fc-t"><tr><th>${tr('设备')}</th><th>${tr('在干什么')}</th><th>${tr('完成')}</th></tr>${p.equip.map((e) => `<tr><td><b>${esc(tx(e.id))}</b><div class="fc-muted">${esc(tx(e.kind))}</div></td><td>${esc(tx(e.now))}</td><td>${e.doneMoves}/${e.moves}</td></tr>`).join('')}</table>
      <p class="fc-kv"><span>${tr('闸口')}</span><b>${tr('场内 {inside} 辆 · 排队 {queue} 辆', { inside: p.gate.inside, queue: p.gate.queue })}</b><span>${tr('今天进 / 出')}</span><b>${p.gate.inToday} / ${p.gate.outToday}</b><span>${tr('堆场')}</span><b>${tr('{boxes} 箱（{boxes2}%）', { boxes: p.yard.boxes, boxes2: pct(p.yard.boxes, p.yard.slots) })}</b>${p.tide ? `<span>${tr('潮位')}</span><b>${tr('{level} 米 · {v2}（下一次{v3}）', { level: p.tide.level.toFixed(1), v2: p.tide.rising ? tr('涨潮') : tr('落潮'), v3: p.tide.rising ? tr('高潮 {tideClock}', { tideClock: tideClock(p.tide.nextHigh) }) : tr('低潮 {tideClock}', { tideClock: tideClock(p.tide.nextLow) }) })}</b>` : ''}</p>
      ${p.logistics ? this.portLogi(p.logistics) : ''}
      ${this.rail(pd.rail)}`;
  }

  /** 港口物流中心：拆装箱库、保税库、海关查验、空箱堆场 */
  private portLogi(l: NonNullable<PortInfo['logistics']>): string {
    return `
      <h4>${tr('物流中心 · 拆装箱库')}</h4>
      <p class="fc-kv"><span>${tr('正在拆箱 / 装箱')}</span><b>${tr('{devanning} / {stuffing} 个', { devanning: l.devanning, stuffing: l.stuffing })}</b><span>${tr('库内')}</span><b>${tr('{cfsPallets} 板（{cfsFill}%）{bar}', { cfsPallets: l.cfsPallets, cfsFill: l.cfsFill, bar: bar(l.cfsFill, 100) })}</b><span>${tr('货车侧月台')}</span><b>${tr('{busy}/{doors} 樘', { busy: l.truckDocks.busy, doors: l.truckDocks.doors })}${l.truckDocks.queue ? ` ${tr('· {queue} 辆在等', { queue: l.truckDocks.queue })}` : ''}</b><span>${tr('场内拖车')}</span><b>${tr('{busy}/{total} 辆在跑', { busy: l.tractors.busy, total: l.tractors.total })}</b></p>
      <h4>${tr('物流中心 · 保税仓库')}</h4>
      <p class="fc-kv"><span>${tr('库存')}</span><b>${tr('{pallets} 板（{fill}%）{bar}', { pallets: l.bonded.pallets, fill: l.bonded.fill, bar: bar(l.bonded.fill, 100) })}</b><span>${tr('月台')}</span><b>${tr('{busy}/{doors} 樘', { busy: l.bonded.busy, doors: l.bonded.doors })}</b></p>
      <h4>${tr('物流中心 · 海关查验')}</h4>
      <p class="fc-kv"><span>${tr('机检通道')}</span><b>${l.inspection.scanning ? tr('有车在扫描') : tr('空着')}</b><span>${tr('开箱查验台')}</span><b>${tr('{open}/{bays} 个车位在查', { open: l.inspection.open, bays: l.inspection.bays })}</b><span>${tr('今天已查')}</span><b>${tr('机检 {today} 箱 · 开箱 {openedToday} 箱', { today: l.inspection.today, openedToday: l.inspection.openedToday })}</b></p>
      ${l.inspection.own.length ? `<table class="fc-t"><tr><th>${tr('本店被布控的箱')}</th><th>${tr('现在')}</th></tr>${l.inspection.own.map((o) => `<tr><td class="mono">${esc(o.box)}</td><td>${esc(tx(o.text))}</td></tr>`).join('')}</table>` : ''}
      <h4>${tr('物流中心 · 空箱堆场')}</h4>
      <p class="fc-kv"><span>${tr('空箱')}</span><b>${tr('{boxes}/{slots} 箱 {bar}', { boxes: l.depot.boxes, slots: l.depot.slots, bar: bar(l.depot.boxes, l.depot.slots) })}</b><span>${tr('正面吊')}</span><b>${tr('{stackers}/2 台在吊箱', { stackers: l.depot.stackers })}</b></p>
      <h4>${tr('物流中心 · 今天')}</h4>
      <table class="fc-t">${l.kpi.map((k) => `<tr><td>${esc(tx(k.label))}</td><td>${esc(kv(k.value))}</td></tr>`).join('')}</table>`;
  }

  private air(d: FacData, a: NonNullable<FacData['air']>): string {
    // 今天的航班：在场的（空中、跑道、滑行、机位上）和没到的按落地时刻排；已离场的只列最近 3 班
    const gone = a.flights.filter((f) => f.phase === 'gone');
    const shown = [...a.flights.filter((f) => f.phase !== 'gone'), ...gone.slice(0, 3)];
    const row = (f: AirInfo['flights'][number]) =>
      `<tr class="${f.phase === 'gone' ? 'fc-muted' : ''}"><td>${this.veh(a.vidOf(f.id), tx(f.id))}${f.own ? ` <span class="fc-muted">${tr('本店')}</span>` : ''}<div class="fc-muted">${esc(tx(f.kind ?? ''))}</div></td><td>${esc(tx(f.stand))}</td><td>${f.land !== undefined ? when(f.land) : '—'}<div class="fc-muted">${f.takeoff !== undefined ? when(f.takeoff) : '—'}</div></td><td>${esc(tx(f.status))}<div class="fc-muted">${tr('卸 {done}/{ulds} {bar}', { done: f.done, ulds: f.ulds, bar: bar(f.done, f.ulds) })}${f.load !== undefined ? ` ${tr('装 {loaded}/{load}', { loaded: f.loaded ?? 0, load: f.load })}` : ''}</div></td></tr>`;
    const fl = shown.length ? shown.map(row).join('') + (gone.length > 3 ? `<tr><td colspan="4" class="fc-muted">${tr('更早离场 {length} 班', { length: gone.length - 3 })}</td></tr>` : '') : `<tr><td colspan="4" class="fc-muted">${tr('今天没有货运航班')}</td></tr>`;
    const td = a.today;
    const now = (u: AirInfo['ulds'][number]) => [...u.steps].reverse().find((s) => s.t <= d.t);
    return `
      ${td ? `<p class="fc-kv"><span>${tr('今天')}</span><b>${tr('{flights} 班（本店 {own} 班）· 起降 {moves} 架次', { flights: td.flights, own: td.own, moves: td.moves })}${td.dropped ? ` ${tr('· {dropped} 班排不进', { dropped: td.dropped })}` : ''}</b><span>${tr('机位')}</span><b>${tr('{inUse}/{stands} 个有飞机 {bar}', { inUse: td.inUse, stands: td.stands, bar: bar(td.inUse, td.stands) })}</b></p>` : ''}
      <h4>${tr('货运航班')}</h4>
      <table class="fc-t"><tr><th>${tr('航班 · 机型')}</th><th>${tr('机位')}</th><th>${tr('落地 / 起飞')}</th><th>${tr('状态 · 集装板')}</th></tr>${fl}</table>
      <h4>${tr('本店的集装板')}</h4>
      <table class="fc-t"><tr><th>${tr('板号')}</th><th>${tr('现在')}</th></tr>${a.ulds.map((u) => `<tr><td class="mono">${esc(u.id)}</td><td>${esc(tx(now(u)?.text ?? tr('还在飞机上')))}${now(u) ? ` <span class="fc-muted">${clock((now(u) as { t: number }).t)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="2" class="fc-muted">—</td></tr>'}</table>
      <h4>${tr('机坪设备')}</h4>
      <table class="fc-t"><tr><th>${tr('设备')}</th><th>${tr('在干什么')}</th></tr>${a.equip.map((e) => `<tr><td><b>${esc(tx(e.id))}</b><div class="fc-muted">${esc(tx(e.kind))}</div></td><td>${esc(tx(e.now))}</td></tr>`).join('') || `<tr><td colspan="2" class="fc-muted">${tr('没有在场的航班')}</td></tr>`}</table>
      <p class="fc-kv"><span>${tr('货站里')}</span><b>${tr('{inside} 块板', { inside: a.terminal.inside })}</b><span>${tr('本店的板已进冷库')}</span><b>${tr('{storeReady} 块', { storeReady: a.terminal.storeReady })}</b>${a.terminal.exportOut !== undefined ? `<span>${tr('出口的板在板车上')}</span><b>${tr('{exportOut} 块', { exportOut: a.terminal.exportOut })}</b>` : ''}</p>
      ${a.terminal.term ? this.airTerm(d, a.terminal.term) : ''}`;
  }

  /** 货站（机场的仓储中心）：ETV 板架、拆组板、冷库和货架、陆侧收货口和排队、本店的板 */
  private airTerm(d: FacData, x: NonNullable<AirInfo['terminal']['term']>): string {
    void d;
    const busy = x.docks.filter((o) => o.truck);
    const next = x.docks.filter((o) => !o.truck && o.next).sort((p, q) => (p.next?.t ?? 0) - (q.next?.t ?? 0)).slice(0, 4);
    return `
      <h4>${tr('货站 · 仓储')}</h4>
      <p class="fc-kv"><span>${tr('ETV 板架')}</span><b>${tr('{used}/{slots} 块板 {bar}', { used: x.etv.used, slots: x.etv.slots, bar: bar(x.etv.used, x.etv.slots) })}</b><span>ETV</span><b>${tr('{cranesBusy}/{cranes} 台在搬', { cranesBusy: x.etv.cranesBusy, cranes: x.etv.cranes })}</b><span>${tr('拆组板工位')}</span><b>${tr('{busy}/{total} 个在干 {bar}', { busy: x.stations.busy, total: x.stations.total, bar: bar(x.stations.busy, x.stations.total) })}</b><span>${tr('等着拆的板')}</span><b class="${x.stations.backlog > 12 ? 'fc-bad' : ''}">${tr('{backlog} 块', { backlog: x.stations.backlog })}</b></p>
      <p class="fc-kv"><span>${tr('冷藏库 2–8 °C')}</span><b>${tr('{chill}/{chillCap} 板 {bar}', { chill: x.cold.chill, chillCap: x.cold.chillCap, bar: bar(x.cold.chill, x.cold.chillCap) })}</b><span>${tr('冷冻库 −18 °C')}</span><b>${tr('{frozen}/{frozenCap} 板 {bar}', { frozen: x.cold.frozen, frozenCap: x.cold.frozenCap, bar: bar(x.cold.frozen, x.cold.frozenCap) })}</b>${x.stores.map((s) => `<span>${esc(tx(s.label))}</span><b>${tr('{used}/{cap} 板', { used: s.used, cap: s.cap })}</b>`).join('')}</p>
      <h4>${tr('陆侧收货口（{length}/{length2} 樘有车 · 排队 {queue} 辆）', { length: busy.length, length2: x.docks.length, queue: x.queue })}</h4>
      <table class="fc-t"><tr><th>${tr('门')}</th><th>${tr('车')}</th><th>${tr('走')}</th></tr>${busy.map((o) => `<tr><td><b>${esc(tx(o.id))}</b></td><td>${esc(cut(o.truck ?? '', 22))}</td><td>${o.until !== undefined ? clock(o.until) : ''}</td></tr>`).join('') || `<tr><td colspan="3" class="fc-muted">${tr('此刻没有车靠台')}</td></tr>`}${next.map((o) => `<tr class="fc-muted"><td>${esc(tx(o.id))}</td><td>${tr('下一辆')} ${esc(cut(o.next?.label ?? '', 18))}</td><td>${clock(o.next?.t ?? 0)}</td></tr>`).join('')}</table>
      <h4>${tr('本店的板在货站里')}</h4>
      <table class="fc-t">${x.own.map((o) => `<tr><td class="mono">${esc(tx(o.id))}</td><td>${esc(tx(o.now))} <span class="fc-muted">${clock(o.t)}</span></td></tr>`).join('') || `<tr><td colspan="2" class="fc-muted">${tr('今天货站里没有本店的板')}</td></tr>`}</table>
      <p class="fc-muted">${tr('今天：进口板 {uldIn} 块、出口板 {uldOut} 块，陆侧 {trucks} 车次', { uldIn: x.today.uldIn, uldOut: x.today.uldOut, trucks: x.today.trucks })}</p>`;
  }

  private dc(d: FacData, dd: NonNullable<FacData['dc']>): string {
    void d;
    const x = dd.info;
    const busy = x.doors.filter((o) => o.vid !== undefined);
    const cell = (o: DcInfo['doors'][number]) => `<span class="fc-door ${!o.open ? 'closed' : o.vid !== undefined ? (o.mode === '装车' ? 'load' : 'unload') : ''}${o.cold ? ' cold' : ''}" title="${esc(tx(o.id))}${!o.open ? ` ${tr('· 停用（设施管理里关了）')}` : o.vid !== undefined ? ` · ${esc(tx(o.label ?? ''))} · ${esc(tx(o.mode ?? ''))} ${o.done}/${o.n}` : o.next ? ` ${tr('· 下一辆 {t} {label}', { t: clock(o.next.t), label: esc(tx(o.next.label)) })}` : ` ${tr('· 空闲')}`}"${o.vid !== undefined ? ` data-vid="${o.vid}"` : ''}>${esc(tx(o.id))}</span>`;
    const next = x.doors.filter((o) => o.next && o.vid === undefined).sort((a, b) => (a.next?.t ?? 0) - (b.next?.t ?? 0)).slice(0, 5);
    return `
      <p class="fc-kv"><span>${tr('今天靠台')}</span><b>${tr('装车 {load} 车 · 卸货 {unload} 车 · {pallets} 板', { load: x.trucksToday.load, unload: x.trucksToday.unload, pallets: x.trucksToday.pallets })}</b><span>${tr('配送中心库存')}</span><b>${dd.dcDays !== undefined ? tr('{dcDays} 天', { dcDays: dd.dcDays.toFixed(1) }) : '—'}</b></p>
      <h4>${tr('月台门（干货 D01–D26、冷链 C01–C12）')}</h4>
      <div class="fc-doors">${x.doors.map(cell).join('')}</div>
      <p class="fc-legend"><i class="load"></i>${tr('装车')} <i class="unload"></i>${tr('卸货')} <i></i>${tr('空闲')} <i class="closed"></i>${tr('停用')}</p>
      <table class="fc-t"><tr><th>${tr('门')}</th><th>${tr('车')}</th><th>${tr('作业')}</th><th>${tr('进度')}</th><th>${tr('预计走')}</th></tr>${busy.map((o) => `<tr><td><b>${esc(tx(o.id))}</b></td><td>${this.veh(o.vid)}</td><td>${esc(tx(o.mode ?? ''))}</td><td>${o.done}/${o.n} ${bar(o.done ?? 0, o.n ?? 1)}</td><td>${o.until !== undefined ? clock(o.until) : '—'}</td></tr>`).join('') || `<tr><td colspan="5" class="fc-muted">${tr('此刻没有车靠台')}</td></tr>`}</table>
      ${next.length ? `<h4>${tr('接下来靠台')}</h4><table class="fc-t">${next.map((o) => `<tr><td><b>${esc(tx(o.id))}</b></td><td>${clock(o.next?.t ?? 0)}</td><td>${esc(tx(o.next?.mode ?? ''))}</td><td>${esc(cut(o.next?.label ?? '', 16))}</td></tr>`).join('')}</table>` : ''}
      <h4>${tr('库内')}</h4>
      <p class="fc-kv"><span>${tr('发货暂存道')}</span><b>${tr('{out} 板备好待装', { out: x.staged.out })}</b><span>${tr('收货暂存道')}</span><b>${tr('{in} 板待入库', { in: x.staged.in })}</b><span>${tr('立体库堆垛机')}</span><b>${tr('{cranesBusy}/{cranes} 台在作业 {bar}', { cranesBusy: x.cranesBusy, cranes: x.cranes, bar: bar(x.cranesBusy, x.cranes) })}</b><span>${tr('货到人机器人')}</span><b>${tr('{amrBusy}/{amrTotal} 台在搬货架 {bar}', { amrBusy: x.amrBusy, amrTotal: x.amrTotal, bar: bar(x.amrBusy, x.amrTotal) })}</b></p>
      ${x.yard ? this.parkYard(x.yard) : ''}
      ${dd.rail.map((r) => this.rail(r)).join('')}`;
  }

  /** 物流园的场地：门口、待命停车场、甩挂区、铁路转运仓的门、短驳车和场内牵引车、本店的铁路箱 */
  private parkYard(y: ParkYardInfo): string {
    const fmt = (v: number) => (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('zh-CN') : v.toFixed(1));
    const door = (o: ParkYardInfo['doors'][number]) => `<span class="fc-door ${o.who ? (o.kind === 'load' || o.kind === 'drop' ? 'load' : 'unload') : ''}" title="${esc(tx(o.id))}${o.who ? ` · ${esc(tx(o.who))}${o.until !== undefined ? ` ${tr('· 到 {until}', { until: clock(o.until) })}` : ''}` : o.next ? ` ${tr('· 下一个 {t} {who}', { t: clock(o.next.t), who: esc(tx(o.next.who)) })}` : ` ${tr('· 空闲')}`}">${esc(tx(o.id))}</span>`;
    return `
      <h4>${tr('园区场地')}</h4>
      <p class="fc-kv"><span>${tr('门外排队登记')}</span><b>${tr('{gateQueue} 车', { gateQueue: y.gateQueue })}</b><span>${tr('待命停车场')}</span><b>${tr('{length}/{holdCap} 个车位 {bar}', { length: y.holding.length, holdCap: y.holdCap, bar: bar(y.holding.length, y.holdCap) })}</b><span>${tr('甩挂区')}</span><b>${tr('{dropCount}/{dropCap} 个车位（装好待取 {dropLoaded}）{bar}', { dropCount: y.dropCount, dropCap: y.dropCap, dropLoaded: y.dropLoaded, bar: bar(y.dropCount, y.dropCap) })}</b><span>${tr('转运仓暂存道')}</span><b>${tr('{staged} 板', { staged: y.staged })}</b></p>
      ${y.holding.length ? `<table class="fc-t"><tr><th>${tr('在等门的车')}</th><th>${tr('车位')}</th><th>${tr('去门上')}</th></tr>${y.holding.map((h) => `<tr><td>${esc(cut(h.label, 18))}</td><td>${esc(tx(h.stall))}</td><td>${clock(h.until)}</td></tr>`).join('')}</table>` : ''}
      <h4>${tr('铁路转运仓（拆箱门 TB、装卸门 TT）')}</h4>
      <div class="fc-doors">${y.doors.map(door).join('')}</div>
      <table class="fc-t"><tr><th>${tr('场内的车')}</th><th>${tr('在干什么')}</th></tr>${y.shuttles.map((s) => `<tr><td><b>${esc(tx(s.label))}</b></td><td>${esc(tx(s.now))}</td></tr>`).join('')}</table>
      ${y.own.length ? `<h4>${tr('本店的铁路箱')}</h4><table class="fc-t"><tr><th>${tr('箱号')}</th><th>${tr('现在')}</th></tr>${y.own.map((b) => `<tr><td class="mono">${esc(b.id)}</td><td>${esc(tx(b.now))}</td></tr>`).join('')}</table>` : ''}
      <h4>${tr('今天的场地')}</h4>
      <table class="fc-t">${y.kpi.map((k) => `<tr><td>${esc(tx(k.label))}</td><td>${isEn() ? esc(kv(`${fmt(k.value)} ${k.unit}`)).replace(/^[\d.,]+/, (m) => `<b>${m}</b>`) : `<b>${fmt(k.value)}</b> ${esc(tx(k.unit))}`}</td></tr>`).join('')}</table>
      <p class="fc-muted">${y.notes.map((s) => esc(tx(s))).join(' ')}</p>`;
  }

  private store(s: NonNullable<FacData['store']>): string {
    const docks = s.docks.docks.map((o) => `<tr><td><b>${esc(tx(o.id))}</b></td><td>${o.vid !== undefined ? this.veh(o.vid) : `<span class="fc-muted">${tr('空闲')}</span>`}</td><td>${o.vid !== undefined ? `${tr('卸货 {done}/{n}', { done: o.done, n: o.n })} ${bar(o.done ?? 0, o.n ?? 1)}` : o.next ? tr('下一辆 {t}', { t: clock(o.next.t) }) : '—'}</td><td>${o.until !== undefined ? clock(o.until) : ''}</td></tr>`).join('');
    const del = s.deliveries.map((x) => `<tr class="${x.late ? 'fc-bad' : ''}"><td>${this.veh(x.vid, x.id)}</td><td>${clock(x.plan)}</td><td>${x.eta !== undefined ? clock(x.eta) : '—'}</td><td>${esc(tx(x.status))}</td><td>${x.pallets}</td></tr>`).join('');
    const stock = s.stock.map((x) => `<tr><td>${esc(tx(x.label))}</td><td>${Math.round(x.units).toLocaleString('zh-CN')}</td><td>${x.est !== undefined ? Math.round(x.est).toLocaleString('zh-CN') : '—'}</td><td class="${x.days !== undefined && x.days < 0.8 ? 'fc-bad' : ''}">${x.days !== undefined ? x.days.toFixed(1) : '—'}</td></tr>`).join('');
    const si = s.docks.site;
    const lotHtml = si
      ? `<h4>${tr('停车场与即时取货')}</h4>
      <p class="fc-kv"><span>${tr('普通车位')}</span><b>${si.front.used}/${si.front.total} ${bar(si.front.used, si.front.total)}</b><span>${tr('员工车位')}</span><b>${si.staff.used}/${si.staff.total}</b><span>${tr('即时取货车位')}</span><b>${si.pickup.used}/${si.pickup.total}</b><span>${tr('免下车取货')}</span><b>${si.drive.used}/${si.drive.total}${si.drive.waiting ? ` ${tr('· 车道口等 {waiting} 辆', { waiting: si.drive.waiting })}` : ''}</b><span>${tr('今天取货')}</span><b>${tr('{pickups} 车 · 平均等 {waitMean} 分钟', { pickups: si.pickups, waitMean: si.waitMean.toFixed(1) })}</b><span>${tr('5 分钟内交付')}</span><b class="${si.within5 < 90 ? 'fc-bad' : ''}">${Math.round(si.within5)}%</b></p>
      <h4>${tr('收货场')}</h4>
      <p class="fc-kv"><span>${tr('布置')}</span><b>${esc(tx(si.yardLevel))}</b><span>${tr('此刻排队')}</span><b class="${si.yardQueue > 1 ? 'fc-bad' : ''}">${tr('{yardQueue} 辆', { yardQueue: si.yardQueue })}</b><span>${tr('今天最多排队')}</span><b>${tr('{yardQueueMax} 辆', { yardQueueMax: si.yardQueueMax })}</b><span>${tr('货车平均周转')}</span><b>${si.turnMean ? tr('{turnMean} 分钟', { turnMean: si.turnMean.toFixed(0) }) : '—'}</b></p>${si.yardNotes.length ? `<p class="fc-muted">${si.yardNotes.map((s) => esc(tx(s))).join(isEn() ? '; ' : '；')}</p>` : ''}`
      : '';
    return `
      <p class="fc-kv"><span>${tr('门店库存')}</span><b>${s.days !== undefined ? tr('{days} 天', { days: s.days.toFixed(2) }) : '—'}</b><span>${tr('今天到现在的缺货')}</span><b>${s.lost !== undefined ? tr('{lost} 件', { lost: Math.round(s.lost).toLocaleString('zh-CN') }) : '—'}</b><span>${tr('线上配送')}</span><b>${tr('在外 {out} 车 · 送完 {done}/{total}', { out: s.vans.out, done: s.vans.done, total: s.vans.total })}</b></p>${lotHtml}
      <h4>${tr('收货口')}</h4>
      <table class="fc-t"><tr><th>${tr('口')}</th><th>${tr('车')}</th><th>${tr('进度')}</th><th>${tr('预计走')}</th></tr>${docks}</table>
      <h4>${tr('今天的到货（{length} 车 · {pallets} 板）', { length: s.deliveries.length, pallets: s.docks.pallets })}</h4>
      <table class="fc-t"><tr><th>${tr('车')}</th><th>${tr('计划到')}</th><th>${tr('预计 / 实到')}</th><th>${tr('状态')}</th><th>${tr('板')}</th></tr>${del || '<tr><td colspan="5" class="fc-muted">—</td></tr>'}</table>
      <h4>${tr('各商品族库存')}</h4><p class="fc-muted">${esc(tx(s.stockNote))}</p>
      <table class="fc-t"><tr><th>${tr('商品族')}</th><th>${tr('现场（件）')}</th><th>${tr('孪生估计')}</th><th>${tr('够卖（天）')}</th></tr>${stock || `<tr><td colspan="4" class="fc-muted">${tr('运行后显示')}</td></tr>`}</table>`;
  }
}
