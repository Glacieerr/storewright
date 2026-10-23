import { useMemo } from 'react';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import type { PolicyDigest, PolicyName } from '../sim/protocol';
import { LineChart, type ChartSeries } from './Chart';
import { POLICY_COLOR, POLICY_LABEL, POLICY_SHORT } from './format';
import { delta, rowsFor } from './metricRows';
import { t } from '../i18n';

const ORDER: PolicyName[] = ['baseline', 'optimized', 'efficiency'];

/** 策略对比：同一门店、同一订单流、同一排班下三种策略的全天结果 */
export function ComparePanel() {
  const tm = useClock(4);
  const compare = useApp((s) => s.compare);
  const industry = useApp((s) => s.config.industry);
  const policy = useApp((s) => s.policy);
  const app = useApp.getState;

  const results = useMemo(() => {
    const map = new Map<PolicyName, PolicyDigest>();
    for (const r of compare.results ?? []) map.set(r.policy, r);
    return map;
  }, [compare.results]);

  const charts = useMemo(() => {
    const series = (pick: (d: PolicyDigest) => number[]) =>
      ORDER.flatMap<ChartSeries>((p) => {
        const d = results.get(p);
        return d ? [{ label: POLICY_SHORT[p], color: POLICY_COLOR[p], values: pick(d), dashed: p === 'baseline' }] : [];
      });
    return {
      waiting: series((d) => d.series.waiting),
      avgWait: series((d) => d.series.avgWaitMin),
      handed: series((d) => d.series.handedOff),
    };
  }, [results]);

  const base = results.get('baseline');
  if (!base) {
    return (
      <div className="compare pad">
        <p className="muted">{compare.status === 'error' ? t('策略对比计算失败。') : t('正在后台计算三种策略（不影响左侧播放）…')}</p>
      </div>
    );
  }
  const s = base.series;
  const chartProps = { t0: s.t0, step: s.step, now: tm };

  return (
    <div className="compare">
      <p className="hint top">
        {t('同一门店布局、同一订单流（随机种子相同）、同一排班，只换策略。这是单次仿真；统计显著性见 Phase 1 报告的 30 次重复实验。')}
        {compare.status === 'running' && <span className="pulse"> {t('正在按最新设置重新计算…')}</span>}
      </p>
      <div className="table-wrap">
        <table className="cmp">
          <thead>
            <tr>
              <th />
              {ORDER.map((p) => (
                <th key={p} className={p === policy ? 'current' : ''}>
                  <span className="dot" style={{ background: POLICY_COLOR[p] }} />
                  {POLICY_SHORT[p]}
                  {p === policy ? (
                    <span className="tag">{t('播放中')}</span>
                  ) : (
                    <button className="link" onClick={() => app().setPolicy(p)} title={t('切换到{0}', POLICY_LABEL[p])}>
                      {t('切换')}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {rowsFor(industry).map((g) => (
            <tbody key={g.group}>
              <tr className="group">
                <td colSpan={4}>{t(g.group)}</td>
              </tr>
              {g.rows.map((row) => {
                const b = base.metrics[row.key] as number;
                return (
                  <tr key={row.key}>
                    <td>{t(row.label)}</td>
                    {ORDER.map((p) => {
                      const d = results.get(p);
                      if (!d) return <td key={p}>—</td>;
                      const v = d.metrics[row.key] as number;
                      const dl = p === 'baseline' ? undefined : delta(row, b, v);
                      return (
                        <td key={p} className={`mono${p === policy ? ' current' : ''}`}>
                          {row.fmt(v)}
                          {dl && <span className={`delta ${dl.tone}`}>{dl.text}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      <section className="chart-grid">
        <LineChart title={t('正在等待的车辆')} series={charts.waiting} {...chartProps} />
        <LineChart title={t('平均到店等待（分钟）')} series={charts.avgWait} format={(v) => v.toFixed(1)} {...chartProps} />
        <LineChart title={t('交付进度（累计订单）')} series={charts.handed} {...chartProps} />
      </section>
    </div>
  );
}
