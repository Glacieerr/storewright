import { useMemo, useState } from 'react';
import { DEFAULT_INBOUND, DISRUPTION_LABEL, dayPnL, ROLES, WEEKDAY_LABEL, type Advice } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { economicsInput } from '../state/scenarios';
import { ROLE_LABEL } from '../scene/palette';
import { SEASON_LABEL } from '../scene/site';
import { clockText, pct } from './format';
import { adviceTitle } from './aiText';
import { aiStaffPlan } from './aiSchedule';
import { t, translate } from '../i18n';
import type { Timeline } from '../sim/protocol';

/**
 * AI 建议的呈现（决策记录 0020 · 方向 6）：每天早上一份当天计划（到货、人手、高峰与容量、风险、已采纳的改动），
 * 交接班时一份小结（上一班做完了什么、还有什么没做完、出了什么问题、下一班要注意什么），
 * 以及「采纳 / 不采纳」的对比（同一天按两组设置各跑一遍）。
 */

interface Section {
  title: string;
  lines: string[];
}

const ZONE: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻' };

/** 当天计划：按当前方案的仿真和 AI 建议整理 */
function planSections(tl: Timeline, advice: readonly Advice[], opts: { weekday: number; season: string; receivers: number; adopted: string[] }): Section[] {
  const trucks = [...tl.inbound.trucks].sort((a, b) => a.arrive - b.arrive);
  const src = (s: string) => trucks.filter((x) => (x.source ?? 'DC') === s).length;
  const out: Section[] = [];
  // 到货
  const inbound: string[] = [];
  if (trucks.length) {
    inbound.push(t('{0} 辆：配送中心 {1}、供应商直送 {2}、快递 {3}；第一辆 {4}，最后一辆 {5}', trucks.length, src('DC') + src('DC_GM'), src('VENDOR'), src('PARCEL'), clockText((trucks[0] as (typeof trucks)[number]).arrive), clockText((trucks[trucks.length - 1] as (typeof trucks)[number]).arrive)));
    const queues = advice.filter((a) => a.code === 'YARD_QUEUE' || a.code === 'YARD_QUEUE_NO_MOVE');
    if (queues.length) inbound.push(t('卸货门排队：{0}', queues.map((a) => `${clockText(a.from ?? 0)}–${clockText(a.to ?? 0)}`).join('、')));
    const late = advice.filter((a) => a.code === 'LATE_ARRIVAL');
    if (late.length) inbound.push(t('可能晚到：{0}', late.map((a) => t('{0} 约 {1}', translate(String(a.params.label)), clockText(Number(a.params.eta)))).join('、')));
  } else inbound.push(t('今天没有到货车辆。'));
  out.push({ title: t('到货'), lines: inbound });
  // 人手
  const staff: string[] = [];
  staff.push(t('全职工时：{0}', ROLES.map((r) => `${ROLE_LABEL[r]} ${tl.staffing[r].reduce((a, b) => a + b, 0)}`).join('、')));
  if (tl.students.length) staff.push(t('学生兼职 {0} 人：{1}', tl.students.length, tl.students.map((s) => `${s.id} ${ROLE_LABEL[s.role]} ${clockText(s.start)}–${clockText(s.end)}`).join('、')));
  staff.push(t('收货员 {0} 人，夜班补货 {1} 人', opts.receivers, tl.inbound.nightCrew));
  out.push({ title: t('人手'), lines: staff });
  // 线上订单与暂存
  const online: string[] = [];
  const bySlot = new Array<number>(24).fill(0);
  for (const o of Object.values(tl.orders)) bySlot[Math.floor(o.slotStart / 3600) % 24] = (bySlot[Math.floor(o.slotStart / 3600) % 24] as number) + 1;
  const peakH = bySlot.reduce((m, v, h) => (v > (bySlot[m] ?? 0) ? h : m), 0);
  online.push(t('{0} 单，取货高峰 {1}:00（{2} 单）', tl.orderCount, peakH, bySlot[peakH] ?? 0));
  const zones = (['AMBIENT', 'CHILLED', 'FROZEN'] as const).map((z) => {
    const a = tl.series.stagingOcc[z];
    const i = a.reduce((m, v, k) => (v > (a[m] ?? 0) ? k : m), 0);
    return `${t(ZONE[z] as string)} ${pct(a[i] ?? 0)}（${clockText(tl.series.t0 + i * tl.series.step)}）`;
  });
  online.push(t('暂存最满：{0}', zones.join('、')));
  out.push({ title: t('线上订单与暂存'), lines: online });
  // 前场
  const front: string[] = [];
  const plan = advice.find((a) => a.code === 'CHECKOUT_PLAN');
  if (plan) front.push(t('收银高峰 {0}:00 开 {1} 条人工通道', plan.params.peakAt ?? 0, plan.params.peakLanes ?? 0));
  const parking = advice.find((a) => a.code === 'PARKING_PEAK');
  if (parking) front.push(t('{0}:00–{1}:00 停车场 {2}% 满，安排人引导', parking.params.fromHour ?? 0, parking.params.toHour ?? 0, parking.params.peak ?? 0));
  if (front.length) out.push({ title: t('前场'), lines: front });
  // 风险
  const risks = advice.filter((a) => a.severity !== 'info').slice(0, 5);
  if (risks.length) out.push({ title: t('要注意'), lines: risks.map((a) => adviceTitle(a)) });
  if (opts.adopted.length) out.push({ title: t('已采纳的改动'), lines: opts.adopted });
  return out;
}

export function DailyPlan() {
  const tl = useApp((s) => s.timeline);
  const weekday = useApp((s) => s.weekday);
  const season = useApp((s) => s.site.season ?? 'autumn');
  const hours = useApp((s) => s.config.hours);
  const advice = useApp((s) => s.aiAdvice.result?.advice);
  const log = useApp((s) => s.aiLog);
  const receivers = useApp((s) => s.aiAdjust.receivers ?? DEFAULT_INBOUND.receivers);
  const [copied, setCopied] = useState(false);
  const adopted = useMemo(() => log.filter((e) => e.status === 'adopted').map((e) => adviceTitle({ id: e.id, area: e.area, code: e.code, params: e.params, severity: 'info', reasons: [], confidence: 0, ...(e.action ? { action: e.action } : {}) })), [log]);
  const sections = useMemo(() => (tl ? planSections(tl, advice ?? [], { weekday, season, receivers, adopted }) : []), [tl, advice, weekday, season, receivers, adopted]);
  if (!tl) return null;
  const head = t('今日计划 · {0} · {1} · 营业 {2}–{3}', t(WEEKDAY_LABEL[weekday] ?? ''), SEASON_LABEL[season as keyof typeof SEASON_LABEL] ?? season, clockText(hours.openMin * 60), clockText(hours.closeMin * 60));
  const text = [head, ...sections.map((s) => `【${s.title}】\n${s.lines.map((l) => `· ${l}`).join('\n')}`)].join('\n');
  return (
    <details className="ai-plan" open>
      <summary>{head}</summary>
      {sections.map((s) => (
        <div key={s.title} className="plan-sec">
          <b>{s.title}</b>
          <ul>
            {s.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      <button
        className="chip"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? t('已复制') : t('复制计划')}
      </button>
    </details>
  );
}

/** 交接班小结：上一班（前 8 小时）做完了什么、还有什么没做完、出了什么问题，下一班（后 4 小时）要注意什么 */
function handoffSections(tl: Timeline, advice: readonly Advice[], T: number): Section[] {
  const from = T - 8 * 3600;
  const done = new Set<string>();
  for (const c of tl.cars) if (c.doneAt <= T) for (const id of c.orderIds) done.add(id);
  const orders = Object.values(tl.orders);
  const staged = orders.filter((o) => o.stagedAt !== undefined && o.stagedAt <= T && !done.has(o.id)).length;
  const waitingNow = tl.cars.filter((c) => c.arriveAt <= T && c.doneAt > T).length;
  const lateSoFar = orders.filter((o) => o.lateMin && o.stagedAt !== undefined && o.stagedAt >= from && o.stagedAt <= T).length;
  const trucks = tl.inbound.trucks;
  const arrived = trucks.filter((x) => x.arrive >= from && x.arrive <= T);
  const inYard = trucks.filter((x) => x.arrive <= T && x.goneAt > T).length;
  const toPut = tl.inbound.pallets.filter((p) => p.receivedAt !== undefined && p.receivedAt <= T && (p.storedAt === undefined || p.storedAt > T) && (p.overflowAt === undefined || p.overflowAt > T) && (p.upAt === undefined || p.upAt > T) && !p.direct).length;
  const issues = tl.notifications.filter((n) => n.t >= from && n.t <= T && n.level !== 'info');
  const lateTrucks = arrived.filter((x) => x.appt !== undefined && x.arrive - x.appt >= 15 * 60);
  const incidents = tl.incidents.disruptions.filter((d) => d.start <= T && d.end >= from && !d.kind.startsWith('WEATHER'));
  const next = trucks.filter((x) => x.arrive > T && x.arrive <= T + 4 * 3600).sort((a, b) => a.arrive - b.arrive);
  const nextOrders = orders.filter((o) => o.slotStart > T && o.slotStart <= T + 4 * 3600).length;
  const nextAdvice = advice.filter((a) => a.from !== undefined && a.from > T && a.from <= T + 4 * 3600 && a.severity !== 'info');
  return [
    {
      title: t('做完了'),
      lines: [t('交付 {0} 单（全天 {1} 单）', done.size, tl.orderCount), t('到货 {0} 辆，卸完 {1} 辆', arrived.length, arrived.filter((x) => x.leave <= T).length)],
    },
    {
      title: t('还没做完'),
      lines: [t('暂存区里 {0} 单等顾客来取，{1} 位顾客正在等', staged, waitingNow), t('卸货场里 {0} 辆车，收货区还有 {1} 托没放进货架', inYard, toPut)],
    },
    {
      title: t('出过的问题'),
      lines: [
        ...(lateSoFar ? [t('{0} 单没按时备好', lateSoFar)] : []),
        ...lateTrucks.map((x) => t('{0} 比预约晚 {1} 分钟', translate(x.label), Math.round((x.arrive - (x.appt as number)) / 60))),
        ...incidents.map((d) => t('突发状况 {0}：{1}–{2}', translate(DISRUPTION_LABEL[d.kind]), clockText(d.start), clockText(d.end))),
        ...issues.slice(-3).map((n) => `${clockText(n.t)} ${n.text}`),
      ].slice(0, 6),
    },
    {
      title: t('下一班要注意'),
      lines: [
        next.length ? t('到货 {0} 辆：{1}', next.length, next.map((x) => `${clockText(x.arrive)} ${translate(x.label)}`).join('、')) : t('接下来 4 小时没有到货'),
        t('取货订单 {0} 单', nextOrders),
        ...nextAdvice.map((a) => adviceTitle(a)),
      ],
    },
  ].map((s) => (s.lines.length ? s : { ...s, lines: [t('无')] }));
}

export function HandoffSummary() {
  const tl = useApp((s) => s.timeline);
  const advice = useApp((s) => s.aiAdvice.result?.advice);
  const now = useClock(1);
  const [at, setAt] = useState<'now' | number>('now');
  if (!tl) return null;
  const T = at === 'now' ? now : at;
  const sections = handoffSections(tl, advice ?? [], T);
  return (
    <details className="ai-plan">
      <summary>{t('交接班小结（{0}）', clockText(T))}</summary>
      <div className="chips" role="group" aria-label={t('交接班时刻')}>
        {(['now', 15 * 3600, 23 * 3600] as const).map((k) => (
          <button key={String(k)} className={at === k ? 'chip active' : 'chip'} onClick={() => setAt(k)}>
            {k === 'now' ? t('现在') : clockText(k)}
          </button>
        ))}
      </div>
      {sections.map((s) => (
        <div key={s.title} className="plan-sec">
          <b>{s.title}</b>
          <ul>
            {s.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** 采纳与不采纳：同一天按现在的设置、撤掉全部采纳的设置各跑一遍 */
const PLAN_ROLES = [
  ['pick', 'PICK'],
  ['stage', 'STAGE'],
  ['handoff', 'HANDOFF'],
] as const;

export function AiSchedulePlan() {
  const tl = useApp((s) => s.timeline);
  const staffing = useApp((s) => s.staffing);
  const hours = useApp((s) => s.config.hours);
  const adopted = useApp((s) => s.aiLog.some((e) => e.id === 'STAGING:AI_SCHEDULE' && e.status === 'adopted'));
  const app = useApp.getState;
  const [plan, setPlan] = useState<ReturnType<typeof aiStaffPlan> | undefined>();
  if (!tl) return null;
  const openH = Math.floor(hours.openMin / 60);
  const closeH = Math.ceil(hours.closeMin / 60);
  const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
  const before = PLAN_ROLES.reduce((n, [k]) => n + sum(staffing[k]), 0);
  const after = plan ? PLAN_ROLES.reduce((n, [k]) => n + sum(plan.staffing[k]), 0) : 0;
  return (
    <details className="ai-plan">
      <summary>{t('用 AI 排班仿真一天')}</summary>
      <p className="hint">{t('按这一天仿真里的订单算出每半小时要几个人（与门店的排班草稿同一套换算），用排班生成器排班（班次 3–9 小时），换算成每小时在岗人数。采纳后按这份人数重新仿真，可以撤销，也可以和不采纳对比。')}</p>
      <button className="chip" onClick={() => setPlan(aiStaffPlan(tl, openH, closeH))}>
        {plan ? t('重新排') : t('生成 AI 排班')}
      </button>
      {plan && (
        <>
          <div className="table-wrap gap-top">
            <table className="cmp">
              <thead>
                <tr>
                  <th />
                  <th>{t('现在（工时）')}</th>
                  <th>{t('AI 排班（工时）')}</th>
                </tr>
              </thead>
              <tbody>
                {PLAN_ROLES.map(([k]) => (
                  <tr key={k}>
                    <td>{ROLE_LABEL[k]}</td>
                    <td>{sum(staffing[k])}</td>
                    <td>{sum(plan.staffing[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">{t('排了 {0} 个班次；需求没排满 {1} 工时、多排 {2} 工时。', plan.shifts, plan.underHours, plan.overHours)}</p>
          <button
            className="chip"
            disabled={adopted}
            onClick={() => app().adoptAdvice({ id: 'STAGING:AI_SCHEDULE', area: 'STAGING', code: 'AI_SCHEDULE', severity: 'info', params: { before, after }, reasons: [], confidence: 0.7, action: { kind: 'STAFF_PLAN', staffing: plan.staffing } })}
          >
            {adopted ? t('已采纳（可以在「已采纳」里撤销）') : t('采纳并重新仿真')}
          </button>
        </>
      )}
    </details>
  );
}

export function AdoptCompare() {
  const cmp = useApp((s) => s.aiCompare);
  const adopted = useApp((s) => s.aiLog.filter((e) => e.status === 'adopted').length);
  const costs = useApp((s) => s.costs);
  const plan = useApp((s) => s.checkoutPlan);
  const geo = useApp((s) => s.simGeo);
  const hours = useApp((s) => s.config.hours);
  const app = useApp.getState;
  // 收银通道小时：收银不在仿真里，按计划直接算（全天全开 vs 采纳的计划）
  const laneHours = useMemo(() => {
    if (!plan) return undefined;
    const open = Math.ceil(hours.closeMin / 60) - Math.floor(hours.openMin / 60);
    const all = geo.checkouts.filter((c) => !c.self).length * open;
    return { all, plan: plan.reduce((n, p) => n + p.byHour.reduce((a, b) => a + b, 0), 0) };
  }, [plan, geo, hours]);
  const a = cmp.adopted;
  const b = cmp.baseline;
  const rows: Array<[string, (x: NonNullable<typeof a>) => number, (v: number) => string, 'lower' | 'higher']> = [
    [t('订单未按时'), (x) => x.digest.metrics.lateOrderPct / 100, (v) => pct(v), 'lower'],
    [t('顾客平均等待'), (x) => x.digest.metrics.avgWaitMin, (v) => t('{0} 分钟', Math.round(v * 10) / 10), 'lower'],
    [t('等太久的顾客'), (x) => x.digest.metrics.longWaitPct / 100, (v) => pct(v), 'lower'],
    [t('卸货场排队'), (x) => x.yardWaitMin, (v) => t('{0} 分钟', Math.round(v)), 'lower'],
    [t('卸货到入库'), (x) => x.digest.inbound.dockToStockMin, (v) => t('{0} 分钟', Math.round(v)), 'lower'],
    [t('放到溢流位的托盘'), (x) => x.overflowPallets, (v) => t('{0} 托', v), 'lower'],
    [t('开门时没上架'), (x) => x.digest.inbound.backlogCases, (v) => t('{0} 箱', v), 'lower'],
    [t('冷藏暂存最满'), (x) => x.stagingPeak.CHILLED, (v) => pct(v), 'lower'],
    [t('冷冻暂存最满'), (x) => x.stagingPeak.FROZEN, (v) => pct(v), 'lower'],
    [t('工时（线上、收货、夜班）'), (x) => x.digest.metrics.staffedHoursTotal + x.digest.inbound.receivingHours + x.digest.inbound.nightHours, (v) => t('{0} 工时', Math.round(v)), 'lower'],
    [t('当天经营账（净额）'), (x) => dayPnL(economicsInput(x.digest), costs).net, (v) => `$${Math.round(v).toLocaleString()}`, 'higher'],
  ];
  return (
    <section className="gap-top">
      <h3>{t('采纳 / 不采纳对比')}</h3>
      <p className="hint">{t('同一天、同一批订单和到货，按现在的设置（含采纳的改动）和撤掉全部采纳的设置各跑一遍。')}</p>
      <button className="chip" disabled={!adopted || cmp.status === 'running'} onClick={() => void app().runAiCompare()}>
        {cmp.status === 'running' ? t('对比中…') : adopted ? t('对比已采纳的 {0} 条', adopted) : t('先采纳一条建议再对比')}
      </button>
      {cmp.status === 'ready' && a && b && (
        <div className="table-wrap gap-top">
          <table className="cmp">
            <thead>
              <tr>
                <th />
                <th>{t('不采纳')}</th>
                <th>{t('采纳 {0} 条', cmp.count ?? 0)}</th>
              </tr>
            </thead>
            <tbody>
              {laneHours && (
                <tr>
                  <td>{t('收银通道小时')}</td>
                  <td>{laneHours.all}</td>
                  <td className={laneHours.plan < laneHours.all ? 'gain' : ''}>{laneHours.plan}</td>
                </tr>
              )}
              {rows.map(([label, get, fmt, better]) => {
                const vb = get(b);
                const va = get(a);
                const gain = better === 'lower' ? vb - va : va - vb;
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{fmt(vb)}</td>
                    <td className={Math.abs(gain) < 1e-9 ? '' : gain > 0 ? 'gain' : 'loss'}>{fmt(va)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cmp.status === 'error' && <p className="warn">{t('对比失败，可以重试。')}</p>}
    </section>
  );
}
