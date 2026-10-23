import { useMemo, useState } from 'react';
import { COST_LABEL, dayPnL, DEFAULT_COSTS, distribution, PNL_GROUP_LABEL, WEEKDAY_LABEL, type CostParams, type DayPnL, type PnLGroup } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { digestOf, economicsInput, type ScenarioDigest } from '../state/scenarios';
import { captureScene } from '../scene/capture';
import { POLICY_SHORT, TEMPLATE_LABEL } from './format';
import { delta, rowsFor } from './metricRows';
import { downloadDataUrl, downloadText, MULTI_KEYS, reportHTML, reportMarkdown, type ReportColumn } from './report';
import { yourStoreNow } from '../extensions';
import { getLang, t, translate } from '../i18n';

const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}`;
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 每日净额柱状图 */
function NetBars({ nets }: { nets: number[] }) {
  const w = 320;
  const h = 90;
  const max = Math.max(1, ...nets.map(Math.abs));
  const bw = w / Math.max(1, nets.length);
  const mid = h / 2;
  return (
    <svg className="net-bars" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t('每日线上业务净额')}>
      <line x1={0} y1={mid} x2={w} y2={mid} stroke="var(--line)" />
      {nets.map((v, i) => {
        const bh = (Math.abs(v) / max) * (mid - 6);
        return (
          <rect key={i} x={i * bw + 1} y={v >= 0 ? mid - bh : mid} width={Math.max(1, bw - 2)} height={bh} fill={v >= 0 ? '#2f9a5f' : '#c8433a'}>
            <title>{t('第 {0} 天：{1}', i + 1, money(v))}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const GROUPS: PnLGroup[] = ['online', 'service', 'backroom'];

/** 经营账分组显示：每组的明细与小计，最后是合计；diff 时最后一列为第二列相对第一列的差值 */
function PnlRows({ cols, diff }: { cols: DayPnL[]; diff?: boolean }) {
  const first = cols[0];
  if (!first) return null;
  const dcell = (a: number, b: number) => {
    const d = b - a;
    return <td className={`mono ${Math.abs(d) < 0.5 ? 'flat' : d > 0 ? 'good' : 'bad'}`}>{Math.abs(d) < 0.5 ? '—' : `${d > 0 ? '+' : '−'}$${Math.abs(d).toFixed(0)}`}</td>;
  };
  return (
    <>
      {GROUPS.map((g) => {
        const lines = first.lines.filter((l) => l.group === g);
        if (g === 'service' && cols.every((c) => Math.abs(c.groups.service) < 0.5)) return null;
        return [
          ...lines.map((l) => (
            <tr key={l.key}>
              <td>{translate(l.label)}</td>
              {cols.map((c, i) => (
                <td key={i} className="mono">
                  {money(c.lines.find((x) => x.key === l.key)?.value ?? 0)}
                </td>
              ))}
              {diff && cols[1] && dcell(l.value, cols[1].lines.find((x) => x.key === l.key)?.value ?? 0)}
            </tr>
          )),
          <tr key={`${g}-sub`} className="subtotal">
            <td>{t('{0}小计', translate(PNL_GROUP_LABEL[g]))}</td>
            {cols.map((c, i) => (
              <td key={i} className={`mono ${c.groups[g] >= 0 ? 'good' : 'bad'}`}>
                {money(c.groups[g])}
              </td>
            ))}
            {diff && cols[1] && dcell(first.groups[g], cols[1].groups[g])}
          </tr>,
        ];
      })}
      <tr className="total">
        <td>{t('合计（不含店内销售）')}</td>
        {cols.map((c, i) => (
          <td key={i} className="mono">
            {money(c.net)}
          </td>
        ))}
        {diff && cols[1] && dcell(first.net, cols[1].net)}
      </tr>
    </>
  );
}

/** 方案与报告：保存方案、A / B 对比、连续多天模拟、经营账、导出报告与截图 */
export function ReportPanel() {
  const timeline = useApp((s) => s.timeline);
  const config = useApp((s) => s.config);
  const template = useApp((s) => s.template);
  const policy = useApp((s) => s.policy);
  const scenarios = useApp((s) => s.scenarios);
  const ab = useApp((s) => s.ab);
  const costs = useApp((s) => s.costs);
  const multi = useApp((s) => s.multiDay);
  // 「你的商店」的门店项目：完整报告（导出、连续多天模拟）是专业版功能；演示门店不受影响
  const project = useApp((s) => s.project);
  const paid = (fn: () => void) => () => {
    const ext = yourStoreNow();
    if (project && ext && !ext.request('fullReport')) return;
    fn();
  };
  const app = useApp.getState;
  const [name, setName] = useState('');
  const [withShot, setWithShot] = useState(true);

  const current = useMemo<ScenarioDigest | undefined>(() => (timeline ? digestOf(timeline, config) : undefined), [timeline, config]);
  const column = (id: string): ReportColumn | undefined => {
    if (id === 'current') return current ? { name: t('当前方案'), template, policy, digest: current, pnl: dayPnL(economicsInput(current), costs), ...(config.industry ? { industry: config.industry } : {}) } : undefined;
    const s = scenarios.find((x) => x.id === id);
    const industry = s?.settings.config?.industry;
    return s ? { name: s.name, template: s.settings.template, policy: s.settings.policy, thumb: s.thumb, digest: s.digest, pnl: dayPnL(economicsInput(s.digest), costs), ...(industry ? { industry } : {}) } : undefined;
  };
  const A = column(ab[0]);
  const B = column(ab[1]);
  const nets = useMemo(
    () =>
      (multi.days ?? []).map(
        (d) =>
          dayPnL(
            { metrics: d.metrics, receivingHours: d.inbound.receivingHours, nightHours: d.inbound.nightHours, forklifts: config.backroom.forklifts, palletJacks: config.backroom.palletJacks, backlogCases: d.inbound.backlogCases, autoRevenue: d.autoRevenue },
            costs,
          ).groups.online,
      ),
    [multi.days, costs, config],
  );

  if (!current) return <p className="muted pad">{t('正在仿真…')}</p>;
  const curPnl = dayPnL(economicsInput(current), costs);
  const m = current.metrics;

  const save = () => {
    const thumb = captureScene(320, 'image/jpeg', 0.75);
    const defaultName = `${TEMPLATE_LABEL[template]} · ${POLICY_SHORT[policy]} · ${t('{0} 条通道', current.aisles)}`;
    const sc = app().saveScenario(name || defaultName, thumb);
    if (sc) setName('');
  };

  const exportReport = (kind: 'html' | 'md') => {
    const ids = [...new Set(['current', ab[0], ab[1]])];
    const thumb = captureScene(320, 'image/jpeg', 0.75);
    const columns = ids.map((id) => {
      const c = column(id);
      return c && id === 'current' ? { ...c, thumb } : c;
    }).filter((c): c is ReportColumn => !!c);
    const shot = withShot && kind === 'html' ? captureScene(1280, 'image/jpeg', 0.85) : undefined;
    const data = { title: t('Storewright 门店方案报告'), generatedAt: new Date(), columns, costs, multi: multi.days?.length ? { days: multi.days, nets } : undefined, screenshot: shot };
    if (kind === 'html') downloadText(`storewright-report-${stamp()}.html`, reportHTML(data), 'text/html');
    else downloadText(`storewright-report-${stamp()}.md`, reportMarkdown(data), 'text/markdown');
  };

  const shot = () => {
    const url = captureScene();
    if (url) downloadDataUrl(`storewright-${stamp()}.png`, url);
  };

  const options = [{ id: 'current', label: t('当前方案') }, ...scenarios.map((s) => ({ id: s.id, label: s.name }))];
  const stale = multi.status === 'ready' && multi.configVersion !== config.configVersion;

  return (
    <div className="report">
      <div className="form">
        <h3>{t('当前方案')}</h3>
        <div className="kpis">
          <div>
            <span>{t('线上订单')}</span>
            <strong>{m.orders}</strong>
          </div>
          <div>
            <span>{t('平均等待')}</span>
            <strong>{t('{0} 分', m.avgWaitMin.toFixed(1))}</strong>
          </div>
          <div>
            <span>{t('未按时')}</span>
            <strong>{m.lateOrderPct.toFixed(1)}%</strong>
          </div>
          <div>
            <span>{t('单均工时')}</span>
            <strong>{t('{0} 分', m.laborMinutesPerOrder.toFixed(1))}</strong>
          </div>
          <div>
            <span>{t('线上业务日净额')}</span>
            <strong className={curPnl.groups.online >= 0 ? 'good' : 'bad'}>{money(curPnl.groups.online)}</strong>
          </div>
        </div>
        <label>
          <span>{t('方案名称')}</span>
          <input value={name} placeholder={`${TEMPLATE_LABEL[template]} · ${POLICY_SHORT[policy]}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
        <div className="row">
          <button className="primary" onClick={save}>
            {t('保存为方案')}
          </button>
          <button onClick={shot} title={t('下载当前画面（PNG）')}>
            {t('截图')}
          </button>
        </div>
        <p className="hint">{t('保存当前的门店布局、策略、排班、订单量、环境和突发状况设置，以及这一天的结果和画面缩略图。方案存在本机浏览器里。')}</p>
      </div>

      <div className="form">
        <h3>{t('已保存的方案（{0}）', scenarios.length)}</h3>
        {scenarios.length === 0 && <p className="muted">{t('还没有保存的方案。调整门店或排班后保存几个方案，就可以在下面对比。')}</p>}
        <ul className="scenario-list">
          {scenarios.map((s) => {
            const p = dayPnL(economicsInput(s.digest), costs);
            return (
              <li key={s.id}>
                {s.thumb ? <img src={s.thumb} alt="" /> : <div className="thumb-empty" />}
                <div className="sc-body">
                  <input className="sc-name" value={s.name} aria-label={t('方案名称')} onChange={(e) => app().renameScenario(s.id, e.target.value)} />
                  <span className="muted">
                    {TEMPLATE_LABEL[s.settings.template]} · {POLICY_SHORT[s.settings.policy]} · {new Date(s.savedAt).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span>
                    {t('等待 {0} 分 · 未按时 {1}% · 线上净额', s.digest.metrics.avgWaitMin.toFixed(1), s.digest.metrics.lateOrderPct.toFixed(1))} <strong className={p.groups.online >= 0 ? 'good' : 'bad'}>{money(p.groups.online)}</strong>
                  </span>
                  <span className="row">
                    <button onClick={() => app().loadScenario(s.id)} title={t('把这个方案的全部设置应用到模拟器')}>
                      {t('载入')}
                    </button>
                    <button onClick={() => app().setAB(0, s.id)} className={ab[0] === s.id ? 'active' : ''}>
                      {t('设为 A')}
                    </button>
                    <button onClick={() => app().setAB(1, s.id)} className={ab[1] === s.id ? 'active' : ''}>
                      {t('设为 B')}
                    </button>
                    <button className="danger" onClick={() => app().removeScenario(s.id)}>
                      {t('删除')}
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="form">
        <h3>{t('方案对比')}</h3>
        <div className="ab-pick">
          {([0, 1] as const).map((i) => (
            <label key={i}>
              <span>{i === 0 ? 'A' : 'B'}</span>
              <select value={ab[i]} onChange={(e) => app().setAB(i, e.target.value)}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {A && B && (
          <>
            {(A.thumb || B.thumb) && (
              <div className="ab-thumbs">
                {[A, B].map((c, i) => (
                  <figure key={i}>
                    {c.thumb ? <img src={c.thumb} alt="" /> : <div className="thumb-empty" />}
                    <figcaption>
                      <strong>{i === 0 ? 'A' : 'B'}</strong> {c.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            <div className="table-wrap">
              <table className="cmp">
                <thead>
                  <tr>
                    <th />
                    <th title={A.name}>A</th>
                    <th title={B.name}>B</th>
                    <th>{t('B 相对 A')}</th>
                  </tr>
                </thead>
                {rowsFor(A.industry === 'HARDWARE' && B.industry === 'HARDWARE' ? 'HARDWARE' : undefined).map((g) => (
                  <tbody key={g.group}>
                    <tr className="group">
                      <td colSpan={4}>{t(g.group)}</td>
                    </tr>
                    {g.rows.map((row) => {
                      const a = A.digest.metrics[row.key] as number;
                      const b = B.digest.metrics[row.key] as number;
                      const d = delta(row, a, b);
                      return (
                        <tr key={row.key}>
                          <td>{t(row.label)}</td>
                          <td className="mono">{row.fmt(a)}</td>
                          <td className="mono">{row.fmt(b)}</td>
                          <td className={`mono ${d.tone}`}>{d.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
                <tbody>
                  <tr className="group">
                    <td colSpan={4}>{t('经营账（每天，估算）')}</td>
                  </tr>
                  <PnlRows cols={[A.pnl, B.pnl]} diff />
                </tbody>
              </table>
            </div>
            {ab[0] === ab[1] && <p className="hint">{t('A 和 B 是同一个方案。保存几个方案后在上面选择不同的方案对比。')}</p>}
          </>
        )}
      </div>

      <div className="form">
        <h3>{t('连续多天模拟')}</h3>
        <p className="hint">{t('用当前设置连续模拟多天：每天换一组随机订单，订单量按星期几浮动（周五到周日偏高），看结果的波动范围，而不是只看一天。在后台计算，不影响播放。')}</p>
        <div className="row">
          {[7, 14, 30].map((n) => (
            <button key={n} onClick={paid(() => void app().runMultiDay(n))} disabled={multi.status === 'running'}>
              {t('{0} 天', n)}
            </button>
          ))}
        </div>
        {multi.status === 'running' && (
          <div className="progress" role="progressbar" aria-valuenow={multi.done ?? 0} aria-valuemax={multi.total ?? 1}>
            <div style={{ width: `${((multi.done ?? 0) / Math.max(1, multi.total ?? 1)) * 100}%` }} />
            <span>
              {t('正在模拟第 {0} / {1} 天…', Math.min((multi.done ?? 0) + 1, multi.total ?? 1), multi.total ?? 1)}
            </span>
          </div>
        )}
        {multi.status === 'error' && <p className="bad">{t('多天模拟失败。')}</p>}
        {multi.days && multi.days.length > 0 && (
          <>
            {stale && <p className="hint warn">{t('门店设置在模拟之后改过，结果可能已经过时，重新运行即可。')}</p>}
            <div className="table-wrap">
              <table className="cmp">
                <thead>
                  <tr>
                    <th>{t('{0} 天', multi.days.length)}</th>
                    <th>{t('平均')}</th>
                    <th>P10</th>
                    <th>{t('中位数')}</th>
                    <th>P90</th>
                  </tr>
                </thead>
                <tbody>
                  {MULTI_KEYS.map((k) => {
                    const d = distribution((multi.days ?? []).map((day, i) => k.pick(day, nets[i] ?? 0)));
                    return (
                      <tr key={k.label}>
                        <td>{t(k.label)}</td>
                        <td className="mono">{k.fmt(d.mean)}</td>
                        <td className="mono">{k.fmt(d.p10)}</td>
                        <td className="mono">{k.fmt(d.p50)}</td>
                        <td className="mono">{k.fmt(d.p90)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <NetBars nets={nets} />
            <p className="hint">
              {t('每天的线上业务净额（绿色盈余、红色亏损）。最忙的一天：')}
              {(() => {
                const days = multi.days ?? [];
                const busiest = days.reduce((a, b) => (b.metrics.orders > a.metrics.orders ? b : a), days[0] as (typeof days)[number]);
                return busiest ? t('第 {0} 天（{1}，{2} 单，平均等待 {3} 分钟）', busiest.day, translate(WEEKDAY_LABEL[busiest.weekday] ?? ''), busiest.metrics.orders, busiest.metrics.avgWaitMin.toFixed(1)) : '—';
              })()}
            </p>
          </>
        )}
      </div>

      <div className="form">
        <h3>{t('经营账（当前方案，每天）')}</h3>
        <table className="pnl">
          <tbody>
            <PnlRows cols={[curPnl]} />
          </tbody>
        </table>
        <p className="hint">{t('线上订单业务每单净额 ${0}。后仓收货与夜班补货服务的是整个门店，而模拟器不计算店内销售收入，所以合计通常为负；比较方案时看差值。', curPnl.onlinePerOrder.toFixed(2))}</p>
        <details>
          <summary>{t('单价假设（可调）')}</summary>
          {(Object.keys(COST_LABEL) as Array<keyof CostParams>).map((k) => (
            <label key={k}>
              <span>{translate(COST_LABEL[k])}</span>
              <input type="number" step={k === 'grossMargin' || k === 'autoServiceMargin' ? 0.01 : 0.5} min={0} value={costs[k]} onChange={(e) => app().setCosts({ [k]: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          ))}
          <button className="link" onClick={() => app().setCosts({ ...DEFAULT_COSTS })}>
            {t('恢复默认')}
          </button>
        </details>
        <p className="hint">{t('粗略估算，只用来比较方案之间的相对差异；单价都是假设值，按需调整（保存在本机）。')}</p>
      </div>

      <div className="form">
        <h3>{t('导出报告')}</h3>
        <label className="check">
          <input type="checkbox" checked={withShot} onChange={(e) => setWithShot(e.target.checked)} />
          {t('附上当前画面截图')}
        </label>
        <div className="row">
          <button className="primary" onClick={paid(() => exportReport('html'))}>
            {t('导出 HTML 报告')}
          </button>
          <button onClick={paid(() => exportReport('md'))}>{t('导出 Markdown')}</button>
        </div>
        <p className="hint">{t('报告包含当前方案和对比中选中的 A / B 方案的指标、经营账，以及最近一次多天模拟的分布。HTML 报告是单个文件，可以离线打开、直接发给别人。')}</p>
      </div>
    </div>
  );
}

