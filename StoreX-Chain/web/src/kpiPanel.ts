import './kpi.css';
import { AlertBook, defaultThresholds, evaluate, KPI_DEFS, LEVEL_LABEL, LEVELS, ownerText, type KpiInput, type KpiValue, type Threshold } from '../../src/assistant/kpiBoard';
import { canApprove, ROLE_LABEL, type Role } from '../../src/assistant/roles';
import { clock } from '../../src/twin/twin';
import { t as tr, tx } from './i18n';

/**
 * 分层看板面板：集团、区域、设施、作业四列指标（绿 / 黄 / 红），下面是告警（谁在管、有没有往上报、确认）。
 * 阈值可以改，存在本机浏览器里；新告警和往上报也在值班助手里提醒一句。
 */
export interface KpiHost {
  input(): KpiInput | undefined;
  role(): Role;
  notify(text: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const KEY = 'storex-chain-thresholds';
const fmt = (v: number | undefined, d = 0) => (v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

export class KpiPanel {
  readonly book = new AlertBook();
  private th: Record<string, Threshold> = defaultThresholds();
  private values: KpiValue[] = [];
  private lastMinute = -1;
  private lastReal = 0;
  private editing = false;
  private readonly els: { grid: HTMLElement; alerts: HTMLElement; edit: HTMLElement };

  constructor(
    root: HTMLElement,
    private readonly host: KpiHost,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, Threshold> | null;
      if (saved) for (const d of KPI_DEFS) if (saved[d.key]) this.th[d.key] = saved[d.key] as Threshold;
    } catch {
      /* 读不了就用默认的 */
    }
    root.innerHTML = `
      <header class="kb-head"><h2>${tr('分层看板')}</h2><span class="kb-sub">${tr('集团、区域、设施、作业四层指标；超过阈值开告警，没人确认按时往上报（告警 15 分钟报站长、30 分钟报区域经理）')}</span><button class="ghost" id="kb-edit-btn">${tr('阈值设置')}</button></header>
      <div class="kb-grid" id="kb-grid"></div>
      <div class="kb-alerts"><h3>${tr('告警')}</h3><ol id="kb-alerts"></ol></div>
      <div class="kb-edit" id="kb-edit" hidden></div>`;
    const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.els = { grid: q('kb-grid'), alerts: q('kb-alerts'), edit: q('kb-edit') };
    q('kb-edit-btn').onclick = () => {
      this.editing = !this.editing;
      this.renderEdit();
    };
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ack],[data-reset],[data-save]');
      if (!el) return;
      if (el.dataset.ack) {
        const t = this.host.input()?.ctx.t ?? 0;
        const a = this.book.ack(el.dataset.ack, this.host.role(), t);
        if (a) this.host.notify(tr('{role}确认了告警「{label}」（{t}）。', { role: tx(ROLE_LABEL[this.host.role()]), label: tx(a.label), t: clock(t) }));
        this.renderAlerts();
      } else if (el.dataset.reset !== undefined) {
        this.th = defaultThresholds();
        this.save();
      } else if (el.dataset.save !== undefined) {
        for (const inp of this.els.edit.querySelectorAll<HTMLInputElement>('input[data-k]')) {
          const k = inp.dataset.k as string;
          const v = Number(inp.value);
          if (!Number.isFinite(v)) continue;
          const cur = this.th[k] ?? { warn: 0, alarm: 0 };
          this.th[k] = { ...cur, [inp.dataset.f as 'warn' | 'alarm']: v };
        }
        this.save();
      }
    });
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.th));
    } catch {
      /* 存不了就只在这次有效 */
    }
    this.renderEdit();
    this.setTime(this.host.input()?.ctx.t ?? 0, true);
  }

  /** 时间走到 t：重新算指标、更新告警（每仿真分钟、最多每 0.4 秒一次） */
  setTime(t: number, force = false): void {
    const now = performance.now();
    const minute = Math.floor(t / 60);
    if (!force && (minute === this.lastMinute || now - this.lastReal < 400)) return;
    this.lastMinute = minute;
    this.lastReal = now;
    const input = this.host.input();
    if (!input) return;
    this.values = evaluate(input, this.th);
    const before = new Map(this.book.open().map((a) => [a.key, a.owner] as const));
    const fresh = this.book.update(t, this.values);
    for (const a of fresh) if (a.state === 'alarm') this.host.notify(tr('看板告警（{level}）：{label} {value}，{t} 起。', { level: tx(LEVEL_LABEL[a.level]), label: tx(a.label), value: fmt(a.value, KPI_DEFS.find((d) => d.key === a.key)?.digits ?? 0), t: clock(t) }));
    for (const a of this.book.open()) {
      const was = before.get(a.key);
      if (was && was !== a.owner) this.host.notify(tr('告警「{label}」{v2} 分钟没人确认，已经报{role}。', { label: tx(a.label), v2: a.state === 'alarm' ? '15' : '30', role: tx(ROLE_LABEL[a.owner]) }));
    }
    this.render();
  }

  private render(): void {
    const tile = (v: KpiValue) => {
      const th = this.th[v.def.key] ?? { warn: v.def.warn, alarm: v.def.alarm };
      const dir = v.def.better === 'lower' ? '≥' : '≤';
      const limit = v.def.rel ? tr('比基准差 {warn}{v2} 注意、{alarm}{v4} 告警', { warn: th.warn, v2: v.def.unit === '%' ? ` ${tr('个百分点')}` : '%', alarm: th.alarm, v4: v.def.unit === '%' ? ` ${tr('个百分点')}` : '%' }) : tr('{dir} {warn} 注意、{dir2} {alarm} 告警', { dir, warn: th.warn, dir2: dir, alarm: th.alarm });
      const delta = v.delta !== undefined ? `（${v.delta > 0 ? '+' : ''}${v.delta.toFixed(1)}${v.def.unit === '%' ? ` ${tr('个百分点')}` : '%'}）` : '';
      return `<div class="kb-tile st-${v.state}" title="${esc(limit)}"><span>${esc(tx(v.def.label))}</span><span class="v">${fmt(v.value, v.def.digits ?? 0)}<small> ${esc(tx(v.def.unit))}${esc(delta)}</small></span><span class="th">${esc(limit)}</span></div>`;
    };
    this.els.grid.innerHTML = LEVELS.map((lv) => {
      const vs = this.values.filter((v) => v.def.level === lv);
      const bad = vs.filter((v) => v.state === 'warn' || v.state === 'alarm').length;
      return `<section class="kb-col"><h3>${tx(LEVEL_LABEL[lv])}<small>${bad ? tr('{bad} 项超阈值', { bad }) : tr('正常')}</small></h3>${vs.map(tile).join('')}</section>`;
    }).join('');
    this.renderAlerts();
  }

  private renderAlerts(): void {
    const role = this.host.role();
    const open = this.book.open();
    const closed = this.book.alerts.filter((a) => a.cleared !== undefined).slice(-3).reverse();
    const row = (a: (typeof open)[number]) =>
      `<li><span class="lv ${a.state}">${a.state === 'alarm' ? tr('告警') : tr('注意')}</span><span>${tx(LEVEL_LABEL[a.level])} · ${esc(tx(a.label))} <b>${fmt(a.value, KPI_DEFS.find((d) => d.key === a.key)?.digits ?? 0)}</b></span><span class="meta">${tr('{since} 起 · 现在归{ownerText}', { since: clock(a.since), ownerText: esc(tx(ownerText(a))) })}${a.escalated.map((x) => tr('，{t} 报{role}', { t: clock(x.t), role: tx(ROLE_LABEL[x.to]) })).join('')}${a.ack ? ` ${tr('· {role} {t} 确认', { role: tx(ROLE_LABEL[a.ack.by]), t: clock(a.ack.t) })}` : ''}${a.cleared !== undefined ? ` ${tr('· {cleared} 恢复', { cleared: clock(a.cleared) })}` : ''}</span>${a.cleared === undefined && !a.ack ? (role !== 'viewer' && canApprove(role, a.owner) ? `<button class="chip" data-ack="${esc(a.key)}">${tr('知道了')}</button>` : `<span class="meta">${tr('要{role}确认', { role: tx(ROLE_LABEL[a.owner]) })}</span>`) : ''}</li>`;
    this.els.alerts.innerHTML = open.length || closed.length ? [...open.map(row), ...closed.map(row)].join('') : `<li class="meta">${tr('没有告警。')}</li>`;
  }

  private renderEdit(): void {
    this.els.edit.hidden = !this.editing;
    if (!this.editing) return;
    this.els.edit.innerHTML = `<table><thead><tr><th>${tr('层')}</th><th>${tr('指标')}</th><th>${tr('注意')}</th><th>${tr('告警')}</th><th>${tr('说明')}</th></tr></thead><tbody>${KPI_DEFS.map((d) => {
      const th = this.th[d.key] ?? { warn: d.warn, alarm: d.alarm };
      return `<tr><td>${tx(LEVEL_LABEL[d.level])}</td><td>${esc(tx(d.label))}</td><td><input data-k="${d.key}" data-f="warn" type="number" step="any" value="${th.warn}"></td><td><input data-k="${d.key}" data-f="alarm" type="number" step="any" value="${th.alarm}"></td><td class="note">${d.rel ? `${tr('和这个方案的基准比，差多少')}${d.unit === '%' ? tr('个百分点') : '%'}` : d.better === 'lower' ? tr('{unit}，到这个数就算', { unit: tx(d.unit) }) : tr('{unit}，低到这个数就算', { unit: tx(d.unit) })}</td></tr>`;
    }).join('')}</tbody></table><p><button class="primary" data-save>${tr('保存阈值')}</button> <button class="ghost" data-reset>${tr('恢复默认')}</button> <span class="note">${tr('阈值存在这台电脑的浏览器里。')}</span></p>`;
  }
}
