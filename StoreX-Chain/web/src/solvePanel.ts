import './solve.css';
import { STORES } from '../../src/region/network';
import { FAMILIES } from '../../src/region/products';
import { DOORS, RECEIVING_DOORS, UNIT_LABEL, type Board, type UnitClass } from '../../src/sim/board';
import { GEN_LABEL, scenarioFor, type Gen } from '../../src/sim/config';
import { DEFAULT_OPTIONS, demandFromBoard, doorScore, solveDoors, solveFleet, solveReplen, type DoorSolution, type DoorStats, type FleetSolution, type FleetStats, type ReplenSolution, type SolverOptions } from '../../src/sim/optimize';
import type { DayPlan } from '../../src/sim/plan';
import { isEn, t, tx } from './i18n';

/**
 * 调度台的「求解」页：月台门、车辆、门店补货三个优化问题，和现在的排法并排比，逐条说明改了什么、为什么；
 * 门和车点「采用」就写进当天调度（指定门 / 指定车，不用重新仿真），补货只给建议。约束改了马上重算，存在本机浏览器里。
 */
const KEY = 'storex-chain-solver';
export function loadOptions(): SolverOptions {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return { ...DEFAULT_OPTIONS, ...(JSON.parse(s) as Partial<SolverOptions>) };
  } catch {
    /* 读不了（隐私模式）就用默认 */
  }
  return { ...DEFAULT_OPTIONS };
}
export function saveOptions(o: SolverOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* 存不了也照样用 */
  }
}

/** 调度台最近一次的计划（设施管理台的排班求解借它算物流园和门店的作业量） */
export interface SharedPlan {
  board: Board;
  day: DayPlan;
  genLabel: string;
  /** 最早几点能发车（小时）；分配库存的时刻（不给就按最早发车推：全链路早半小时，前两代前一晚 23 点） */
  earliest: number;
  allocation?: number;
  /** 门店每个商品族每天的需求（件）；不给就按当天送到门店的量估 */
  storeDemand?: Record<string, number>;
}
let shared: SharedPlan | undefined;
export const sharePlan = (p: SharedPlan): void => {
  shared = p;
};
export const sharedPlan = (): SharedPlan | undefined => shared;
export const allocationOf = (p: SharedPlan): number => p.allocation ?? (p.earliest > 0 ? p.earliest - 0.5 : 23);
export const genOf = (p: SharedPlan): Gen => (Object.keys(GEN_LABEL) as Gen[]).find((g) => GEN_LABEL[g] === p.genLabel) ?? 'g3';
/**
 * 门店每个商品族每天卖多少件。没有仿真的需求数据时按当天送到门店的量估：隔几天送一次的商品族这一车装的是几天的量（除以天数），
 * 今天没送到的商品族按送到的那些占全部需求的比例推。
 */
export function storeDemandOf(p: SharedPlan): Record<string, number> {
  if (p.storeDemand) return p.storeDemand;
  const sc = scenarioFor(genOf(p));
  const st = STORES[0];
  const group = st && st.id % 2 !== 0 ? 'B' : 'A';
  const raw = demandFromBoard(p.board, st?.key ?? 'S01');
  const out: Record<string, number> = {};
  let mu = 0;
  let share = 0;
  for (const f of FAMILIES) {
    const u = raw[f.key] ?? 0;
    if (u <= 0 || sc.flow.direct.includes(f.key)) continue;
    const days = f.source === 'bakery' ? 7 : sc.store.deliveryDays[f.temp][group].length;
    out[f.key] = u / Math.max(1, Math.round(7 / Math.max(1, days)));
    mu += out[f.key] as number;
    share += f.share;
  }
  if (share > 0) for (const f of FAMILIES) if (out[f.key] === undefined && !sc.flow.direct.includes(f.key)) out[f.key] = (mu / share) * f.share;
  return out;
}
/** 门店每天一共卖多少件：没有需求数据时，按配送中心送到的量和这些商品族占全部需求的比例推 */
export function storeSalesOf(p: SharedPlan): number {
  if (p.storeDemand) return Object.values(p.storeDemand).reduce((a, x) => a + x, 0);
  const direct = scenarioFor(genOf(p)).flow.direct;
  const share = FAMILIES.filter((f) => !direct.includes(f.key)).reduce((a, f) => a + f.share, 0);
  return Object.values(storeDemandOf(p)).reduce((a, x) => a + x, 0) / Math.max(0.05, share);
}

export interface SolveHost {
  onDay(day: DayPlan, rerun: boolean): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const n1 = (x: number) => x.toFixed(1);
/** 一格比较：数值、和现在比好还是坏（越小越好） */
function cell(v: number, base: number, fmt: (x: number) => string = (x) => String(Math.round(x))): string {
  const cls = Math.abs(v - base) < 1e-9 ? '' : v < base ? 'good' : 'bad';
  return `<td class="num ${cls}">${fmt(v)}</td>`;
}
const unitsText = (by: Partial<Record<UnitClass, number>>) =>
  Object.entries(by)
    .map(([c, n]) => `${UNIT_LABEL[c as UnitClass]} ${n}`)
    .join('、') || '—';
/** 求解器给的说明句（中文）：英文界面整句查字典，剩下的全角标点（车次后面的「（05:30–07:10）」、门号之间的「、」）换成半角 */
const rt = (s: string) =>
  isEn()
    ? tx(s)
        .replace(/（/g, ' (')
        .replace(/）/g, ')')
        .replace(/、/g, ', ')
        .replace(/：/g, ': ')
        .replace(/；/g, '; ')
        .replace(/，/g, ', ')
        .replace(/ {2,}/g, ' ')
    : s;
/** 派车的说明是一串「车次 → 回场后 N 分钟接 → 车次」：英文界面逐段翻（整串查字典嵌套太深） */
const chain = (s: string) => (isEn() ? s.split(' → ').map(rt).join(' → ') : s);

export class SolvePanel {
  private plan: SharedPlan | undefined;
  private opts = loadOptions();
  private res: { doors: DoorSolution; fleet: FleetSolution; replen: ReplenSolution } | undefined;
  private stale = true;
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private more = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly host: SolveHost,
  ) {
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const k = el.dataset.opt as keyof SolverOptions | undefined;
      if (!k) return;
      const o = { ...this.opts } as Record<string, number | boolean>;
      if (el.type === 'checkbox') o[k] = el.checked;
      else {
        const v = Number(el.value);
        if (!Number.isFinite(v)) return;
        o[k] = Math.max(Number(el.min || -Infinity), Math.min(Number(el.max || Infinity), v));
      }
      this.opts = o as unknown as SolverOptions;
      saveOptions(this.opts);
      this.stale = true;
      this.schedule();
    });
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el || !this.res || !this.plan) return;
      const act = el.dataset.act;
      if (act === 'apply-doors') this.host.onDay(this.res.doors.day, false);
      if (act === 'apply-fleet') this.host.onDay(this.res.fleet.day, false);
      if (act === 'apply-both') {
        // 门和车一起：在求解门的结果上再指定车
        const d = this.res.doors.day;
        const f = this.res.fleet.day;
        this.host.onDay({ depart: d.depart, arrive: d.arrive, door: d.door, unit: f.unit }, false);
      }
      if (act === 'more') {
        const k = el.dataset.k as string;
        if (this.more.has(k)) this.more.delete(k);
        else this.more.add(k);
        this.render();
      }
      if (act === 'reset-opts') {
        this.opts = { ...DEFAULT_OPTIONS };
        saveOptions(this.opts);
        this.stale = true;
        this.schedule();
      }
    });
  }

  get options(): SolverOptions {
    return this.opts;
  }

  setPlan(p: SharedPlan): void {
    this.plan = p;
    this.stale = true;
    if (this.visible) this.schedule();
  }

  show(on: boolean): void {
    this.visible = on;
    if (on && (this.stale || !this.res)) this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.renderShell(t('正在求解…'));
    this.timer = setTimeout(() => this.solve(), 20);
  }

  private solve(): void {
    const p = this.plan;
    if (!p) return;
    const allocation = allocationOf(p);
    const gen = genOf(p);
    const doors = solveDoors(p.board, p.day, allocation, this.opts);
    const fleet = solveFleet(p.board, p.day, allocation, this.opts);
    const st = STORES[0];
    // 车队每天能装的托盘：当天从配送中心发往门店的车次 × 每车的托盘数
    const truck = p.board.ops.filter((o) => o.kind === 'delivery').reduce((a, o) => a + (o.cap ?? 24), 0);
    const replen = solveReplen(gen, storeDemandOf(p), scenarioFor(gen).flow.direct, this.opts, st && st.id % 2 !== 0 ? 'B' : 'A', truck || Infinity);
    this.res = { doors, fleet, replen };
    this.stale = false;
    this.render();
  }

  private renderShell(status: string): void {
    if (!this.root.querySelector('.sv')) this.root.innerHTML = `<div class="sv"><div class="sv-top" id="sv-top"></div><div id="sv-body"></div></div>`;
    const top = this.root.querySelector('#sv-top') as HTMLElement;
    top.innerHTML = `${this.optsHtml()}<span class="note sv-status">${esc(status)}</span>`;
  }

  private optsHtml(): string {
    const o = this.opts;
    const num = (k: keyof SolverOptions, min: number, max: number, step: number) => `<input type="number" data-opt="${k}" min="${min}" max="${max}" step="${step}" value="${o[k] as number}">`;
    const chk = (k: keyof SolverOptions) => `<input type="checkbox" data-opt="${k}"${o[k] ? ' checked' : ''}>`;
    return `<p class="note sv-intro">${t('把排门、派车、门店补货写成优化问题：按下面的约束求出最优解（求不到最优时给出离最优还差多少），和调度台现在的排法并排比，逐条说明改了什么、省了什么。默认仍按原来的自动排法；点「采用」才把门和车写进当天调度（不用重新仿真）。')}</p>
      <details class="sv-opts"><summary>${t('约束')}</summary><div class="sv-opt-grid">
        <label>${t('{chk} 收货门优先给进货车、发货门优先给配送车', { chk: chk('rolePreference') })}</label>
        <label>${t('{chk} 保留调度员已经指定的门和车', { chk: chk('keepFixed') })}</label>
        <label>${t('司机一个班最长 {v1} 小时（超过要两位司机接力）', { v1: num('maxDutyHours', 6, 14, 0.5) })}</label>
        <label>${t('电动车续航 {v1} 公里，配送中心充电每小时 {v2} 公里', { v1: num('evRangeKm', 40, 600, 10), v2: num('evChargeKmPerHour', 20, 400, 10) })}</label>
        <label>${t('每补一次货的固定成本 ${v1}（拣货准备、收货核对、单据）', { v1: num('orderCost', 0, 50, 0.5) })}</label>
        <label>${t('货架和后仓最多比现在多用 {v1}%', { v1: num('extraSpacePct', 0, 50, 5) })}</label>
        <p class="note">${t('冷链门只给冷链车、同一樘门前后两车留 5 分钟、车回场 30 分钟后才能再出车，是调度台本身的规则。排班的约束（加班单价、最多加班、余量、每班最少人数）在设施管理台的「按作业量排班」里。')}<button class="chip" data-act="reset-opts">${t('恢复默认')}</button></p>
      </div></details>`;
  }

  private render(): void {
    const r = this.res;
    if (!r) return;
    const ms = r.doors.ms + r.fleet.ms + r.replen.ms;
    this.renderShell(t('求解用时 {ms} 毫秒', { ms: Math.round(ms) }));
    const body = this.root.querySelector('#sv-body') as HTMLElement;
    const d = r.doors;
    const f = r.fleet;
    const p = r.replen;
    const doorGain = doorScore(d.realized) < doorScore(d.baseline);
    const fleetGain = f.changes.length > 0 && JSON.stringify(f.day.unit) !== JSON.stringify(this.plan?.day.unit ?? {});
    const tiles = [
      [t('月台门'), t('{overlapMin} → {overlapMin2} 分钟', { overlapMin: d.baseline.overlapMin + d.baseline.waitMin + d.baseline.preloadMin, overlapMin2: d.realized.overlapMin + d.realized.waitMin + d.realized.preloadMin }), t('挤门 + 排队 + 提前装车（落到调度台以后）')],
      [t('车辆'), t('{units} → {units2} 辆 · 空等 {n1} → {n12} 小时', { units: f.baseline.units, units2: f.stats.units, n1: n1(f.baseline.idleH), n12: n1(f.stats.idleH) }), t('每天 {cost} → {cost2}（车 + 司机）', { cost: usd(f.baseline.cost), cost2: usd(f.stats.cost) })],
      [t('门店补货'), t('每天 {totalCur} → {totalOpt}', { totalCur: usd(p.totalCur), totalOpt: usd(p.totalOpt) }), t('换一组需求核对：{checkCur} → {checkOpt}', { checkCur: usd(p.checkCur), checkOpt: usd(p.checkOpt) })],
    ];
    body.innerHTML = `
      <div class="sv-tiles">${tiles.map(([k, v, s]) => `<div class="sv-tile"><div class="k">${k}</div><div class="v">${esc(v as string)}</div><div class="s">${esc(s as string)}</div></div>`).join('')}</div>
      ${doorGain && fleetGain ? `<div class="sv-acts"><button class="primary" data-act="apply-both">${t('门和车都按求解结果排')}</button></div>` : ''}
      ${this.doorsHtml(d)}
      ${this.fleetHtml(f)}
      ${this.replenHtml(p)}`;
  }

  private list(key: string, items: string[], empty: string): string {
    if (!items.length) return `<p class="note">${esc(empty)}</p>`;
    const open = this.more.has(key);
    const shown = open ? items : items.slice(0, 8);
    return `<ul class="sv-why">${shown.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${items.length > 8 ? `<button class="chip" data-act="more" data-k="${key}">${open ? t('收起') : t('还有 {length} 条', { length: items.length - 8 })}</button>` : ''}`;
  }

  private doorsHtml(d: DoorSolution): string {
    const rows: [string, (s: DoorStats) => number][] = [
      [t('两车挤一樘门（分钟）'), (s) => s.overlapMin],
      [t('在场地排队（分钟）'), (s) => s.waitMin],
      [t('提前装车（分钟）'), (s) => s.preloadMin],
      [t('收发门错用（次）'), (s) => s.mismatches],
      [t('用到的门（樘）'), (s) => s.doorsUsed],
    ];
    const optimal = d.groups.every((g) => g.optimal);
    const gap = d.groups.reduce((a, g) => a + Math.max(0, g.stats.waitMin + g.stats.preloadMin - g.lowerBoundMin), 0);
    const badge = optimal ? `<span class="sv-badge ok">${t('最优')}</span>` : `<span class="sv-badge gap">${t('离最优最多 {gap} 分钟', { gap })}</span>`;
    const curve = ['cold', 'dry']
      .map((g) => {
        const pts = d.curve.filter((c) => c.group === g);
        if (!pts.length) return '';
        return `<div class="sv-curve"><b>${g === 'cold' ? t('冷链') : t('干货')}${t('门')}</b>${pts.map((c) => `<span class="${c.minutes ? 'warn' : 'ok'}">${t('{doors} 樘 · {v2}{minutes} 分钟', { doors: c.doors, v2: c.optimal ? '' : '≤', minutes: c.minutes })}</span>`).join('')}</div>`;
      })
      .join('');
    const changed = doorScore(d.realized) < doorScore(d.baseline);
    const gapReal = d.realized.waitMin + d.realized.preloadMin - (d.stats.waitMin + d.stats.preloadMin);
    return `<section class="sv-card">
      <header><h3>${t('月台门')}</h3>${badge}<span class="note">${t('冷链 {length} 樘（收货门 {cold}）、干货 {length2} 樘（收货门 {dry}）· {reduce} 个靠台作业', { length: DOORS.cold.length, cold: RECEIVING_DOORS.cold, length2: DOORS.dry.length, dry: RECEIVING_DOORS.dry, reduce: d.groups.reduce((a, g) => a + g.jobs, 0) })}</span></header>
      <p class="sv-goal">${t('目标依次：不让两车挤一樘门 → 在场地排队和提前装车的分钟最少 → 收货门给进货车、发货门给配送车 → 用到的门最少。先用分支定界求每车挪多少（5 分钟一挡），再按状态记忆把车排到具体的门上。')}</p>
      <div class="table-wrap"><table class="sv-t sv-kpi"><thead><tr><th></th><th>${t('现在（自动排）')}</th><th>${t('求解')}</th><th>${t('落到调度台')}</th></tr></thead><tbody>
        ${rows.map(([label, g]) => `<tr><td>${label}</td><td class="num">${g(d.baseline)}</td>${cell(g(d.stats), g(d.baseline))}${cell(g(d.realized), g(d.baseline))}</tr>`).join('')}
      </tbody></table></div>
      ${gapReal > 0 ? `<p class="note">${t('调度台只能指定门、不能指定排队到几点：要挪的车交给自动排，落地后比求解多 {gapReal} 分钟。', { gapReal })}</p>` : ''}
      <h4>${t('开几樘门 → 最少挪多少（门够用时是 0）')}</h4>${curve || `<p class="note">${t('今天没有靠台作业。')}</p>`}
      <h4>${t('改了什么')}</h4>${this.list('doors', d.changes.map(rt), t('现在的排法已经是最优的，不用改。'))}
      <div class="sv-acts"><button class="primary" data-act="apply-doors"${changed ? '' : ' disabled'}>${t('采用这个排门')}</button><span class="note">${changed ? t('写进当天调度的「指定门」，三维和闭环孪生跟着变；可以在调度台「撤销当天改动」。') : t('没有可以改进的地方。')}</span></div>
    </section>`;
  }

  private fleetHtml(f: FleetSolution): string {
    const rows: [string, (s: FleetStats) => number, (x: number) => string][] = [
      [t('用车（辆）'), (s) => s.units, (x) => String(x)],
      [t('要两位司机接力的车'), (s) => s.relays, (x) => String(x)],
      [t('司机在配送中心空等（小时）'), (s) => s.idleH, n1],
      [t('司机工时（小时）'), (s) => s.driverH, n1],
      [t('每天车辆 + 司机成本'), (s) => s.cost, usd],
    ];
    const changed = f.changes.length > 0 && JSON.stringify(f.day.unit) !== JSON.stringify(this.plan?.day.unit ?? {});
    const badge = f.optimal ? `<span class="sv-badge ok">${t('最优')}</span>` : `<span class="sv-badge gap">${t('没搜完（用车不少于 {lowerBound} 辆）', { lowerBound: f.lowerBound })}</span>`;
    return `<section class="sv-card">
      <header><h3>${t('车辆')}</h3>${badge}<span class="note">${f.chains.reduce((a, c) => a + c.trips.length, 0)} ${t('趟配送 · 用车下界 {lowerBound} 辆（同一时刻在路上和回场间隔里的车次最多几趟）', { lowerBound: f.lowerBound })}</span></header>
      <p class="sv-goal">${t('目标依次：用车最少 → 接力最少 → 司机空等最少。同车型才能接，回场 30 分钟后才能再出车；电动车按续航 {evRangeKm} 公里、每小时充 {evChargeKmPerHour} 公里检查电量；一辆车从第一趟出发到最后一趟回场超过 {maxDutyHours} 小时要两位司机接力。分支定界精确求解。', { evRangeKm: this.opts.evRangeKm, evChargeKmPerHour: this.opts.evChargeKmPerHour, maxDutyHours: this.opts.maxDutyHours })}</p>
      <div class="table-wrap"><table class="sv-t sv-kpi"><thead><tr><th></th><th>${t('现在（自动派）')}</th><th>${t('求解')}</th></tr></thead><tbody>
        ${rows.map(([label, g, fmt]) => `<tr><td>${label}</td><td class="num">${fmt(g(f.baseline))}</td>${cell(g(f.stats), g(f.baseline), fmt)}</tr>`).join('')}
        <tr><td>${t('按车型')}</td><td>${esc(rt(unitsText(f.baseline.unitsBy)))}</td><td>${esc(rt(unitsText(f.stats.unitsBy)))}</td></tr>
      </tbody></table></div>
      ${f.infeasible.length ? `<p class="note bad">${t('排不进任何车的车次：{infeasible}（单趟超过电动车续航，或超过两班司机的工时）。', { infeasible: esc(f.infeasible.join(isEn() ? ', ' : '、')) })}</p>` : ''}
      <h4>${t('改了什么')}</h4>${this.list('fleet', f.changes.map(chain), t('现在的派车已经是最优的，不用改。'))}
      <div class="sv-acts"><button class="primary" data-act="apply-fleet"${changed ? '' : ' disabled'}>${t('采用这个派车')}</button><span class="note">${changed ? t('写进当天调度的「指定车」。') : t('没有可以改进的地方。')}</span></div>
    </section>`;
  }

  private replenHtml(p: ReplenSolution): string {
    const rows = p.rows
      .map((r) => {
        const pol = (k: number, z: number) => t('每 {k} 天 · {z}', { k, z: z.toFixed(2) });
        const moved = r.opt.k !== r.cur.k || Math.abs(r.opt.z - r.cur.z) > 1e-9;
        return `<tr class="${moved ? 'moved' : ''}"><td>${esc(tx(r.label))}</td><td class="num">${Math.round(r.demand).toLocaleString('en-US')}</td><td>${pol(r.cur.k, r.cur.z)}</td><td>${moved ? `<b>${pol(r.opt.k, r.opt.z)}</b>` : t('不变')}</td><td class="num">${r.curCost.coverDays.toFixed(2)} → ${r.optCost.coverDays.toFixed(2)}</td><td class="num">${r.curCost.lostUnits.toFixed(1)} / ${r.curCost.wasteUnits.toFixed(1)} → ${r.optCost.lostUnits.toFixed(1)} / ${r.optCost.wasteUnits.toFixed(1)}</td><td class="num">${usd(r.curCost.total)} → ${usd(r.optCost.total)}</td><td class="num">${usd(r.curCheck.total)} → ${usd(r.optCheck.total)}</td></tr>`;
      })
      .join('');
    return `<section class="sv-card">
      <header><h3>${t('门店补货')}</h3><span class="sv-badge ok">${t('最优（在候选做法里）')}</span><span class="note">${t('{length} 个经配送中心补货的商品族', { length: p.rows.length })}${p.direct.length ? t('；长途整车直送的 {length} 个按整车订，不在这里算', { length: p.direct.length }) : ''}</span></header>
      <p class="sv-goal">${t('每个商品族挑「几天补一次（1、2、3、4、7 天）× 安全系数（0.84–2.33）」，每种做法用一年的逐日模拟算持有、补货、缺货（丢的毛利）和报废（进价）成本；在订满时不多占货架和后仓（{capacity} 立方米{v2}）、最忙那天的配送车装得下（隔几天送一次的错开送货日）的条件下用多选背包挑出合计最省的组合，再换一组随机需求核对。', { capacity: p.capacity.toFixed(0), v2: this.opts.extraSpacePct ? t('，含多给的 {extraSpacePct}%', { extraSpacePct: this.opts.extraSpacePct }) : '' })}</p>
      <div class="table-wrap"><table class="sv-t sv-replen"><thead><tr><th>${t('商品族')}</th><th>${t('每天卖（件）')}</th><th>${t('现在：几天一次 · 安全系数')}</th><th>${t('求解')}</th><th>${t('平均库存（天）')}</th><th>${t('每天缺货 / 报废（件）')}</th><th>${t('每天成本')}</th><th>${t('核对')}</th></tr></thead><tbody>${rows}
        <tr class="sum"><td>${t('合计')}</td><td></td><td>${t('每天补 {ordersCur} 次', { ordersCur: p.ordersCur.toFixed(1) })}</td><td>${t('每天补 {ordersOpt} 次', { ordersOpt: p.ordersOpt.toFixed(1) })}</td><td colspan="2">${t('订满时占 {usedCur} → {usedOpt} 立方米；最忙那天送 {peakCur} → {peakOpt} 托', { usedCur: p.usedCur.toFixed(0), usedOpt: p.usedOpt.toFixed(0), peakCur: Math.round(p.peakCur), peakOpt: Math.round(p.peakOpt) })}${Number.isFinite(p.truckPallets) ? t('（车队每天装 {truckPallets} 托）', { truckPallets: Math.round(p.truckPallets) }) : ''}</td><td class="num">${usd(p.totalCur)} → ${usd(p.totalOpt)}</td><td class="num">${usd(p.checkCur)} → ${usd(p.checkOpt)}</td></tr>
      </tbody></table></div>
      <h4>${t('为什么这样改')}</h4>${this.list('replen', p.changes.map(rt), t('现在的补货规则已经是最省的。'))}
      ${this.plan?.storeDemand ? '' : `<p class="note">${t('需求按当天送到门店的量估（隔几天送一次的除以天数，今天没送的按比例推）。')}</p>`}
      <p class="note">${t('只给建议：门店的补货规则在仿真里，改了要重新仿真 18 周才能和报告比。这里的成本是简化的库存模型（持有成本按年 22%，缺货按毛利损失，报废按进价），和报告的口径一致，但不含配送车次的变化。')}</p>
    </section>`;
  }
}
