import { useMemo } from 'react';
import { congestionAt, DEFAULT_TRAFFIC, ROLES, type Role } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { ROLE_COLOR, ROLE_LABEL, ZONE_LABEL } from '../scene/palette';
import { LineChart, type ChartSeries } from './Chart';
import { at, CHART_ZONE_COLOR, clockText, num, pct } from './format';
import { IncidentPanel } from './IncidentPanel';
import { SEASON_LABEL, WEATHER_LABEL, type Season, type Weather } from '../scene/site';
import { WEATHER_KIND_LABEL, weatherAt, weatherPlan, type WeatherKind } from '../sim/weatherPlan';

const WEATHER_KIND_LABEL_RAW: Record<WeatherKind, string> = { clear: '晴', cloudy: '多云', rain: '雨', snow: '雪', fog: '雾' };
import { t } from '../i18n';

/** 实时数据：当前时刻的指标、全天曲线（播放到哪里画到哪里）、排班与情景注入 */
export function LiveData() {
  const tm = useClock(5);
  const timeline = useApp((s) => s.timeline);
  const staffing = useApp((s) => s.staffing);
  const demandFactor = useApp((s) => s.demandFactor);
  const longWait = useApp((s) => s.config.rules.handoff.longWaitMin);
  const traffic = useApp((s) => s.site.traffic);
  const weather = useApp((s) => s.site.weather ?? 'clear');
  const season = useApp((s) => s.site.season ?? 'autumn');
  const nightCrew = useApp((s) => s.nightCrew);
  const shelfStock = useApp((s) => s.shelfStock);
  const crewSize = useApp((s) => s.nightCrewSize());
  const hours = useApp((s) => s.config.hours);
  const app = useApp.getState;

  const charts = useMemo(() => {
    if (!timeline) return undefined;
    const s = timeline.series;
    const zones = (['AMBIENT', 'CHILLED', 'FROZEN'] as const).map<ChartSeries>((z) => ({ label: ZONE_LABEL[z], color: CHART_ZONE_COLOR[z], values: s.stagingOcc[z] }));
    const util = ROLES.map<ChartSeries>((r) => ({
      label: ROLE_LABEL[r],
      color: ROLE_COLOR[r],
      values: s.busy[r].map((b, i) => {
        const on = s.onShift[r][i] ?? 0;
        return on > 0 ? b / on : 0;
      }),
    }));
    return {
      handed: [{ label: '已交付', color: '#2f9a5f', values: s.handedOff }],
      waiting: [{ label: '等待车辆', color: '#ee8a35', values: s.waiting }],
      avgWait: [{ label: '平均等待', color: '#3b6ea8', values: s.avgWaitMin }],
      picked: [{ label: '已拣件数', color: '#8a6bd6', values: s.picked }],
      zones,
      util,
      night: [{ label: '已上架', color: '#2f5d8a', values: s.nightStocked }],
      rack: [{ label: '货架托盘', color: '#e8a33d', values: s.rackUsed }],
      pharmacy: (() => {
        const ph = timeline.pharmacy;
        if (!ph) return [];
        const n = s.handedOff.length;
        const q = new Array<number>(n).fill(0);
        const at = (tm: number) => Math.min(n - 1, Math.max(0, Math.floor((tm - s.t0) / s.step)));
        for (const v of ph.visits) {
          if (v.start === undefined) continue;
          q[at(v.arrive)] = (q[at(v.arrive)] as number) + 1;
          q[at(v.start)] = (q[at(v.start)] as number) - 1;
        }
        for (let i = 1; i < n; i++) q[i] = (q[i] as number) + (q[i - 1] as number);
        return [{ label: '排队人数', color: '#2f7db5', values: q }];
      })(),
      // 货架空的商品数（货架存量模型开启时）：按 15 分钟的采样对齐到曲线网格
      shelfEmpty: (() => {
        const sh = timeline.shelf;
        if (!sh) return [];
        const n = s.handedOff.length;
        const v = new Array<number>(n).fill(0);
        for (let i = 0; i < n; i++) {
          const tm = s.t0 + i * s.step;
          let last = 0;
          for (const [ct, c] of sh.emptyCurve) {
            if (ct > tm) break;
            last = c;
          }
          v[i] = last;
        }
        const restocked = new Array<number>(n).fill(0);
        for (const e of sh.events) if (e.kind === 'DONE') {
          const i = Math.min(n - 1, Math.max(0, Math.floor((e.t - s.t0) / s.step)));
          restocked[i] = (restocked[i] as number) + 1;
        }
        for (let i = 1; i < n; i++) restocked[i] = (restocked[i] as number) + (restocked[i - 1] as number);
        return [
          { label: '货架空的商品', color: '#d13b2f', values: v },
          { label: '累计补货', color: '#3fa36b', values: restocked },
        ];
      })(),
      service: timeline.autoService.map((a) => [
        { label: '作业中', color: '#c8433a', values: a.inService },
        { label: '排队', color: '#ee8a35', values: a.queue },
      ]),
    };
  }, [timeline]);

  if (!timeline || !charts) return <p className="muted pad">{t('正在运行第一次仿真…')}</p>;
  const s = timeline.series;
  const m = timeline.metrics;
  const hour = Math.floor(tm / 3600);
  const chartProps = { t0: s.t0, step: s.step, now: tm };
  const jam = congestionAt({ ...DEFAULT_TRAFFIC, level: traffic }, tm);
  const jamText = t(traffic === 0 ? '不模拟' : jam < 0.3 ? '畅通' : jam < 0.6 ? '缓行' : jam < 1 ? '拥堵' : '严重拥堵');
  // 最近一小时到店车辆的平均路上延误
  const recent = timeline.cars.filter((c) => c.arriveAt <= tm && c.arriveAt > tm - 3600);
  const recentDelay = recent.length ? recent.reduce((n, c) => n + (c.delaySec ?? 0), 0) / recent.length / 60 : 0;

  return (
    <div className="live">
      <section className="live-head">
        <div className="clock mono">{clockText(tm)}</div>
        <div className="kpi-grid">
          <div className="kpi">
            <span className="kpi-label">{t('已交付')}</span>
            <span className="kpi-value">
              {num(at(s, s.handedOff, tm))}
              <small> / {timeline.orderCount}</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">{t('正在等待')}</span>
            <span className="kpi-value">
              {num(at(s, s.waiting, tm))}
              <small> {t('辆')}</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">{t('平均等待')}</span>
            <span className="kpi-value">
              {num(at(s, s.avgWaitMin, tm), 1)}
              <small> {t('分钟')}</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">{t('未按时就绪')}</span>
            <span className="kpi-value">
              {num(at(s, s.late, tm))}
              <small> {t('单')}</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">{t('已拣件数')}</span>
            <span className="kpi-value">
              {num(at(s, s.picked, tm))}
              <small> {t('件')}</small>
            </span>
          </div>
          <div className={`kpi${jam >= 0.6 ? ' hot' : ''}`}>
            <span className="kpi-label">{t('周边路况')}</span>
            <span className="kpi-value">
              {jamText}
              {traffic > 0 && <small> {t('· 到店晚 {0} 分', num(recentDelay, 1))}</small>}
            </span>
          </div>
        </div>
      </section>

      <section className="chart-grid">
        <LineChart title={t('交付进度（累计订单）')} series={charts.handed} yMax={Math.max(1, timeline.orderCount)} {...chartProps} />
        <LineChart title={t('正在等待的车辆')} series={charts.waiting} {...chartProps} />
        <LineChart title={t('平均到店等待（分钟）')} series={charts.avgWait} format={(v) => v.toFixed(1)} {...chartProps} />
        <LineChart title={t('暂存占用率')} series={charts.zones} yMax={1} format={(v) => pct(v)} {...chartProps} />
        <LineChart title={t('岗位利用率（忙碌 / 在岗）')} series={charts.util} yMax={1} format={(v) => pct(v)} {...chartProps} />
        <LineChart title={t('累计拣货件数')} series={charts.picked} {...chartProps} />
        {timeline.pharmacy && (
          <LineChart title={t('药房（{0} 个柜台，全天 {1} 人，平均等待 {2} 分钟）', timeline.pharmacy.counters, timeline.pharmacy.metrics.patients, num(timeline.pharmacy.metrics.avgWaitMin, 1))} series={charts.pharmacy} {...chartProps} />
        )}
        <LineChart
          title={t('后仓货架（{0} 个托盘位；今日到货 {1} 托，平均卸货到入库 {2} 分钟）', timeline.inbound.metrics.rackCapacity, timeline.inbound.metrics.palletsReceived, num(timeline.inbound.metrics.dockToStockMin, 0))}
          series={charts.rack}
          yMax={Math.max(1, timeline.inbound.metrics.rackCapacity)}
          {...chartProps}
        />
        {timeline.inbound.nightCrew > 0 && (
          <LineChart title={t('夜班补货（应补 {0} 箱，开门时补齐率 {1}）', timeline.inbound.metrics.totalCases, pct(timeline.inbound.metrics.readyAtOpen))} series={charts.night} yMax={Math.max(1, timeline.inbound.metrics.totalCases)} {...chartProps} />
        )}
        {timeline.shelf && (
          <LineChart
            title={t('货架存量（全天少卖 {0} 件；补货 {1} 次，平均 {2} 分钟补回）', timeline.shelf.lostSalesUnits, timeline.shelf.restocks, timeline.shelf.avgEmptyMin)}
            series={charts.shelfEmpty}
            {...chartProps}
          />
        )}
        {timeline.autoService.map((a, i) => (
          <LineChart key={a.facilityId} title={t('汽车服务中心 · 已完成 {0} 辆', a.jobs.filter((j) => j.end !== undefined && j.end <= tm).length)} series={charts.service[i] ?? []} {...chartProps} />
        ))}
      </section>

      <div className="live-controls">
        <IncidentPanel />
        <section>
          <h3>{t('岗位排班 · {0}:00 这一小时', String(hour).padStart(2, '0'))}</h3>
          <table className="staff">
            <tbody>
              {ROLES.map((r: Role) => (
                <tr key={r}>
                  <td>
                    <span className="dot" style={{ background: ROLE_COLOR[r] }} />
                    {ROLE_LABEL[r]}
                  </td>
                  <td className="mono">
                    {t('{0}/{1} 忙', num(at(s, s.busy[r], tm)), num(at(s, s.onShift[r], tm)))}
                  </td>
                  <td className="staff-adjust">
                    <button aria-label={t('减少{0}', ROLE_LABEL[r])} onClick={() => app().adjustStaff(r, -1)}>
                      −
                    </button>
                    <span className="mono">{staffing[r][hour] ?? 0}</span>
                    <button aria-label={t('增加{0}', ROLE_LABEL[r])} onClick={() => app().adjustStaff(r, 1)}>
                      ＋
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">{t('调整从当前小时生效。系统在后台从头重算这一天（约 0.1 秒），画面不中断。')}</p>
        </section>

        <section>
          <h3>{t('情景注入')}</h3>
          <div className="chips">
            <button className={demandFactor > 1 ? 'chip active' : 'chip'} onClick={() => app().setDemandFactor(demandFactor > 1 ? 1 : 1.3)}>
              {t('订单高峰 +30%')}
            </button>
            <button className="chip" onClick={() => app().adjustStaff('pick', -1)}>
              {t('拣货员请假 1 人')}
            </button>
            <button className="chip" onClick={() => app().resetScenario()}>
              {t('恢复默认')}
            </button>
          </div>
          <div className="chips gap-top" role="group" aria-label={t('天气')}>
            <span className="chips-label">{t('天气')}</span>
            {(Object.keys(WEATHER_LABEL) as Weather[]).map((w) => (
              <button key={w} className={weather === w ? 'chip active' : 'chip'} onClick={() => app().setSite({ weather: w })}>
                {WEATHER_LABEL[w]}
              </button>
            ))}
          </div>
          {weather === 'dynamic' && <WeatherStrip tm={tm} />}
          <div className="chips gap-top" role="group" aria-label={t('季节')}>
            <span className="chips-label">{t('季节')}</span>
            {(Object.keys(SEASON_LABEL) as Season[]).map((k) => (
              <button key={k} className={season === k ? 'chip active' : 'chip'} onClick={() => app().setSite({ season: k })}>
                {SEASON_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="chips gap-top" role="group" aria-label={t('道路拥堵')}>
            <span className="chips-label">{t('道路拥堵')}</span>
            {([0, 1, 2] as const).map((lv) => (
              <button key={lv} className={traffic === lv ? 'chip active' : 'chip'} onClick={() => app().setSite({ traffic: lv })}>
                {t(lv === 0 ? '关闭' : lv === 1 ? '一般' : '严重')}
              </button>
            ))}
          </div>
          <h3 className="gap">{t('货架存量')}</h3>
          <div className="chips" role="group" aria-label={t('货架存量模型')}>
            <button className={shelfStock ? 'chip active' : 'chip'} onClick={() => app().setShelfStock(!shelfStock)}>
              {shelfStock ? t('货架存量模型 开') : t('货架存量模型 关')}
            </button>
            {shelfStock && (
              <button className={useApp.getState().overlay === 'stock' ? 'chip active' : 'chip'} onClick={() => app().setOverlay(useApp.getState().overlay === 'stock' ? 'temp' : 'stock')}>
                {t('场景按存量着色')}
              </button>
            )}
          </div>
          <p className="hint">{t('开启后，货架上有没有由存量决定：店内销售和线上拣货消耗货架，拣货员遇到空货架时转后仓补取，后仓补取员再去后仓取箱补货。关闭时按 Phase 1 的概率模型（结果可复现）。')} {t('开启时后仓补取岗位在营业时间内每小时多 1 名白天补货员。')}</p>
          <h3 className="gap">{t('特殊班组')}</h3>
          <div className="chips" role="group" aria-label={t('夜班补货组')}>
            <button className={nightCrew.enabled ? 'chip active' : 'chip'} onClick={() => app().setNightCrew({ enabled: !nightCrew.enabled })}>
              {nightCrew.enabled ? t('夜班补货组 开') : t('夜班补货组 关')}
            </button>
            {nightCrew.enabled && (
              <span className="staff-adjust">
                <button aria-label={t('减少夜班人数')} onClick={() => app().setNightCrew({ crew: Math.max(1, crewSize - 1) })}>
                  −
                </button>
                <span className="mono">{crewSize}</span>
                <button aria-label={t('增加夜班人数')} onClick={() => app().setNightCrew({ crew: crewSize + 1 })}>
                  ＋
                </button>
                <span className="muted"> {t('人')}</span>
              </span>
            )}
          </div>
          <p className="hint">{t('雨雪雾天路上更慢；雨雪天车边装车变慢、线上订单增加（雨 +8%，雪 +15%），到店购物的人减少。季节只改变日照时间和植物颜色。')}</p>
          <p className="hint">
            {t('夜班 {0}–次日 {1} 只做补货，人数少；需补箱数按当天线上件数和线上占比假设估算。', clockText(hours.closeMin * 60), clockText(hours.openMin * 60))}
            {timeline.inbound.nightCrew > 0 && timeline.inbound.metrics.backlogCases > 0 && <span className="warn"> {t('当前人数下开门时还有 {0} 箱没上架。', timeline.inbound.metrics.backlogCases)}</span>}
          </p>
          <h3 className="gap">{t('全天结果（当前策略）')}</h3>
          <dl className="facts">
            <dt>{t('拣货效率')}</dt>
            <dd>{num(m.uph, 1)} {t('件/工时')}</dd>
            <dt>{t('满足率')}</dt>
            <dd>{pct(m.fillRate, 2)}</dd>
            <dt>{t('平均等待')}</dt>
            <dd>{num(m.avgWaitMin, 2)} {t('分钟')}</dd>
            <dt>{t('等待 ≥ {0} 分钟', longWait)}</dt>
            <dd>{num(m.longWaitPct, 1)}%</dd>
            <dt>{t('超重框')}</dt>
            <dd>{num(m.overweightTotePct, 1)}%</dd>
            <dt>{t('门口停留')}</dt>
            <dd>{num(m.avgReadyDwellMin, 1)} {t('分钟')}</dd>
            <dt>{t('单均作业工时')}</dt>
            <dd>{num(m.laborMinutesPerOrder, 1)} {t('分钟')}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

const KIND_COLOR: Record<WeatherKind, string> = { clear: '#f2c94c', cloudy: '#b8c2cc', rain: '#5b8fd1', snow: '#e6eef5', fog: '#9aa6ae' };

/** 「多变」天气：全天的天气条、当前时刻和下一次变化 */
function WeatherStrip({ tm }: { tm: number }) {
  const seed = useApp((s) => s.site.seed);
  const season = useApp((s) => s.site.season ?? 'autumn');
  const timeline = useApp((s) => s.timeline);
  const plan = useMemo(() => weatherPlan(seed, season), [seed, season]);
  const t0 = timeline?.start ?? 5 * 3600;
  const t1 = timeline?.end ?? 31 * 3600;
  const span = Math.max(1, t1 - t0);
  const now = weatherAt(plan, tm);
  const next = plan.find((p) => p.start > tm);
  const pct = (v: number) => `${(Math.min(1, Math.max(0, (v - t0) / span)) * 100).toFixed(2)}%`;
  const intensity = now.kind === 'rain' ? (now.rain > 0.7 ? '大雨' : now.rain > 0.4 ? '中雨' : '小雨') : now.kind === 'snow' ? (now.snow > 0.7 ? '大雪' : '小雪') : WEATHER_KIND_LABEL_RAW[now.kind];
  return (
    <div className="weather-strip" aria-label={t('今天的天气')}>
      <div className="ws-bar">
        {plan
          .filter((p) => p.end > t0 && p.start < t1)
          .map((p, i) => (
            <span key={i} title={`${clockText(Math.max(p.start, t0))}–${clockText(Math.min(p.end, t1))} ${WEATHER_KIND_LABEL[p.kind]}`} style={{ left: pct(Math.max(p.start, t0)), width: `calc(${pct(Math.min(p.end, t1))} - ${pct(Math.max(p.start, t0))})`, background: KIND_COLOR[p.kind], opacity: p.kind === 'rain' || p.kind === 'snow' ? 0.5 + 0.5 * p.strength : 1 }} />
          ))}
        <i style={{ left: pct(tm) }} />
      </div>
      <p className="hint">
        {t('现在：{0}', t(intensity))}
        {now.wet > 0.2 && now.kind !== 'rain' ? t('（路面还湿）') : ''}
        {next ? ' · ' + t('{0} 起转{1}', clockText(next.start), WEATHER_KIND_LABEL[next.kind]) : ''}
      </p>
    </div>
  );
}
