import { useEffect, useState } from 'react';
import { displayName, handoffBoard, pickRows, planogramIndex, ROLE_ORDER, shelfNow, stagingOccupancy, summary, teamBoard, type AnyOpsEvent, type AssociateRole, type BoardColor, type OpsState, type StoreStatic } from '@storewright/ops';
import { useApp } from '../state/store';
import { connectLive, disconnectLive, isReplaying, liveClient, viewNow, viewState } from '../live/link';
import { ROLE_COLOR, ROLE_TEXT } from '../live/roles';
import { TwinPanel } from './TwinPanel';
import { t, translate } from '../i18n';

const ZONE_TEXT: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻', HOT: '热食' };
const ZONE_COLOR: Record<string, string> = { AMBIENT: '#b07a2a', CHILLED: '#2f7fd0', FROZEN: '#6a5fd6', HOT: '#d9480f' };
const BOARD_TEXT: Record<BoardColor, string> = { GREY: '未到达', YELLOW: '即将到达', BLUE: '已到达', RED: '等待过久' };
const EVENT_TEXT: Record<string, string> = {
  OrderCreated: '下单',
  OrderLocked: '锁单',
  OrderCancelled: '取消订单',
  PickWalkCreated: '生成拣货批次',
  PickWalkClaimed: '领取拣货批次',
  ItemPicked: '拣到商品',
  ItemNotFound: '找不到商品',
  SubstitutionPicked: '拣取替代品',
  ColdChainAlert: '冷链超时',
  PickWalkCompleted: '完成拣货',
  ToteStaged: '放进暂存格位',
  OrderStaged: '订单全部暂存',
  ToteSentToRecovery: '放进回收专区',
  EtaUpdated: '顾客在路上',
  CustomerArrived: '顾客到店',
  PrepStarted: '开始准备',
  ToteScannedForPrep: '从暂存区取出',
  ReadyToLoad: '待装车',
  CodeVerified: '验证码通过',
  CodeFailed: '验证码错误',
  OrderHandedOff: '交付完成',
  ReplenishmentTaskCreated: '生成补货任务',
  ReplenishmentCompleted: '补货完成',
  ExceptionItemFound: '后仓补取找到',
  CasesReceived: '收货',
  TripProposed: '组合配送行程',
  TripCompleted: '行程交给司机',
  EquipmentAlertRaised: '设备告警',
  EquipmentAlertAcknowledged: '确认设备告警',
  EquipmentAlertCleared: '设备告警解除',
};

/**
 * 数字孪生（运营孪生）：连接 Storewright 后端，显示员工端产生的实时作业、设备遥测、告警和推演（决策记录 0016）。
 * 仿真照常在后台运行；打开「场景只显示实时数据」后，场景里的员工、暂存框、取货车位和设备都换成实时数据，
 * 底部的孪生时间轴可以回放过去、推演未来。
 */
export function OpsPanel() {
  const live = useApp((s) => s.live);
  const liveView = useApp((s) => s.liveView);
  useApp((s) => s.liveVersion);
  const [url, setUrl] = useState(live.url);
  const [storeId, setStoreId] = useState(live.storeId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const c = liveClient();

  if (live.status === 'off' || !c) {
    return (
      <div className="ops-panel">
        <p className="hint">{t('连接 Storewright 后端，三维场景就成了门店的数字孪生：员工端的实时作业、设备读数和告警都会出现在这里，还可以回放过去、推演未来 3 小时。仿真继续在后台运行。')}</p>
        <label className="field">
          {t('后端地址')}
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          {t('门店')}
          <input value={storeId} onChange={(e) => setStoreId(e.target.value)} spellCheck={false} />
        </label>
        <button className="primary" onClick={() => void connectLive(url, storeId)}>
          {t('连接')}
        </button>
        {live.error && <p className="error-text">{t('连接失败：{0}', live.error)}</p>}
        <p className="hint">{t('后端用 npm run server 启动；员工端在同一地址打开。场景中的位置按货位编码对应，门店布局需与后端一致（演示后端使用中型模板）。')}</p>
      </div>
    );
  }

  const s = viewState() ?? c.state;
  const st = c.statics;
  const sNow = isReplaying() ? viewNow() : now + c.offset;
  const sum = summary(s, sNow);
  const walks = Object.values(s.walks).filter((w) => w.status === 'CLAIMED' || w.status === 'PICKING');
  const board = st ? handoffBoard(s, st, sNow) : [];
  const nameOf = (id?: string) => (id ? (st?.roster.find((a) => a.id === id)?.name ?? id) : '');

  return (
    <div className="ops-panel">
      <div className="ops-status">
        <span className={`dot ${live.status === 'live' ? 'ok' : 'warn'}`} />
        <span>
          {live.status === 'live' ? t('已连接 {0}', st?.name ?? live.storeId) : live.status === 'connecting' ? t('连接中…') : t('连接中断，正在重连')}
        </span>
        <span className="muted mono">{t('事件 #{0} · 延迟 {1} ms', s.seq, Math.round(c.rtt))}</span>
        <button className="link" onClick={disconnectLive}>
          {t('断开')}
        </button>
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={liveView} onChange={(e) => useApp.getState().setLiveView(e.target.checked)} />
        {t('场景只显示实时数据（隐藏仿真的员工、顾客和车辆）')}
      </label>

      <TwinPanel />

      <h3 className="gap">{t('作业')}</h3>

      <div className="kpi-grid">
        <div className="kpi">
          <span className="kpi-label">{t('今日订单')}</span>
          <span className="kpi-value">
            {sum.orders} <small>{t('已完成 {0}', sum.completed)}</small>
          </span>
        </div>
        <div className={`kpi${sum.waiting ? ' hot' : ''}`}>
          <span className="kpi-label">{t('等待中的顾客')}</span>
          <span className="kpi-value">{sum.waiting}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t('拣货批次')}</span>
          <span className="kpi-value">
            {sum.activeWalks} <small>{t('待领取 {0}', sum.openWalks)}</small>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t('平均等待')}</span>
          <span className="kpi-value">{t('{0} 秒', sum.avgWaitSec)}</span>
        </div>
      </div>

      {st && <TeamSection s={s} st={st} now={sNow} />}

      <h3 className="gap">{t('正在拣货')}</h3>
      {walks.length === 0 && <p className="muted">{t('没有进行中的拣货批次')}</p>}
      {walks.map((w) => {
        const rows = pickRows(s, w).filter((r) => !r.cancelled);
        const total = rows.reduce((n, r) => n + r.qty, 0);
        const done = rows.reduce((n, r) => n + r.done, 0);
        return (
          <div key={w.id} className="meter">
            <div className="meter-head">
              <span>
                <b>{nameOf(w.associateId)}</b> · {w.id} · {t(ZONE_TEXT[w.tempZone] ?? w.tempZone)}
              </span>
              <span className="mono">
                {done}/{total}
              </span>
            </div>
            <div className="meter-track">
              <div className="meter-fill" style={{ width: `${total ? (done / total) * 100 : 0}%`, background: ZONE_COLOR[w.tempZone] }} />
            </div>
          </div>
        );
      })}

      <h3 className="gap">{t('暂存占用')}</h3>
      {st &&
        stagingOccupancy(s, st).map((z) => (
          <div key={z.tempZone} className="meter">
            <div className="meter-head">
              <span>{t(ZONE_TEXT[z.tempZone] ?? z.tempZone)}</span>
              <span className="mono">
                {z.used}/{z.capacity}
              </span>
            </div>
            <div className="meter-track">
              <div className="meter-fill" style={{ width: `${Math.min(100, z.rate * 100)}%`, background: z.alert ? 'var(--alert)' : ZONE_COLOR[z.tempZone] }} />
            </div>
          </div>
        ))}

      {st && (
        <>
          <h3 className="gap">{t('货架与补货')}</h3>
          <div className="kpi-grid">
            <div className="kpi">
              <span className="kpi-label">{t('估算为空的商品')}</span>
              <span className="kpi-value">{[...planogramIndex(st).values()].filter((p) => shelfNow(s, p).est <= 0).length}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">{t('补货任务')}</span>
              <span className="kpi-value">
                {Object.values(s.repl).filter((x) => x.status === 'OPEN' || x.status === 'CLAIMED').length} <small>{t('今日完成 {0}', Object.values(s.repl).filter((x) => x.status === 'DONE').length)}</small>
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-label">{t('后仓补取')}</span>
              <span className="kpi-value">{Object.values(s.exceptions).filter((x) => x.status === 'OPEN' || x.status === 'ASSIGNED' || x.status === 'FOUND').length}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">{t('盘点任务')}</span>
              <span className="kpi-value">{Object.values(s.counts).filter((x) => x.status !== 'DONE').length}</span>
            </div>
          </div>
        </>
      )}

      <AiRecs />

      <h3 className="gap">{t('交付看板')}</h3>
      {board.length === 0 && <p className="muted">{t('没有待交付的订单')}</p>}
      <ul className="ops-board">
        {board.slice(0, 12).map((r) => (
          <li key={r.key} className={`b-${r.color.toLowerCase()}`}>
            <span className="tag">{t(BOARD_TEXT[r.color])}</span>
            <span className="grow">{r.kind === 'TRIP' ? t('行程 {0}（{1} 单）', r.title, r.orderIds.length) : r.title}</span>
            <span className="mono">{r.arrivedAt !== undefined ? fmtWait(r.waitSec) : (r.shortCode ?? '')}</span>
            <span className="muted small">{r.session ? (r.session.status === 'PREPPING' ? t('{0} 准备中', nameOf(r.session.owner)) : t('待装车')) : r.ready ? '' : t('暂存 {0}/{1}', r.staged, r.totes)}</span>
          </li>
        ))}
      </ul>

      <h3 className="gap">{t('实时事件')}</h3>
      <EventList nameOf={nameOf} orders={(id) => {
        const o = s.orders[id];
        return o ? `${displayName(o.firstName, o.lastName)} ${o.shortCode}` : id;
      }} />
    </div>
  );
}

const QUEUE_TEXT: Partial<Record<AssociateRole, string>> = { PICK: '待领批次 {0}', STAGE: '待暂存 {0} 框', HANDOFF: '到店等候 {0}', RESTOCK: '补货任务 {0}', BACKROOM: '后仓补取 {0}' };

/** 在岗人员（决策记录 0025）：每个岗位此刻有谁、排着多少活；临时调动的人标 *，下面写从哪里调来、几点回去 */
function TeamSection({ s, st, now }: { s: OpsState; st: StoreStatic; now: number }) {
  const board = teamBoard(st, s, now);
  const on = board.members.filter((m) => m.on);
  const moved = on.filter((m) => m.moved);
  const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <>
      <h3 className="gap">
        {t('在岗人员')} <small className="muted">{t('{0} 人', on.length)}</small>
      </h3>
      <ul className="ops-board ops-team">
        {ROLE_ORDER.map((role) => {
          const people = on.filter((m) => m.role === role);
          const q = board.queue[role] ?? 0;
          if (!people.length && !q) return null;
          return (
            <li key={role} className={!people.length ? 'short' : ''}>
              <i className="role-dot" style={{ background: ROLE_COLOR[role] }} />
              <b>{t(ROLE_TEXT[role] ?? role)}</b>
              <span className="grow">{people.length ? people.map((m) => (m.moved ? `${m.name}*` : m.name)).join(', ') : t('没人')}</span>
              {q > 0 && QUEUE_TEXT[role] && <span className="muted small">{t(QUEUE_TEXT[role] as string, q)}</span>}
            </li>
          );
        })}
      </ul>
      {moved.length > 0 && (
        <p className="muted small">
          {t(
            '* 临时调动：{0}',
            moved.map((m) => t(m.moved?.until !== undefined ? '{0} 从{1}调来，{2} 回去' : '{0} 从{1}调来', m.name, t(ROLE_TEXT[m.base] ?? m.base), m.moved?.until !== undefined ? hm(m.moved.until) : '')).join('；'),
          )}
        </p>
      )}
    </>
  );
}

function fmtWait(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function EventList({ nameOf, orders }: { nameOf: (id?: string) => string; orders: (id: string) => string }) {
  const [list, setList] = useState<AnyOpsEvent[]>([]);
  useEffect(() => {
    const c = liveClient();
    if (!c) return;
    return c.onEvents((evs) => setList((old) => [...evs.filter((e) => EVENT_TEXT[e.type]).reverse(), ...old].slice(0, 30)));
  }, []);
  if (!list.length) return <p className="muted">{t('员工端的操作会实时出现在这里。')}</p>;
  return (
    <ul className="ops-events">
      {list.map((e) => {
        const p = e.payload as { orderId?: string };
        return (
          <li key={e.seq}>
            <span className="mono muted">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
            <b>{t(EVENT_TEXT[e.type] as string)}</b>
            <span>{e.actor === 'system' || e.actor === 'console' ? '' : e.actor === 'customer' ? t('顾客') : e.actor === 'driver' ? t('司机') : translate(nameOf(e.actor))}</span>
            <span className="muted">{p.orderId ? orders(p.orderId) : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

const AI_MODULE_TEXT: Record<string, string> = {
  FORECAST: '订单量预测',
  ETA: '到店时间',
  AVAILABILITY: '可售概率',
  SUBSTITUTION: '替代推荐',
  STAFFING: '人员调配',
  REPLENISH: '补货优先级',
  COUNT: '按风险盘点',
  MTO: '熟食开始时间',
  RETURNS: '退货去向',
};
const AI_STATUS_TEXT: Record<string, string> = {
  OPEN: '待处理',
  ACCEPTED: '已采纳',
  OVERRIDDEN: '已否决',
  DISMISSED: '已忽略',
  EXPIRED: '已过期',
  SUPERSEDED: '已被取代',
  AUTO_APPLIED: '已自动执行',
};

/** 门店 AI 的建议（决策记录 0010）：待处理的在前，附模块、置信度和处理结果；在员工端「AI」页处理 */
function AiRecs() {
  const c = liveClient();
  if (!c) return null;
  const s = viewState() ?? c.state;
  const recs = Object.values(s.recs ?? {})
    .sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN') || b.issuedAt - a.issuedAt)
    .slice(0, 8);
  const open = recs.filter((r) => r.status === 'OPEN').length;
  return (
    <>
      <h3 className="gap">{t('AI 建议')}</h3>
      {recs.length === 0 ? (
        <p className="muted">{t('还没有 AI 建议')}</p>
      ) : (
        <>
          <p className="muted small">{t('{0} 条待处理（在员工端「AI」页处理）', open)}</p>
          <ul className="ops-board">
            {recs.map((r) => (
              <li key={r.id} className={r.status === 'OPEN' ? 'b-yellow' : 'b-grey'}>
                <span className="tag">{t(AI_MODULE_TEXT[r.module] ?? r.module)}</span>
                <span className="grow">{r.prediction ? `${r.prediction.unit === 'PROBABILITY' ? `${Math.round(r.prediction.value * 100)}%` : Math.round(r.prediction.value)} · ${r.target}` : r.target}</span>
                <span className="mono">{Math.round(r.confidence * 100)}%</span>
                <span className="muted small">{t(AI_STATUS_TEXT[r.status] ?? r.status)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
