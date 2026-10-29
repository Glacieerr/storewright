import { useEffect, useMemo, useState } from 'react';
import { ADVICE_AREAS, type Advice, type AdviceArea, type FrontInput } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { setTime } from '../state/clock';
import { useStays } from '../scene/useSite';
import { clockText, pct } from './format';
import { adviceBody, adviceTitle, areaLabel, DISMISS_REASONS, effectGain, effectLabel, effectValue, reasonText } from './aiText';
import { AdoptCompare, AiSchedulePlan, DailyPlan, HandoffSummary } from './AiPlan';
import { t } from '../i18n';

/**
 * AI 建议（决策记录 0020）：按当前方案找问题——每条写清做什么、为什么、预计效果、把握多大；
 * 可以一键采纳（改动应用到方案上并重新仿真，可以撤销）或忽略（选一个原因，作为反馈记在本机）；「定位」跳到相关的时刻和地方。
 */
export function AiPanel() {
  const advice = useApp((s) => s.aiAdvice);
  const simStatus = useApp((s) => s.status);
  const timeline = useApp((s) => s.timeline);
  const log = useApp((s) => s.aiLog);
  const feedback = useApp((s) => s.aiFeedback);
  const [area, setArea] = useState<AdviceArea | 'ALL'>('ALL');
  const [showDismissed, setShowDismissed] = useState(false);
  const app = useApp.getState;
  const front = useFrontInput();

  // 方案变了就重新分析（仿真跑完之后；这个标签开着时）
  useEffect(() => {
    if (timeline && simStatus === 'ready' && advice.stale && advice.status !== 'running') void app().runAdvise(front);
  }, [timeline, simStatus, advice.stale, advice.status, app, front]);

  const list = advice.result?.advice ?? [];
  const dismissed = useMemo(() => new Set(log.filter((e) => e.status === 'dismissed').map((e) => e.id)), [log]);
  const shown = list.filter((a) => (area === 'ALL' || a.area === area) && (showDismissed || !dismissed.has(a.id)));
  const order = { critical: 0, warn: 1, info: 2 } as const;
  shown.sort((a, b) => order[a.severity] - order[b.severity] || (b.confidence - a.confidence) || (a.from ?? 0) - (b.from ?? 0));
  const adopted = log.filter((e) => e.status === 'adopted');
  const days = advice.result?.seeds.length ?? 4;

  return (
    <div className="ai-panel">
      <p className="hint">
        {t('AI 按当前方案的仿真结果找问题，再换 {0} 天（随机种子）看会不会反复出现；能执行的建议先在方案上试一遍，给出预计效果。采纳后改动应用到方案上并重新仿真，可以撤销。', days - 1)}
      </p>
      <div className="ai-status">
        {advice.status === 'running' && (
          <span>
            <span className="spinner" aria-hidden /> {t('正在分析当前方案和另外 {0} 天…', days - 1)}
          </span>
        )}
        {advice.status === 'ready' && advice.result && <span className="muted">{t('{0} 条建议 · 分析用时 {1} 秒', list.length, Math.round(advice.result.ms / 100) / 10)}</span>}
        {advice.status === 'error' && <span className="warn">{t('分析失败，可以重试。')}</span>}
        <button className="chip" disabled={advice.status === 'running'} onClick={() => void app().runAdvise(front)}>
          {t('重新分析')}
        </button>
      </div>
      <DailyPlan />
      <HandoffSummary />
      <AiSchedulePlan />
      <div className="chips gap-top" role="group" aria-label={t('建议的方向')}>
        <button className={area === 'ALL' ? 'chip active' : 'chip'} onClick={() => setArea('ALL')}>
          {t('全部')} {list.length}
        </button>
        {ADVICE_AREAS.map((k) => {
          const n = list.filter((a) => a.area === k).length;
          return (
            <button key={k} className={area === k ? 'chip active' : 'chip'} disabled={!n} onClick={() => setArea(k)}>
              {areaLabel(k)} {n}
            </button>
          );
        })}
      </div>
      {advice.status === 'ready' && !shown.length && <p className="muted pad">{t('当前方案没有发现需要处理的问题。')}</p>}
      <div className="advice-list">
        {shown.map((a) => (
          <AdviceCard key={a.id} a={a} days={days} />
        ))}
      </div>
      {dismissed.size > 0 && (
        <button className="linklike gap-top" onClick={() => setShowDismissed(!showDismissed)}>
          {showDismissed ? t('隐藏已忽略的建议') : t('显示已忽略的 {0} 条建议', dismissed.size)}
        </button>
      )}
      {adopted.length > 0 && (
        <section className="gap-top">
          <h3>{t('已采纳（{0}）', adopted.length)}</h3>
          <ul className="adopted">
            {adopted.map((e) => (
              <li key={e.id}>
                <span>{adviceTitle({ id: e.id, area: e.area, code: e.code, params: e.params, severity: 'info', reasons: [], confidence: 0 })}</span>
                <button className="linklike" onClick={() => app().undoAdvice(e.id)}>
                  {t('撤销')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AdoptCompare />
      {(feedback.adopted > 0 || feedback.dismissed > 0) && (
        <p className="hint gap-top">
          {t('本机累计：采纳 {0} 条、忽略 {1} 条', feedback.adopted, feedback.dismissed)}
          {Object.keys(feedback.reasons).length > 0 && ' · ' + t('忽略原因：{0}', reasonSummary(feedback.reasons))}
        </p>
      )}
    </div>
  );
}

/** 忽略原因按次数从多到少 */
function reasonSummary(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => t(DISMISS_REASONS.find(([c]) => c === k)?.[1] ?? k) + ' ' + n)
    .join('、');
}

function AdviceCard({ a, days }: { a: Advice; days: number }) {
  const log = useApp((s) => s.aiLog);
  const adopted = log.some((e) => e.id === a.id && e.status === 'adopted');
  const dismissed = log.some((e) => e.id === a.id && e.status === 'dismissed');
  const [asking, setAsking] = useState(false);
  const app = useApp.getState;
  return (
    <article className={`advice ${a.severity}${adopted ? ' adopted' : ''}${dismissed ? ' dismissed' : ''}`}>
      <div className="advice-head">
        <span className={`sev ${a.severity}`} aria-hidden />
        <span>{areaLabel(a.area)}</span>
        {a.from !== undefined && <span className="muted">{a.to !== undefined && a.to !== a.from ? `${clockText(a.from)}–${clockText(a.to)}` : clockText(a.from)}</span>}
      </div>
      <h4>{adviceTitle(a)}</h4>
      <p className="advice-body">{adviceBody(a)}</p>
      <div className="advice-why">
        <b>{t('为什么')}</b>
        <ul>
          {a.reasons.map((r) => (
            <li key={r.factor}>
              <span className="why-bar" style={{ width: `${Math.round(r.weight * 100)}%` }} aria-hidden />
              <span>{reasonText(r)}</span>
            </li>
          ))}
        </ul>
      </div>
      {a.effect && a.effect.length > 0 && (
        <div className="advice-effect">
          <b>{t('预计效果')}</b>
          {a.effect.map((e) => (
            <span key={e.metric} className={effectGain(e) > 0 ? 'gain' : effectGain(e) < 0 ? 'loss' : ''}>
              {effectLabel(e)}{' '}
              {e.metric === 'LABOR_HOURS' ? `${e.after - e.before >= 0 ? '+' : '−'}${effectValue(e, Math.abs(e.after - e.before))}` : `${effectValue(e, e.before)} → ${effectValue(e, e.after)}`}
            </span>
          ))}
        </div>
      )}
      <div className="advice-conf">
        <b>{t('把握')}</b>
        <span className="conf-bar" aria-hidden>
          <span style={{ width: `${Math.round(a.confidence * 100)}%` }} />
        </span>
        <span>{pct(a.confidence)}</span>
        {a.recur && <span className="muted">{t('（看了 {0} 天，{1} 天出现）', a.recur.of, a.recur.days)}</span>}
        {!a.recur && <span className="muted">{a.area === 'FRONT' ? t('（按排队论和停车场模型估算）') : t('（在 {0} 天里试过）', Math.min(2, days))}</span>}
      </div>
      <div className="advice-actions">
        {a.action && !adopted && (
          <button className="primary" onClick={() => app().adoptAdvice(a)}>
            {t('采纳')}
          </button>
        )}
        {adopted && (
          <>
            <span className="ok">{t('已采纳')}</span>
            <button className="linklike" onClick={() => app().undoAdvice(a.id)}>
              {t('撤销')}
            </button>
          </>
        )}
        {!adopted && !dismissed && <button onClick={() => setAsking(!asking)}>{t('忽略')}</button>}
        {dismissed && (
          <button className="linklike" onClick={() => app().undoAdvice(a.id)}>
            {t('恢复')}
          </button>
        )}
        {a.focus && <button onClick={() => locate(a)}>{t('定位')}</button>}
      </div>
      {asking && (
        <div className="chips gap-top" role="group" aria-label={t('忽略的原因')}>
          {DISMISS_REASONS.map(([code, label]) => (
            <button
              key={code}
              className="chip"
              onClick={() => {
                app().dismissAdvice(a, code);
                setAsking(false);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * 前场的输入：每小时到店的顾客（每辆进店购物的车算一次结账，员工车、房车不算）、停车场每小时最多停了几辆车，
 * 各楼层的人工收银通道和自助收银机；在二楼结账的比例按二楼货位的比例（顾客最后逛的是二楼就在二楼结账）。
 */
function useFrontInput(): FrontInput {
  const stays = useStays();
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const hours = useApp((s) => s.config.hours);
  return useMemo(() => {
    const shoppersByHour = new Array<number>(24).fill(0);
    const parkingByHour = new Array<number>(24).fill(0);
    for (const list of stays)
      for (const st of list) {
        if (st.staff || st.long) continue;
        const h = Math.floor(st.arrive / 3600);
        if (h >= 0 && h < 24) shoppersByHour[h] = (shoppersByHour[h] as number) + 1;
      }
    for (let h = 0; h < 24; h++) {
      const t = h * 3600 + 1800;
      parkingByHour[h] = stays.filter((list) => list.some((st) => st.arrive <= t && t < st.leave)).length;
    }
    const locs = [...model.locations.values()];
    const f0 = geo.floors[0]?.floorId ?? 'F1';
    const shareOf = (fid: string) => locs.filter((l) => model.nodes[l.nodeId]?.floorId === fid).length / Math.max(1, locs.length);
    const ids = [...new Set(geo.checkouts.map((c) => c.floorId))];
    const upper = ids.filter((id) => id !== f0).reduce((a, id) => a + shareOf(id), 0);
    const floors = ids.map((id) => ({
      floorId: id,
      manual: geo.checkouts.filter((c) => c.floorId === id && !c.self).length,
      self: geo.checkouts.filter((c) => c.floorId === id && c.self).length,
      share: id === f0 ? 1 - upper : shareOf(id),
    }));
    return { shoppersByHour, parkingByHour, parkingSpots: Math.max(0, geo.lot.spots.length - geo.lot.pickupCount), floors, open: hours.openMin * 60, close: hours.closeMin * 60 };
  }, [stays, geo, model, hours]);
}

/** 定位：跳到相关的时刻，镜头对准相关的地方（到货车辆跟随） */
function locate(a: Advice): void {
  const f = a.focus;
  if (!f) return;
  const s = useApp.getState();
  setTime(f.t);
  const g = s.simGeo;
  const f0 = g.floors[0];
  if (!f0) return;
  if (f.kind === 'truck' && f.ref) {
    s.setFollow(f.ref);
    return;
  }
  s.setFollow(undefined);
  const area = (kind: string) => g.areas.find((x) => x.kind === kind);
  const center = (x: { x0: number; x1: number; z0: number; z1: number } | undefined, r: number) => (x ? s.frame((x.x0 + x.x1) / 2, 0, (x.z0 + x.z1) / 2, r) : undefined);
  switch (f.kind) {
    case 'dock':
      s.frame(f0.maxX - 12, 0, f0.maxZ + 24, 42);
      break;
    case 'rack':
      center(area('RACKS'), 18);
      break;
    case 'staging':
      center(area('STAGING'), 16);
      break;
    case 'lift':
      center(area('UNLOAD') ?? area('RACKS'), 16);
      break;
    case 'checkout': {
      const c = g.checkouts[0];
      if (c) s.frame(c.x, c.y, c.z + 2, 16);
      break;
    }
    case 'lot':
      s.frame((g.lot.minX + g.lot.maxX) / 2, 0, (g.lot.edgeZ + f0.minZ) / 2, 50);
      break;
    default:
      break;
  }
}
