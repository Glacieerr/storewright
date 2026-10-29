import { useEffect, useState } from 'react';
import { activeAlerts, summary } from '@storewright/ops';
import { stepAt } from '@storewright/twin';
import { useApp } from '../state/store';
import { isReplaying, liveClient, viewNow, viewState } from '../live/link';
import { endReplay, replayAt, twinForecast, twinView } from '../live/twin';
import { hhmm } from './twinText';
import { t } from '../i18n';

/**
 * 孪生时间轴（决策记录 0016）：左边是过去（回放），中间是现在（实时），右边是未来 3 小时（推演）。
 * 拖到过去时场景回到那一刻的门店；拖到未来时显示从现在出发的推演。告警发生的时刻在轨道上标成红点。
 */
const HORIZON_MIN = 180;
const MIN = 60_000;

/** 拖动时间轴时稍等再取回放（拖动中不连发请求）；回到实时时一定要取消，否则晚到的回放会把场景拉回过去 */
let replayTimer: number | undefined;

export function goLive(): void {
  window.clearTimeout(replayTimer);
  endReplay();
  useApp.getState().setTwin('live');
}

export function TwinTimeline() {
  const twin = useApp((s) => s.twin);
  useApp((s) => s.twinVersion);
  useApp((s) => s.liveVersion);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const c = liveClient();
  const tv = twinView();
  const now = c ? c.now() : tick;
  // 轨道至少显示过去 30 分钟；能回放的最早时刻是第一条作业事件
  const earliest = tv.from ?? now - 60 * MIN;
  const from = Math.min(earliest, now - 30 * MIN);
  const end = now + HORIZON_MIN * MIN;
  const value = twin.mode === 'live' ? now : Math.min(end, Math.max(from, twin.t ?? now));
  const app = useApp.getState;

  // snap：拖动时间轴时，拖回到现在附近（45 秒内）就是实时；按钮跳转不吸附（门店刚开张、历史很短时也能回放）
  const go = (v: number, snap = true) => {
    window.clearTimeout(replayTimer);
    if (snap && Math.abs(v - now) < 45_000) return goLive();
    if (v < now) {
      const at = Math.min(now - 1000, Math.max(earliest, v));
      app().setTwin('replay', at);
      replayTimer = window.setTimeout(() => void replayAt(at), 150);
    } else {
      if (twin.mode === 'replay') endReplay();
      app().setTwin('forecast', v);
    }
  };
  const pct = (x: number) => Math.min(100, Math.max(0, ((x - from) / (end - from)) * 100));
  const alerts = Object.values(c?.state.alerts ?? {}).filter((a) => a.raisedAt >= from);
  const label =
    twin.mode === 'live'
      ? t('实时 {0}', hhmm(now))
      : twin.mode === 'replay'
        ? t('回放 {0}', hhmm(isReplaying() && !tv.loading ? viewNow() : value)) + (tv.loading ? ' …' : '')
        : t('推演 {0}（+{1} 分钟）', hhmm(value), Math.round((value - now) / MIN));

  return (
    <footer className="timeline twin-timeline">
      <div className="twin-modes" role="group" aria-label={t('孪生时间')}>
        <button className={twin.mode === 'replay' ? 'active' : ''} onClick={() => go(Math.max(earliest, (twin.mode === 'replay' ? value : now) - 30 * MIN), false)}>
          {t('◀ 回放')}
        </button>
        <button className={twin.mode === 'live' ? 'active' : ''} onClick={goLive}>
          <i className="dot-live" />
          {t('实时')}
        </button>
        <button className={twin.mode === 'forecast' ? 'active' : ''} onClick={() => go(Math.min(end, (twin.mode === 'forecast' ? value : now) + 60 * MIN), false)}>
          {t('推演 ▶')}
        </button>
      </div>
      <span className="mono now">{label}</span>
      <div className="track twin-track">
        <div className="twin-past" style={{ width: `${pct(now)}%` }} />
        <div className="twin-future" style={{ left: `${pct(now)}%` }} />
        {alerts.map((a) => (
          <i key={a.id} className={`alert-tick ${a.severity === 'ALARM' ? 'alarm' : 'warn'}`} style={{ left: `${pct(a.raisedAt)}%` }} />
        ))}
        <div className="now-mark" style={{ left: `${pct(now)}%` }} />
        <input type="range" min={from} max={end} step={MIN} value={value} aria-label={t('孪生时间轴：左边回放过去，右边推演未来')} onChange={(e) => go(Number(e.target.value))} />
      </div>
      <span className="mono muted">{t('+{0} 小时', HORIZON_MIN / 60)}</span>
    </footer>
  );
}

/** 场景上方的说明：回放到哪一刻、推演的结果；一键回到实时 */
export function TwinStageCard() {
  const twin = useApp((s) => s.twin);
  const delta = useApp((s) => s.forecastDelta);
  useApp((s) => s.twinVersion);
  useApp((s) => s.liveVersion);
  if (twin.mode === 'live') return null;
  const s = viewState();
  if (!s) return null;
  if (twin.mode === 'replay') {
    const sum = summary(s, viewNow());
    const n = activeAlerts(s).length;
    return (
      <div className="twin-card replay" role="status">
        <b>{t('回放 {0}', hhmm(viewNow()))}</b>
        <span>{t('当时：今日订单 {0} · 等待中的顾客 {1} · 设备告警 {2}', sum.orders, sum.waiting, n)}</span>
        <button className="link" onClick={goLive}>
          {t('回到实时')}
        </button>
      </div>
    );
  }
  const plan = delta.PICK || delta.STAGE || delta.HANDOFF ? { staffDelta: delta } : {};
  const f = twinForecast(plan);
  const st = f && twin.t !== undefined ? stepAt(f, twin.t) : undefined;
  if (!f || !st || twin.t === undefined) return null;
  return (
    <div className="twin-card forecast" role="status">
      <b>{t('推演 {0}（+{1} 分钟）', hhmm(twin.t), Math.round((twin.t - f.at) / MIN))}</b>
      <span>{t('预计：等候的顾客 {0} · 待交付 {1} 单 · 拣货积压 {2} 分钟 · 赶不上时段 {3} 单', st.waiting, st.ready, Math.round(st.backlogMin), st.late)}</span>
      <button className="link" onClick={goLive}>
        {t('回到实时')}
      </button>
    </div>
  );
}
