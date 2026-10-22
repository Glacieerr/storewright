import type { TemplateName } from '@storewright/store-config';
import { useApp, type BuildingView, type Overlay, type Quality, type ViewMode } from '../state/store';
import type { PolicyName } from '../sim/protocol';
import { POLICY_LABEL, TEMPLATE_LABEL } from './format';
import { t } from '../i18n';
import { summary } from '@storewright/ops';
import { liveClient } from '../live/link';

const VIEWS: Array<[ViewMode, string]> = [
  ['iso', '2.5D'],
  ['3d', '3D'],
  ['top', '俯视'],
];

/** 嵌在展示页时顶栏右侧的门店实况：连接状态、今日订单、等待中的顾客 */
function EmbeddedLive() {
  const live = useApp((s) => s.live);
  useApp((s) => s.liveVersion);
  const c = liveClient();
  if (live.status === 'off' || !c) return <span className="live-chip off">{live.status === 'off' && live.error ? t('连接失败：{0}', live.error) : t('连接中…')}</span>;
  const sum = summary(c.state, Date.now() + c.offset);
  return (
    <span className={`live-chip ${live.status}`}>
      <i />
      {live.status === 'live' ? t('已连接 {0}', c.statics?.name ?? live.storeId) : t('连接中断，正在重连')} · {t('今日订单 {0}', sum.orders)} · {t('等待中的顾客 {0}', sum.waiting)}
    </span>
  );
}

export function TopBar() {
  const template = useApp((s) => s.template);
  const policy = useApp((s) => s.policy);
  const ai = useApp((s) => s.ai);
  const view = useApp((s) => s.view);
  const floor = useApp((s) => s.floor);
  const overlay = useApp((s) => s.overlay);
  const mode = useApp((s) => s.mode);
  const lang = useApp((s) => s.lang);
  const status = useApp((s) => s.status);
  const floors = useApp((s) => s.config.layout.floors);
  const custom = useApp((s) => s.config.template === 'custom');
  const quality = useApp((s) => s.quality);
  const buildingView = useApp((s) => s.buildingView);
  const cutPos = useApp((s) => s.cutPos);
  const timeline = useApp((s) => s.timeline);
  const app = useApp.getState;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>▦</span>
        <strong>Storewright</strong>
        <span className="muted">{t('运营模拟器')}</span>
      </div>

      <label className="field">
        <span>{t('门店')}</span>
        <select value={custom ? 'custom' : template} disabled={mode === 'edit'} onChange={(e) => app().setTemplate(e.target.value as TemplateName)}>
          {(Object.keys(TEMPLATE_LABEL) as TemplateName[]).map((t) => (
            <option key={t} value={t}>
              {TEMPLATE_LABEL[t]}
            </option>
          ))}
          {custom && (
            <option value="custom" disabled>
              {t('自定义门店')}
            </option>
          )}
        </select>
      </label>

      <label className="field">
        <span>{t('策略')}</span>
        <select value={policy} onChange={(e) => app().setPolicy(e.target.value as PolicyName)}>
          {(Object.keys(POLICY_LABEL) as PolicyName[]).map((p) => (
            <option key={p} value={p}>
              {POLICY_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <button className={ai ? 'chip active' : 'chip'} aria-pressed={ai} onClick={() => app().setAi(!ai)} title={t('AI 模块：按订单预测排班（总工时不变）、修正顾客到店时间、替代推荐')}>
        AI
      </button>

      <div className="segmented" role="group" aria-label={t('视角')}>
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? 'active' : ''} onClick={() => app().setView(v)}>
            {t(label)}
          </button>
        ))}
      </div>

      {floors.length > 1 && (
        <div className="segmented" role="group" aria-label={t('楼层')}>
          {floors.map((f) => (
            <button key={f.id} className={floor === f.id ? 'active' : ''} onClick={() => app().setFloor(f.id)}>
              {f.name}
            </button>
          ))}
          {view === '3d' && (
            <button className={floor === 'ALL' ? 'active' : ''} onClick={() => app().setFloor('ALL')}>
              {t('全部')}
            </button>
          )}
        </div>
      )}

      <div className="segmented" role="group" aria-label={t('建筑')}>
        {(
          [
            ['interior', '内部'],
            ['cutaway', '半剖'],
            ['exterior', '外观'],
          ] as Array<[BuildingView, string]>
        ).map(([v, label]) => (
          <button key={v} className={buildingView === v ? 'active' : ''} onClick={() => app().setBuildingView(v)} title={v === 'cutaway' ? t('一半看建筑外观，一半看店内；拖动右侧滑块移动剖切位置') : undefined}>
            {t(label)}
          </button>
        ))}
      </div>
      {buildingView === 'cutaway' && (
        <input className="cut-slider" type="range" min={5} max={95} value={Math.round(cutPos * 100)} aria-label={t('剖切位置')} onChange={(e) => app().setCutPos(Number(e.target.value) / 100)} />
      )}

      <label className="field">
        <span>{t('叠加层')}</span>
        <select value={overlay} onChange={(e) => app().setOverlay(e.target.value as Overlay)}>
          <option value="temp">{t('温区')}</option>
          <option value="heat">{t('拣货热度')}</option>
          <option value="stock">{t('货架存量')}</option>
          <option value="none">{t('无')}</option>
        </select>
      </label>

      <label className="field">
        <span>{t('画质')}</span>
        <select value={quality} onChange={(e) => app().setQuality(e.target.value as Quality)} title={t('高：实时阴影；中：无阴影；低：标准分辨率，适合性能较弱的设备')}>
          <option value="high">{t('高')}</option>
          <option value="medium">{t('中')}</option>
          <option value="low">{t('低')}</option>
        </select>
      </label>

      <div className="spacer" />
      {new URLSearchParams(location.search).get('live') === 'demo' && <EmbeddedLive />}

      <span className={`status ${status}`}>
        {status === 'running' ? t('仿真中…') : status === 'error' ? t('仿真出错') : timeline ? t('{0} 单 · 仿真用时 {1} ms', timeline.orderCount, timeline.simMs.toFixed(0)) : ''}
      </span>

      <div className="tour-tools" role="group" aria-label={t('导览与巡游')}>
        <button onClick={() => app().setTourStep(0)} title={t('一步一步介绍模拟器')}>
          {t('导览')}
        </button>
        <button onClick={() => app().setCinematic(true)} title={t('镜头自动在门店、停车场、后仓和路口之间切换（Esc 退出）')}>
          {t('巡游')}
        </button>
      </div>

      <div className="segmented lang-switch" role="group" aria-label="Language / 语言">
        <button className={lang === 'zh' ? 'active' : ''} onClick={() => app().setLang('zh')} lang="zh-CN">
          中文
        </button>
        <button className={lang === 'en' ? 'active' : ''} onClick={() => app().setLang('en')} lang="en">
          EN
        </button>
      </div>

      {mode === 'sim' ? (
        <button className="primary" onClick={() => app().setTab('edit')}>
          {t('编辑布局')}
        </button>
      ) : (
        <>
          <span className="badge">{t('布局编辑中 · 实时应用')}</span>
          <button className="primary" onClick={() => app().exitEdit(true)}>
            {t('完成编辑')}
          </button>
        </>
      )}
    </header>
  );
}
