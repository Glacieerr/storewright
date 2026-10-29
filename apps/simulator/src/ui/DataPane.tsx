import { lazy, Suspense, useState } from 'react';
import { useApp, type DataTab } from '../state/store';
import type { NotificationLevel } from '../sim/protocol';
import { LiveData } from './LiveData';
import { EventFeed } from './Inspector';
import { t } from '../i18n';

// 策略对比、方案与报告、门店定制按需加载（打开对应标签时才下载）
const ComparePanel = lazy(() => import('./ComparePanel').then((m) => ({ default: m.ComparePanel })));
const ReportPanel = lazy(() => import('./ReportPanel').then((m) => ({ default: m.ReportPanel })));
const EditorPanel = lazy(() => import('./EditorPanel').then((m) => ({ default: m.EditorPanel })));
const OpsPanel = lazy(() => import('./OpsPanel').then((m) => ({ default: m.OpsPanel })));
const AiPanel = lazy(() => import('./AiPanel').then((m) => ({ default: m.AiPanel })));

const TABS: Array<[DataTab, string]> = [
  ['live', '实时数据'],
  ['ai', 'AI 建议'],
  ['compare', '策略对比'],
  ['report', '方案与报告'],
  ['events', '事件'],
  ['edit', '门店定制'],
  ['ops', '数字孪生'],
];

const FILTERS: Array<[string, string, ReadonlySet<NotificationLevel> | undefined]> = [
  ['all', '全部', undefined],
  ['warn', '提醒及以上', new Set<NotificationLevel>(['warn', 'alert'])],
  ['alert', '只看警报', new Set<NotificationLevel>(['alert'])],
];

function EventsTab() {
  const [filter, setFilter] = useState('all');
  const levels = FILTERS.find(([k]) => k === filter)?.[2];
  return (
    <div className="events-tab">
      <div className="chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>
            {t(label)}
          </button>
        ))}
      </div>
      <p className="hint">{t('按时间倒序，随播放实时更新。点击带对象的事件可在场景中定位。')}</p>
      <EventFeed limit={150} levels={levels} />
    </div>
  );
}

/** 数据面板：和场景并排显示，切换标签不影响场景播放 */
export function DataPane() {
  const tab = useApp((s) => s.tab);
  const mode = useApp((s) => s.mode);
  const compareStatus = useApp((s) => s.compare.status);
  const multiStatus = useApp((s) => s.multiDay.status);
  const liveStatus = useApp((s) => s.live.status);
  // AI 建议：没忽略的紧急、提醒类条数（决策记录 0020）
  const aiOpen = useApp((s) => (s.aiAdvice.result?.advice ?? []).filter((a) => a.severity !== 'info' && !s.aiLog.some((e) => e.id === a.id)).length);
  const aiRunning = useApp((s) => s.aiAdvice.status === 'running');
  const app = useApp.getState;

  return (
    <aside className="data-pane" aria-label={t('数据与分析')}>
      <div className="pane-head">
        <div className="tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => app().setTab(k)}>
              {t(label)}
              {k === 'ai' && aiRunning && <span className="spinner" aria-label={t('分析中')} />}
              {k === 'ai' && !aiRunning && aiOpen > 0 && <span className="tab-badge">{aiOpen}</span>}
              {k === 'compare' && compareStatus === 'running' && <span className="spinner" aria-label={t('计算中')} />}
              {k === 'report' && multiStatus === 'running' && <span className="spinner" aria-label={t('多天模拟中')} />}
              {k === 'edit' && mode === 'edit' && <span className="live-dot" aria-label={t('编辑中')} />}
              {k === 'ops' && liveStatus === 'live' && <span className="live-dot ok" aria-label={t('已连接')} />}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => app().swapSplit()} title={t('场景与数据左右互换')} aria-label={t('场景与数据左右互换')}>
          ⇄
        </button>
      </div>
      <div className="pane-body" role="tabpanel">
        <Suspense fallback={<p className="muted pad">{t('加载中…')}</p>}>
          {tab === 'live' && <LiveData />}
          {tab === 'ai' && <AiPanel />}
          {tab === 'compare' && <ComparePanel />}
          {tab === 'report' && <ReportPanel />}
          {tab === 'events' && <EventsTab />}
          {tab === 'edit' && <EditorPanel />}
          {tab === 'ops' && <OpsPanel />}
        </Suspense>
      </div>
    </aside>
  );
}
