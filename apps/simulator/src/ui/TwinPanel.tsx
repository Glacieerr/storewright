import { activeAlerts, nudgeStats, type LiveRec, type StoreStatic } from '@storewright/ops';
import { currentImpact, type Forecast, type ForecastKpi, type SensorDef } from '@storewright/twin';
import { useApp } from '../state/store';
import { liveClient, viewNow, viewState } from '../live/link';
import { equipmentHealth, sensorReading, twinForecast, twinHealth, twinView } from '../live/twin';
import { LineChart } from './Chart';
import { agoText, alertText, hhmm, impactText, issueText, sensorName, sensorValueText, STATUS_COLOR, statusText } from './twinText';
import { goLive } from './TwinTimeline';
import { placeSensors } from '../scene/TwinSensors';
import { t } from '../i18n';

/**
 * 数字孪生面板（决策记录 0016）：孪生的健康度、设备与传感器、设备告警、从现在出发的推演（可以试调整人手）。
 * 回放时显示回放到的那一刻。
 */
export function TwinPanel() {
  const twin = useApp((s) => s.twin);
  useApp((s) => s.twinVersion);
  useApp((s) => s.liveVersion);
  const c = liveClient();
  const tv = twinView();
  const s = viewState();
  if (!c?.statics || !s) return null;
  const health = twinHealth();
  const now = viewNow();
  const alerts = activeAlerts(s);
  const cleared = Object.values(s.alerts ?? {})
    .filter((a) => a.status === 'CLEARED')
    .sort((a, b) => (b.clearedAt ?? 0) - (a.clearedAt ?? 0))
    .slice(0, 3);
  const nameOf = (id?: string) => (id ? (c.statics?.roster.find((a) => a.id === id)?.name ?? id) : '');
  const defOf = (id: string) => tv.defs.find((d) => d.id === id);

  return (
    <section className="twin-panel" aria-label={t('数字孪生')}>
      <div className="twin-head">
        <span className={`twin-mode m-${twin.mode}`}>{twin.mode === 'live' ? t('实时同步') : twin.mode === 'replay' ? t('回放 {0}', hhmm(now)) : t('推演')}</span>
        {twin.mode !== 'live' && (
          <button className="link" onClick={goLive}>
            {t('回到实时')}
          </button>
        )}
        {health && twin.mode !== 'replay' && (
          <span className={`twin-score ${health.score >= 85 ? 'good' : health.score >= 60 ? 'fair' : 'poor'}`} title={t('孪生健康度：孪生和现场对得上多少')}>
            {t('健康度 {0}', health.score)}
          </span>
        )}
      </div>
      {/* 健康度说的是此刻，回放时不显示 */}
      {health && twin.mode !== 'replay' && (
        <dl className="facts twin-facts">
          <dt>{t('同步')}</dt>
          <dd>{health.lastEventAt !== undefined ? t('最后一条作业事件 {0} · 往返 {1} ms', agoText(Math.max(0, Date.now() + c.offset - health.lastEventAt)), Math.round(c.rtt)) : t('还没有作业事件')}</dd>
          <dt>{t('数据源')}</dt>
          <dd>
            {t('员工设备在线 {0}/{1}', health.devices.online, health.devices.total)}
            {health.sources
              .filter((x) => x.id !== 'DEVICES')
              .map((x) => (
                <span key={x.id} className="muted">
                  {' · '}
                  {x.id === 'POS' ? t('POS 流水') : x.id === 'SHELF_SENSORS' ? t('货架传感器') : t('设备传感器')} {x.lastAt !== undefined ? agoText(Math.max(0, Date.now() + c.offset - x.lastAt)) : t('无')}
                </span>
              ))}
          </dd>
          <dt>{t('传感器')}</dt>
          <dd>{t('正常 {0} · 注意 {1} · 告警 {2} · 离线 {3}', health.sensors.ok, health.sensors.warn, health.sensors.alarm, health.sensors.stale)}</dd>
          <dt>{t('账实一致')}</dt>
          <dd>{health.fidelity.rate !== undefined ? t('{0}%（{1} 次数货架和盘点）', Math.round(health.fidelity.rate * 100), health.fidelity.checks) : t('还没有数货架或盘点的记录')}</dd>
          {health.issues.length > 0 && (
            <>
              <dt>{t('问题')}</dt>
              <dd className="warn-text">{health.issues.map(issueText).join('；')}</dd>
            </>
          )}
        </dl>
      )}

      <h3 className="gap">{t('设备与传感器')}</h3>
      {!tv.defs.length && <p className="muted">{t('这家门店没有设备传感器')}</p>}
      <ul className="twin-sensors">
        {tv.defs.map((d) => (
          <SensorRow key={d.id} def={d} points={tv.points.get(d.id) ?? []} />
        ))}
      </ul>
      {tv.demo && <p className="hint">{t('演示门店的读数由设备仿真产生；在控制台的「设备与告警」里可以制造故障，看告警怎样传到员工手机和这里。')}</p>}

      <h3 className="gap">{t('设备告警')}</h3>
      {alerts.length === 0 && <p className="muted">{t('没有未解除的设备告警')}</p>}
      <ul className="ops-board twin-alerts">
        {alerts.map((a) => {
          const d = defOf(a.sensorId);
          return (
            <li key={a.id} className={a.severity === 'ALARM' ? 'b-red' : 'b-yellow'}>
              <span className="tag">{alertText(a.kind)}</span>
              <span className="grow">
                <b>{d ? sensorName(d) : a.sensorId}</b> {d && a.kind !== 'SENSOR_OFFLINE' ? t('触发时 {0}', sensorValueText(d, a.value)) : ''}
                <br />
                <span className="muted small">{impactText(currentImpact(s, c.statics as StoreStatic, a, tv.defs)) || t('没有受影响的订单或库存')}</span>
              </span>
              <span className="muted small">{a.status === 'ACKED' ? t('{0} 已确认', nameOf(a.ackBy)) : t('未确认')}</span>
            </li>
          );
        })}
        {cleared.map((a) => {
          const d = defOf(a.sensorId);
          return (
            <li key={a.id} className="b-grey">
              <span className="tag">{t('已解除')}</span>
              <span className="grow">
                {d ? sensorName(d) : a.sensorId} · {alertText(a.kind)}
                {a.peak !== undefined && d ? ` · ${t('最高 {0}', sensorValueText(d, a.peak))}` : ''}
              </span>
              <span className="muted small">{a.clearedAt !== undefined ? hhmm(a.clearedAt) : ''}</span>
            </li>
          );
        })}
      </ul>

      <TicketSection />
      <ForesightSection />
      <ForecastSection />
    </section>
  );
}

/** 报修单（预测性维护，决策记录 0022 · E1）：报修期间这台设备管着的暂存格位暂停放新框 */
function TicketSection() {
  const c = liveClient();
  const s = viewState();
  const tv = twinView();
  if (!c?.statics || !s) return null;
  const open = Object.values(s.tickets ?? {}).filter((x) => x.status === 'OPEN');
  if (!open.length) return null;
  return (
    <>
      <h3 className="gap">{t('报修单')}</h3>
      <ul className="ops-board">
        {open.map((x) => {
          const d = tv.defs.find((y) => y.id === x.sensorId);
          return (
            <li key={x.id} className="b-yellow">
              <span className="tag">{x.reason === 'MANUAL' ? t('人工报修') : t('AI 预测')}</span>
              <span className="grow">
                <b>{d ? sensorName(d) : x.sensorId}</b>
                {x.slots.length > 0 && <span className="muted small"> · {t('{0} 个格位暂停放新框', x.slots.length)}</span>}
              </span>
              <span className="muted small">{hhmm(x.openedAt)}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 推演里的问题（运营预警，决策记录 0021 · A2） */
const PROBLEM_TEXT: Record<string, string> = { LATE: '赶不上取货时段', WAIT: '顾客等太久', COLD_FULL: '冷区暂存快满', BACKLOG: '拣货积压' };

function foresightAction(r: LiveRec, st: StoreStatic | undefined): string {
  const p = r.action.params ?? {};
  const n = Number(p.count ?? String(p.orderIds ?? '').split(',').filter(Boolean).length);
  const role = (x: unknown) => t(({ PICK: '拣货', STAGE: '暂存', HANDOFF: '交付', BACKROOM: '后仓', RESTOCK: '补货' } as Record<string, string>)[String(x ?? '')] ?? String(x ?? ''));
  switch (r.action.kind) {
    case 'MOVE_ASSOCIATE':
      return t('把 {0} 从{1}调到{2}', st?.roster.find((a) => a.id === p.associateId)?.name ?? String(p.associateId ?? ''), role(p.from), role(p.to));
    case 'EXPEDITE_ORDERS':
      return t('提前开始 {0} 单', n);
    case 'DEFER_FROZEN':
      return t('{0} 单的冷冻商品 {1} 之后再拣', n, hhmm(Number(p.until ?? 0)));
    case 'NOTIFY_DELAY':
      return t('通知 {0} 位顾客会晚 {1} 分钟', n, Number(p.minutes ?? 0));
    default:
      return p.callIn ? t('请一名{0}提前来或延长', role(p.role)) : '';
  }
}

/**
 * 运营预警：门店 AI 用推演（订单量展望 + 批次的 AI 预计用时）看未来两小时，发现问题就试几个办法，
 * 发出最好的一个给带班负责人；这里列出还没处理的预警和建议中枢的提醒统计。
 */
function ForesightSection() {
  const c = liveClient();
  const s = viewState();
  if (!c?.statics || !s) return null;
  const recs = Object.values(s.recs)
    .filter((r) => r.module === 'FORESIGHT' && r.status === 'OPEN')
    .sort((a, b) => b.issuedAt - a.issuedAt);
  const st = nudgeStats(s, viewNow());
  const ol = s.outlook;
  return (
    <>
      <h3 className="gap">{t('运营预警')}</h3>
      {ol && (
        <p className="muted small">
          {t('订单量展望（AI）：接下来 3 小时约 {0} 单', Math.round(ol.hours.filter((h) => h.t + 3_600_000 > viewNow()).slice(0, 3).reduce((a, h) => a + h.mean, 0)))} · {t('今天修正 ×{0}', ol.correction)}
        </p>
      )}
      {recs.length === 0 ? (
        <p className="muted">{t('推演里接下来两小时没有需要处理的问题')}</p>
      ) : (
        <ul className="ops-board">
          {recs.map((r) => {
            const p = r.action.params ?? {};
            const fmt = (v: number) => (r.target === 'COLD_FULL' ? `${Math.round(v * 100)}%` : r.target === 'LATE' ? t('{0} 单', Math.round(v)) : t('{0} 分钟', Math.round(v * 10) / 10));
            return (
              <li key={r.id} className={p.urgent ? 'b-red' : 'b-yellow'}>
                <span className="tag">{t(PROBLEM_TEXT[r.target] ?? r.target)}</span>
                <span className="grow">
                  <b>{foresightAction(r, c.statics)}</b>
                  <br />
                  <span className="muted small">
                    {t('{0} 起 · 不处理 {1} → 采纳后 {2} · 把握 {3}%', hhmm(Number(p.at ?? r.prediction?.from ?? 0)), fmt(r.prediction?.baseline ?? 0), fmt(r.prediction?.value ?? 0), Math.round(r.confidence * 100))}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">{t('建议中枢：最近一小时发出 {0} 条提醒（紧急 {1}），平均每人 {2} 条', st.lastHour, st.urgentLastHour, st.perPerson)}</p>
    </>
  );
}

function SensorRow({ def, points }: { def: SensorDef; points: ReadonlyArray<[number, number]> }) {
  const r = sensorReading(def);
  const status = r?.s ?? 'NO_DATA';
  // 点一行：镜头对准这台设备
  const focus = () => {
    const st = useApp.getState();
    const c = liveClient();
    const p = c?.statics ? placeSensors([def], c.statics, st.simGeo, st.simModel)[0] : undefined;
    if (p) st.frame(p.x, p.y + 1.5, p.z, 9);
  };
  const spark = (() => {
    if (points.length < 2) return '';
    const t0 = (points[0] as [number, number])[0];
    const t1 = (points[points.length - 1] as [number, number])[0];
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, v] of points) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (def.limits) {
      lo = Math.min(lo, def.limits.nominal - 1);
      hi = Math.max(hi, def.limits.direction === 'MAX' ? def.limits.limit + 0.5 : def.limits.nominal + 1);
    }
    const span = Math.max(0.5, hi - lo);
    return points.map(([at, v]) => `${(((at - t0) / Math.max(1, t1 - t0)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(' ');
  })();
  return (
    <li>
      <button className="twin-sensor" onClick={focus} title={t('在场景里查看')}>
        <i style={{ background: STATUS_COLOR[status] }} />
        <span className="grow">{sensorName(def)}</span>
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden className="spark">
          {spark && <polyline points={spark} fill="none" stroke={STATUS_COLOR[status]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </svg>
        <b className="mono">{r ? sensorValueText(def, r.v) : '—'}</b>
        <span className="muted small">{statusText(status)}</span>
      </button>
      <HealthNote id={def.id} />
    </li>
  );
}

/** 设备健康的一句话（预测性维护，决策记录 0022）：在变坏、留意、读数卡住 */
function HealthNote({ id }: { id: string }) {
  const h = equipmentHealth(id);
  if (!h || h.s === 'OK') return null;
  const text =
    h.s === 'STUCK'
      ? t('读数卡住：传感器可能坏了')
      : h.s === 'RISK'
        ? t('在变坏：底线温度每小时 +{0} °C，约 {1} 分钟后越过告警线', h.slope ?? 0, h.eta ?? 0)
        : h.slope !== undefined && h.slope > 0
          ? t('留意：底线温度每小时 +{0} °C', h.slope)
          : t('留意：开门后回温变慢');
  return <p className={`small ${h.s === 'RISK' || h.s === 'STUCK' ? 'warn-text' : 'muted'} twin-health-note`}>{text}</p>;
}

const PLANS: Array<{ label: string; delta: Partial<Record<'PICK' | 'STAGE' | 'HANDOFF', number>> }> = [
  { label: '+1 拣货员', delta: { PICK: 1 } },
  { label: '+1 交付员', delta: { HANDOFF: 1 } },
  { label: '交付员调去拣货', delta: { PICK: 1, HANDOFF: -1 } },
  { label: '少 1 名拣货员', delta: { PICK: -1 } },
];

function same(a: Record<string, number>, b: Partial<Record<string, number>>): boolean {
  return ['PICK', 'STAGE', 'HANDOFF'].every((k) => (a[k] ?? 0) === (b[k] ?? 0));
}

/** 推演：从现在（或回放到的那一刻）出发的未来 3 小时；可以试调整人手，和现状对比 */
function ForecastSection() {
  const delta = useApp((s) => s.forecastDelta);
  const replaying = useApp((s) => s.twin.mode === 'replay');
  const base = twinForecast({});
  const changed = delta.PICK !== 0 || delta.STAGE !== 0 || delta.HANDOFF !== 0;
  const plan = changed ? twinForecast({ staffDelta: delta }) : undefined;
  if (!base) return null;
  const b = base.basis;
  const app = useApp.getState;
  return (
    <>
      <h3 className="gap">{replaying ? t('推演：从 {0} 起 3 小时', hhmm(base.at)) : t('推演：未来 3 小时')}</h3>
      <p className="muted small">
        {t('在岗：拣货 {0} · 暂存 {1} · 交付 {2}', b.staff.PICK, b.staff.STAGE, b.staff.HANDOFF)} · {b.aiWalks > 0 ? t('{0} 个批次用 AI 预计用时{1}', b.aiWalks, b.aiFactor !== undefined ? t('（今天实测 × {0}）', b.aiFactor) : '') : t('拣货用时 × {0}（{1}）', b.pickFactor, b.measured.pick ? t('今天实测') : t('默认'))} · {t('交付 {0} 分钟/单（{1}）', b.handoffMin, b.measured.handoff ? t('今天实测') : t('默认'))} ·{' '}
        {b.demand === 'OUTLOOK' && b.outlook ? t('新订单按 AI 订单量展望（今天修正 ×{0}，约 {1} 单/小时）', b.outlook.correction, b.ordersPerHour) : t('新订单 {0} 单/小时（最近一小时）', b.ordersPerHour)}
      </p>
      <div className="chips twin-plans" role="group" aria-label={t('试一试')}>
        {PLANS.map((p) => (
          <button key={p.label} className={same(delta, p.delta) ? 'chip active' : 'chip'} onClick={() => app().setForecastDelta({ PICK: 0, STAGE: 0, HANDOFF: 0, ...(same(delta, p.delta) ? {} : p.delta) })}>
            {t(p.label)}
          </button>
        ))}
      </div>
      <KpiCompare base={base.kpi} plan={plan?.kpi} />
      {b.demand === 'OUTLOOK' && <BandNote />}
      <ForecastChart f={plan ?? base} />
      <LateList f={plan ?? base} />
    </>
  );
}

/** 订单量的乐观、悲观两条线下，赶不上取货时段的单数（决策记录 0021 · A1） */
function BandNote() {
  const lo = twinForecast({ band: 'low' });
  const hi = twinForecast({ band: 'high' });
  if (!lo || !hi) return null;
  return <p className="muted small">{t('订单量偏少时 {0} 单赶不上、偏多时 {1} 单（AI 订单量展望的 80% 区间）', lo.kpi.late, hi.kpi.late)}</p>;
}

function KpiCompare({ base, plan }: { base: ForecastKpi; plan?: ForecastKpi }) {
  const rows: Array<[string, (k: ForecastKpi) => number, (v: number) => string]> = [
    ['赶不上取货时段', (k) => k.late, (v) => t('{0} 单', v)],
    ['顾客平均等待', (k) => k.avgWaitMin, (v) => t('{0} 分钟', v.toFixed(1))],
    ['最长等待', (k) => k.maxWaitMin, (v) => t('{0} 分钟', v.toFixed(1))],
    ['拣货积压峰值', (k) => k.peakBacklogMin, (v) => t('{0} 分钟', Math.round(v))],
    ['冷区暂存峰值', (k) => k.peakColdOccupancy, (v) => `${Math.round(v * 100)}%`],
  ];
  return (
    <table className="twin-kpi">
      <thead>
        <tr>
          <th />
          <th>{t('现状')}</th>
          {plan && <th>{t('方案')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, get, fmt]) => {
          const a = get(base);
          const p = plan ? get(plan) : undefined;
          const better = p !== undefined && p < a - 1e-9;
          const worse = p !== undefined && p > a + 1e-9;
          return (
            <tr key={label}>
              <td>{t(label)}</td>
              <td className="mono">{fmt(a)}</td>
              {plan && <td className={`mono ${better ? 'good-text' : worse ? 'warn-text' : ''}`}>{p !== undefined ? fmt(p) : ''}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ForecastChart({ f }: { f: Forecast }) {
  const d = new Date(f.at);
  const t0 = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  const step = f.stepMin * 60;
  return (
    <LineChart
      title={t('推演曲线')}
      t0={t0}
      step={step}
      now={t0 + step * (f.steps.length - 1)}
      series={[
        { label: '等候的顾客', color: '#ee8a35', values: f.steps.map((x) => x.waiting) },
        { label: '待交付', color: '#3b6ea8', values: f.steps.map((x) => x.ready) },
        { label: '拣货积压（分钟）', color: '#8a6bd6', values: f.steps.map((x) => x.backlogMin), dashed: true },
      ]}
    />
  );
}

function LateList({ f }: { f: Forecast }) {
  const late = f.orders.filter((o) => o.late && !o.projected && o.dueAt <= f.at + f.horizonMin * 60_000).slice(0, 6);
  if (!late.length) return <p className="muted small">{t('推演里现有订单都能在取货时段前备好。')}</p>;
  return (
    <>
      <p className="small">{t('可能赶不上取货时段的订单：')}</p>
      <ul className="ops-board">
        {late.map((o) => (
          <li key={o.orderId} className="b-red">
            <span className="tag">{o.shortCode}</span>
            <span className="grow">{t('时段 {0}', hhmm(o.dueAt))}</span>
            <span className="mono">{o.readyAt !== undefined ? t('预计 {0} 备好', hhmm(o.readyAt)) : t('没有人手拣货')}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
