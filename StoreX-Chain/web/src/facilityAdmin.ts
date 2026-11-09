import { defaultFacilities, laborCost, minCrew, randomFacilities, RANGES, SHIFT_LABEL, SHIFTS, type Facilities, type Role, type Shift } from '../../src/facility/config';
import { activityFromBoard, coverage, solveStaffing, type Activity, type RolePlan, type StaffPlan } from '../../src/facility/staffing';
import { STORES } from '../../src/region/network';
import { loadOptions, saveOptions, sharedPlan, storeSalesOf } from './solvePanel';
import { facilityActivity, type FacilitySources } from './staffingData';
import { portCranes } from './three/ops/port';
import { isEn, t, tx } from './i18n';

/**
 * 设施管理台：和 Storewright 管门店一样，港口、机场、物流园、综合店的布局、设备和人员都能直接改——
 * 布局与设备（几台岸桥、每台配几辆集卡、板车几套、立体库几条巷道、开几樘月台门、门店规模和收货口……，设备可以停用检修）、
 * 人员排班（每个岗位早中夜三班各几个人，算每天的人工成本，人不够开设备的会提示），
 * 指标（当前方案下各设施的作业结果）。可以按编号随机生成一个设施或全部设施，也可以恢复默认。
 * 按作业量排班：按当天的计划算每个岗位每小时要几个人，求出成本最低的三班人数（和允许交接加班的方案），一键填进排班表（src/facility/staffing.ts）。
 * 「应用并重新仿真」把配置存到本机浏览器、重新载入页面：仿真、三维、调度台和监控面板都按新的设施来。
 */
export type FacKey = keyof Facilities;
const FAC_LABEL: Record<FacKey, string> = { port: t('港口'), airport: t('机场'), dc: t('物流园'), store: t('综合店') };

export interface AdminHost {
  /** 当前方案下某个设施的指标 */
  kpi: (f: FacKey) => { label: string; value: string; bad?: boolean }[];
  /** 应用新的设施配置（存起来、重新仿真） */
  apply: (f: Facilities) => void;
  /** 港口、机场的三维设施作业（排班求解从它们的计划里取每小时的作业量）；不给就只能求物流园和综合店 */
  sources?: () => FacilitySources;
}

interface Param {
  key: string;
  label: string;
  range: readonly [number, number];
  step?: number;
  note?: string;
}
const PARAMS: Record<FacKey, Param[]> = {
  port: [
    { key: 'berths', label: t('泊位（码头按泊位加长，一个留给本店班轮）'), range: RANGES.port.berths, note: t('个') },
    { key: 'ownCranes', label: t('本店班轮泊位的岸桥'), range: RANGES.port.ownCranes, note: t('台') },
    { key: 'otherCranes', label: t('别家的船每段泊位的岸桥'), range: RANGES.port.otherCranes, note: t('台') },
    { key: 'gang', label: t('每台岸桥配场内集卡'), range: RANGES.port.gang, note: t('辆') },
    { key: 'gateLanes', label: t('闸口车道（进、出各）'), range: RANGES.port.gateLanes, note: t('条') },
  ],
  airport: [
    { key: 'stands', label: t('货机机位（机坪按机位加长）'), range: RANGES.airport.stands, note: t('个') },
    { key: 'dollySets', label: t('每个机位的板车（牵引车 + 4 辆板车）'), range: RANGES.airport.dollySets, note: t('套') },
    { key: 'uldsPerFlight', label: t('每架货机卸的集装板'), range: RANGES.airport.uldsPerFlight, note: t('块') },
  ],
  dc: [
    { key: 'aisles', label: t('立体库巷道（每条一台堆垛机）'), range: RANGES.dc.aisles, note: t('条') },
    { key: 'amrs', label: t('货到人机器人'), range: RANGES.dc.amrs, step: 2, note: t('台') },
    { key: 'dryDoors', label: t('开放的干货月台门'), range: RANGES.dc.dryDoors, note: t('樘') },
    { key: 'coldDoors', label: t('开放的冷链月台门'), range: RANGES.dc.coldDoors, note: t('樘') },
    { key: 'railTracks', label: t('铁路货运站每段站台的装卸线'), range: RANGES.dc.railTracks, note: t('股') },
  ],
  store: [
    { key: 'size', label: t('规模（StoreX 门店的几倍：社区店 1、综合店 2.5、大卖场 4、超大卖场 5）'), range: RANGES.store.size, step: 0.5, note: t('倍') },
    { key: 'docks', label: t('收货口'), range: RANGES.store.docks, note: t('个') },
    { key: 'gondolas', label: t('百货卖场的货架排数'), range: RANGES.store.gondolas, note: t('排') },
    { key: 'backroom', label: t('后仓的货架排数'), range: RANGES.store.backroom, note: t('排') },
  ],
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
/** 指标的值（「12 车」「4 个」）：英文按字典翻，只有数字加「个」的写成数字。A metric value in the current language */
const kv = (v: string): string => (isEn() && /^[\d.,]+ 个$/.test(v) ? v.slice(0, -2) : tx(v));
/** 两段文字接在一起时英文中间要空格（中文不要） */
const sp = isEn() ? ' ' : '';

export class FacilityAdmin {
  private tab: FacKey = 'dc';
  private draft: Facilities;
  private seed = 1;
  /** 按作业量排班的结果（哪个设施的）、图上看哪个岗位 */
  private staffPlan: StaffPlan | undefined;
  private staffFor: FacKey | undefined;
  private staffRole: string | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: AdminHost,
    private current: Facilities,
  ) {
    this.draft = JSON.parse(JSON.stringify(current));
    root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const tb = el.closest<HTMLElement>('[data-ftab]');
      if (tb) {
        this.tab = tb.dataset.ftab as FacKey;
        this.render();
        return;
      }
      const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close' || el === root) this.close();
      if (act === 'random-one') {
        this.draft = randomFacilities(this.seedValue(), this.draft, this.tab);
        this.render();
      }
      if (act === 'random-all') {
        this.draft = randomFacilities(this.seedValue(), this.draft);
        this.render();
      }
      if (act === 'reset') {
        this.draft = defaultFacilities();
        this.render();
      }
      if (act === 'apply') this.host.apply(this.draft);
      if (act === 'staff-solve') this.solveStaff();
      if (act === 'staff-apply' && this.staffPlan && this.staffFor === this.tab) {
        for (const r of this.staffPlan.roles) {
          const role = (this.draft[this.tab].staff as Role[]).find((x) => x.key === r.key);
          if (role && !r.fixed) role.crew = { ...r.plain };
        }
        this.renderSide();
        this.renderSolve();
      }
      const row = el.closest<HTMLElement>('[data-staff-role]');
      if (row) {
        this.staffRole = row.dataset.staffRole;
        this.renderSolve();
      }
    });
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.param) {
        (this.draft[this.tab] as unknown as Record<string, number>)[el.dataset.param] = Number(el.value);
        this.render(el.dataset.param);
      }
      if (el.dataset.role && el.dataset.shift) {
        const role = (this.draft[this.tab].staff as Role[]).find((x) => x.key === el.dataset.role);
        if (role) role.crew[el.dataset.shift as Shift] = Math.max(0, Math.round(Number(el.value) || 0));
        this.renderSide();
      }
      if (el.dataset.down) {
        const f = this.draft[this.tab] as { down?: string[] };
        const set = new Set(f.down ?? []);
        if (el.checked) set.add(el.dataset.down);
        else set.delete(el.dataset.down);
        f.down = [...set];
        this.renderSide();
      }
      if (el.id === 'ad-seed') this.seed = Math.max(1, Math.round(Number(el.value) || 1));
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const k = el.dataset.sopt;
      if (!k) return;
      const o = loadOptions() as unknown as Record<string, number | boolean>;
      o[k] = el.type === 'checkbox' ? el.checked : Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) || 0));
      saveOptions(o as unknown as ReturnType<typeof loadOptions>);
      if (this.staffPlan && this.staffFor === this.tab) this.solveStaff();
    });
  }

  private seedValue(): number {
    this.seed = Math.max(1, Math.round(Number((this.root.querySelector('#ad-seed') as HTMLInputElement | null)?.value) || this.seed));
    return this.seed;
  }

  open(tab: FacKey, current: Facilities): void {
    this.tab = tab;
    this.current = current;
    this.draft = JSON.parse(JSON.stringify(current));
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** 设备清单（可以勾选检修停用的） */
  private equipment(): { id: string; label: string }[] {
    const d = this.draft;
    if (this.tab === 'port') return portCranes(d.port).map((c) => ({ id: c.id, label: c.label }));
    if (this.tab === 'dc') return [...Array.from({ length: d.dc.aisles }, (_, i) => ({ id: `SC${i + 1}`, label: t('堆垛机 SC{i}', { i: i + 1 }) })), ...Array.from({ length: Math.min(8, d.dc.amrs) }, (_, i) => ({ id: `AMR${i + 1}`, label: t('机器人 AMR{i}', { i: i + 1 }) }))];
    return [];
  }

  /** 排班的提示：开设备的岗位人数比设备少 */
  private warnings(): string[] {
    const d = this.draft;
    const w: string[] = [];
    if (this.tab === 'port') {
      // 岸桥按泊位排（本店班轮的泊位 + 别家的每个泊位）；泊位减少以后已经不存在的岸桥不算停用
      const ids = new Set(portCranes(d.port).map((c) => c.id));
      const cranes = ids.size - d.port.down.filter((x) => ids.has(x)).length;
      const qc = minCrew(d.port.staff, 'qc');
      if (qc < cranes) w.push(t('岸桥司机最少的一班 {qc} 人，岸桥 {cranes} 台：{cranes2} 台没人开（先保本店班轮）', { qc, cranes, cranes2: cranes - qc }));
      const tt = minCrew(d.port.staff, 'tt');
      const need = Math.min(cranes, qc) * d.port.gang;
      if (tt < need) w.push(t('场内集卡司机最少的一班 {tt} 人，需要 {need} 人：每台岸桥只能配 {max} 辆', { tt, need, max: Math.max(2, Math.floor(tt / Math.max(1, Math.min(cranes, qc)))) }));
    }
    if (this.tab === 'airport') {
      const n = d.airport.stands;
      const tug = minCrew(d.airport.staff, 'tug');
      if (tug < d.airport.dollySets * n) w.push(t('牵引车司机最少的一班 {tug} 人，{n} 个机位各 {dollySets} 套板车要 {dollySets2} 人：机位停满时每架只能开 {max} 套', { tug, n, dollySets: d.airport.dollySets, dollySets2: d.airport.dollySets * n, max: Math.max(1, Math.floor(tug / n)) }));
      const ld = minCrew(d.airport.staff, 'loader');
      if (ld === 0) w.push(t('有一班没有平台车司机：那一班落地的航班卸不了货'));
      else if (ld < n) w.push(t('平台车司机最少的一班 {ld} 人，机位 {n} 个：最多 {ld2} 架飞机同时卸装，其余的等（先保本店航班）', { ld, n, ld2: ld }));
      if (minCrew(d.airport.staff, 'fuel') === 0) w.push(t('有一班没有加油员：那一班落地的航班加不了油'));
    }
    if (this.tab === 'dc') {
      const fork = Math.min(...SHIFTS.map((s) => d.dc.staff.find((x) => x.key === 'fork')?.crew[s] ?? 0));
      if (fork < 4) w.push(t('叉车司机最少的一班只有 {fork} 人：几樘门同时作业时叉车要排队', { fork }));
    }
    if (this.tab === 'store') {
      const recv = d.store.staff.find((x) => x.key === 'recv');
      if (recv && recv.crew.early < Math.ceil(d.store.docks / 2)) w.push(t('早班收货员 {early} 人，收货口 {docks} 个：同时到两三辆车时要等', { early: recv.crew.early, docks: d.store.docks }));
    }
    return w;
  }

  private render(focus?: string): void {
    const d = this.draft;
    const f = d[this.tab] as unknown as Record<string, number>;
    const tabs = (Object.keys(FAC_LABEL) as FacKey[]).map((k) => `<button data-ftab="${k}" aria-pressed="${k === this.tab}">${FAC_LABEL[k]}</button>`).join('');
    const params = PARAMS[this.tab]
      .map((p) => {
        const v = f[p.key] as number;
        const changed = v !== ((this.current[this.tab] as unknown as Record<string, number>)[p.key] as number);
        return `<label class="ad-param${changed ? ' changed' : ''}"><span>${esc(tx(p.label))}</span><input type="range" data-param="${p.key}" min="${p.range[0]}" max="${p.range[1]}" step="${p.step ?? 1}" value="${v}"><b>${v} ${p.note ?? ''}</b></label>`;
      })
      .join('');
    const eq = this.equipment();
    const down = new Set((d[this.tab] as { down?: string[] }).down ?? []);
    this.root.innerHTML = `
      <div class="ad-box" role="dialog" aria-label="${t('设施管理')}">
        <header class="ad-head">
          <b>${t('设施管理')}</b>
          <div class="tk-filters ad-tabs">${tabs}</div>
          <span class="ad-tools">${t('编号')} <input id="ad-seed" type="number" min="1" max="99999" value="${this.seed}"><button class="chip" data-act="random-one" title="${t('按这个编号随机生成当前这个设施的布局、设备和人员')}">${t('随机生成{fac}', { fac: FAC_LABEL[this.tab] })}</button><button class="chip" data-act="random-all" title="${t('四个设施一起随机')}">${t('全部随机')}</button><button class="chip" data-act="reset">${t('恢复默认')}</button><button class="primary" data-act="apply">${t('应用并重新仿真')}</button><button class="tk-min" data-act="close" title="${t('关闭')}">✕</button></span>
        </header>
        <div class="ad-grid">
          <section><h4>${t('布局与设备')}</h4>${params}${eq.length ? `<h5>${t('检修停用（勾上的设备不排作业）')}</h5><div class="ad-eq">${eq.map((x) => `<label><input type="checkbox" data-down="${x.id}"${down.has(x.id) ? ' checked' : ''}> ${esc(tx(x.label))}</label>`).join('')}</div>` : ''}</section>
          <section><h4>${t('人员排班')}</h4><div id="ad-staff"></div></section>
          <section><h4>${t('指标（当前方案）')}</h4><div id="ad-kpi"></div></section>
          <section class="ad-solve" id="ad-solve"></section>
        </div>
      </div>`;
    this.renderSide();
    this.renderSolve();
    if (focus) (this.root.querySelector(`[data-param="${focus}"]`) as HTMLInputElement | null)?.focus();
  }

  private renderSide(): void {
    const staff = this.draft[this.tab].staff as Role[];
    const rows = staff.map((r) => `<tr><td>${esc(tx(r.label))}${r.drives ? `<div class="fc-muted">${t('开{drives}', { drives: esc(tx(r.drives)) })}</div>` : ''}</td>${SHIFTS.map((s) => `<td><input type="number" min="0" max="200" data-role="${r.key}" data-shift="${s}" value="${r.crew[s]}"></td>`).join('')}<td class="fc-muted">${t('${wage}/时', { wage: r.wage })}</td></tr>`).join('');
    const cost = laborCost(staff);
    const cost0 = laborCost(this.current[this.tab].staff as Role[]);
    const warn = this.warnings();
    const staffEl = this.root.querySelector('#ad-staff');
    if (staffEl) staffEl.innerHTML = `<table class="fc-t ad-staff"><tr><th>${t('岗位')}</th>${SHIFTS.map((s) => `<th>${tx(SHIFT_LABEL[s])}</th>`).join('')}<th>${t('工资')}</th></tr>${rows}</table>
      <p class="fc-kv"><span>${t('每天人工')}</span><b>${usd(cost)}${cost !== cost0 ? sp + t('（现在 {cost0}，{v2}{cost}）', { cost0: usd(cost0), v2: cost > cost0 ? '+' : '', cost: usd(cost - cost0) }) : ''}</b><span>${t('每天工时')}</span><b>${staff.reduce((a, x) => a + 8 * (x.crew.early + x.crew.late + x.crew.night), 0)} ${t('小时')}</b></p>
      ${warn.length ? `<ul class="ad-warn">${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : `<p class="fc-muted">${t('人手够开所有在用的设备。')}</p>`}`;
    const kpiEl = this.root.querySelector('#ad-kpi');
    if (kpiEl) {
      const k = this.host.kpi(this.tab);
      kpiEl.innerHTML = `<table class="fc-t">${k.map((x) => `<tr class="${x.bad ? 'fc-bad' : ''}"><td>${esc(tx(x.label))}</td><td>${esc(kv(x.value))}</td></tr>`).join('') || `<tr><td class="fc-muted">${t('运行后显示')}</td></tr>`}</table>
        <p class="fc-muted">${t('指标是当前方案（已经应用的配置）的结果；改了布局或排班以后点「应用并重新仿真」，指标、三维、调度台和报告一起按新的设施重算。')}</p>`;
    }
  }

  // ———————————————————————— 按作业量排班 ————————————————————————

  /** 按当天的计划算这个设施每个岗位每小时的作业量，求排班 */
  private solveStaff(): void {
    const o = loadOptions();
    const act: Activity = {};
    const sp = sharedPlan();
    if (sp && (this.tab === 'dc' || this.tab === 'store')) Object.assign(act, activityFromBoard(sp.board, STORES[0]?.key ?? 'S01', storeSalesOf(sp)));
    if (this.tab === 'port' || this.tab === 'airport') {
      const src = this.host.sources?.();
      if (src) Object.assign(act, facilityActivity(this.tab === 'port' ? { ...(src.port ? { port: src.port } : {}) } : { ...(src.airport ? { airport: src.airport } : {}) }));
    }
    this.staffPlan = solveStaffing(this.tab, this.draft, act, { overtimeRate: o.overtimeRate, maxOvertimeHours: o.maxOvertimeHours, reservePct: o.reservePct, minPerShift: o.minPerShift, simNeutral: o.simNeutral });
    this.staffFor = this.tab;
    if (!this.staffPlan.roles.some((r) => r.key === this.staffRole && !r.fixed)) this.staffRole = this.staffPlan.roles.find((r) => !r.fixed)?.key;
    this.renderSolve();
  }

  private renderSolve(): void {
    const el = this.root.querySelector('#ad-solve');
    if (!el) return;
    const o = loadOptions();
    const num = (k: string, v: number, min: number, max: number, step: number) => `<input type="number" data-sopt="${k}" min="${min}" max="${max}" step="${step}" value="${v}">`;
    const plan = this.staffFor === this.tab ? this.staffPlan : undefined;
    el.innerHTML = `<h4>${t('按作业量排班')}</h4>
      <p class="fc-muted">${t('按当天的计划算每个岗位每小时要几个人（作业量的依据见表里），在早、中、夜三班里求成本最低的人数；交接时头尾两小时可以让上一班留下、下一班提前来加班。设施配置只存每班人数，所以「不加班」的方案可以直接填进排班表，「允许加班」的方案另外省的钱要排加班表执行。')}</p>
      <div class="ad-solve-opts">
        <label>${t('加班工资 {v1} 倍', { v1: num('overtimeRate', o.overtimeRate, 1, 3, 0.25) })}</label>
        <label>${t('每人每天最多加班 {v1} 小时', { v1: num('maxOvertimeHours', o.maxOvertimeHours, 0, 2, 1) })}</label>
        <label>${t('在作业量之外留 {v1}% 余量', { v1: num('reservePct', o.reservePct, 0, 50, 5) })}</label>
        <label>${t('每班最少 {v1} 人', { v1: num('minPerShift', o.minPerShift, 0, 5, 1) })}</label>
        <label><input type="checkbox" data-sopt="simNeutral"${o.simNeutral ? ' checked' : ''}> ${t('不让仿真里的作业变慢（影响作业效率的岗位不少于现在的人数）')}</label>
        <button class="primary" data-act="staff-solve">${t('按作业量求解')}</button>
      </div>
      ${plan ? this.staffHtml(plan) : ''}`;
  }

  private staffHtml(plan: StaffPlan): string {
    if (!plan.hasData && !plan.roles.some((r) => !r.fixed)) return `<p class="fc-muted">${this.tab === 'port' || this.tab === 'airport' ? t('这个设施的作业量来自三维里港口、机场的作业计划，还没接上；') : t('调度台还没有当天的计划；')}${sp}${t('先运行一次再求。')}</p>`;
    const crew = (c: Record<Shift, number>) => SHIFTS.map((s) => c[s]).join(' / ');
    const rows = plan.roles
      .map((r) => {
        const ot = r.overtime.filter((x) => x.people > 0);
        const otText = r.fixed ? '—' : ot.length && r.cost < r.costPlain - 0.5 ? t('{crew}，加班 {overtimeH} 小时', { crew: crew(r.crew), overtimeH: r.overtimeH }) : t('不用加班');
        return `<tr class="${r.fixed ? '' : 'pick'}${r.key === this.staffRole ? ' sel' : ''}"${r.fixed ? '' : ` data-staff-role="${r.key}"`}><td class="role">${esc(tx(r.label))}</td><td class="basis">${esc(tx(r.fixed ?? r.basis))}</td><td class="num">${crew(r.current)}</td><td class="num">${r.fixed ? t('不变') : crew(r.plain)}</td><td>${esc(otText)}</td><td class="num">${usd(r.costNow)} → ${usd(r.costPlain)}</td></tr>`;
      })
      .join('');
    const sel = plan.roles.find((r) => r.key === this.staffRole && !r.fixed);
    return `<p class="fc-kv"><span>${t('每天人工')}</span><b>${t('现在 {costNow} → 不加班 {costPlain} → 允许加班 {cost}', { costNow: usd(plan.costNow), costPlain: usd(plan.costPlain), cost: usd(plan.cost) })}${plan.overtimeH ? sp + t('（加班 {overtimeH} 小时）', { overtimeH: plan.overtimeH }) : ''}</b><span>${t('人手不够')}</span><b>${t('现在 {shortNow} 个人·小时 → 0', { shortNow: plan.shortNow })}</b></p>
      <div class="table-wrap"><table class="sv-t"><thead><tr><th>${t('岗位')}</th><th>${t('每小时要几个人（依据）')}</th><th>${t('现在 早/中/夜')}</th><th>${t('不加班 早/中/夜')}</th><th>${t('允许加班')}</th><th>${t('每天人工')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${sel ? this.chart(sel) : ''}
      ${plan.changes.length ? `<ul class="sv-why">${plan.changes.map((x) => `<li>${esc(tx(x))}</li>`).join('')}</ul>` : `<p class="fc-muted">${t('现在的排班和作业量正好对得上。')}</p>`}
      <div class="sv-acts"><button class="primary" data-act="staff-apply"${plan.costPlain !== plan.costNow || plan.roles.some((r) => !r.fixed && JSON.stringify(r.plain) !== JSON.stringify(r.current)) ? '' : ' disabled'}>${t('把「不加班」的人数填进排班表')}</button><span class="fc-muted">${t('填进去以后再点「应用并重新仿真」生效；求解用时 {ms} 毫秒。', { ms: plan.ms.toFixed(0) })}</span></div>`;
  }

  /** 一个岗位 24 小时：要几个人（柱）、现在有几个人（虚线）、求解后有几个人（实线） */
  private chart(r: RolePlan): string {
    const W = 720;
    const H = 150;
    const x0 = 28;
    const bw = (W - x0 - 8) / 24;
    const now = coverage(r.current, []);
    const plan = coverage(r.crew, r.overtime);
    const top = Math.max(1, ...r.need, ...now, ...plan);
    const y = (v: number) => H - 18 - (v / top) * (H - 30);
    const step = (c: number[]) => c.map((v, h) => `${h ? 'L' : 'M'}${(x0 + h * bw).toFixed(1)},${y(v).toFixed(1)}L${(x0 + (h + 1) * bw).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const bars = r.need.map((v, h) => `<rect class="need" x="${(x0 + h * bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - 18 - y(v)).toFixed(1)}"><title>${t('{h}:00 要 {v} 人，现在 {now} 人，求解后 {plan} 人', { h, v, now: now[h], plan: plan[h] })}</title></rect>`).join('');
    const ticks = [0, 6, 12, 18, 24].map((h) => `<text x="${(x0 + h * bw).toFixed(1)}" y="${H - 4}" text-anchor="middle">${h}</text>`).join('');
    return `<div class="ad-legend"><span><i class="need"></i>${t('{label}每小时要几个人', { label: esc(tx(r.label)) })}</span><span><i class="now"></i>${t('现在')}</span><span><i class="plan"></i>${t('求解后（含加班）')}</span></div>
      <svg class="ad-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('{label}每小时要几个人和排班', { label: esc(tx(r.label)) })}">${bars}<path class="now" d="${step(now)}"/><path class="plan" d="${step(plan)}"/>${ticks}<text x="4" y="${(y(top) + 4).toFixed(1)}">${top}</text></svg>`;
  }
}

