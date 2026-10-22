import { useEffect, useState } from 'react';
import { displayName, parcelTrips, planogramByItem, sellableCases, shelfNow, summary, type AnyOpsEvent, type LiveOrder } from '@storewright/ops';
import { demo, labelUrl, type CreatedOrder, type SimStatus } from '../api';
import { clock, t } from '../i18n';
import { useLive, useNow } from '../live';
import { rejectText } from '../rejects';
import { toast } from '../ui/Toasts';

const CODES_KEY = 'storewright.console.codes';

function loadCodes(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CODES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const STATUS_TEXT: Record<LiveOrder['status'], string> = {
  CREATED: '已创建',
  LOCKED: '已锁单',
  PICKING: '拣货中',
  STAGED: '已暂存',
  PREPPING: '准备中',
  READY: '待装车',
  HANDING_OFF: '交付中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

/**
 * 演示控制台：代替订单平台、顾客和司机。创建测试订单（验证码只在这里显示）、上报「我在路上」、到店签到、司机接单。
 */
export function ConsoleScreen() {
  const { client, auth, run } = useLive();
  const now = useNow(1000);
  const s = client.state;
  const [type, setType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [count, setCount] = useState(1);
  const [lines, setLines] = useState(4);
  const [release, setRelease] = useState(true);
  const [withMto, setWithMto] = useState(false);
  const [withBig, setWithBig] = useState(false);
  const [codes, setCodes] = useState(loadCodes);
  const sum = summary(s, now);

  const remember = (key: string, code: string) => {
    const next = { ...codes, [key]: code };
    setCodes(next);
    try {
      localStorage.setItem(CODES_KEY, JSON.stringify(next));
    } catch {
      // 忽略
    }
  };

  const create = async () => {
    try {
      const r = await demo.createOrders(auth, { type, count, maxLines: lines, release, slotInMin: 40, mto: withMto, oversized: withBig });
      const next = { ...codes };
      for (const o of r.orders as CreatedOrder[]) next[o.orderId] = o.code;
      setCodes(next);
      localStorage.setItem(CODES_KEY, JSON.stringify(next));
      toast(t('已创建 {0} 张订单', r.orders.length), 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const orders = Object.values(s.orders).sort((a, b) => b.createdAt - a.createdAt);
  const active = orders.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED');
  const done = orders.filter((o) => o.status === 'COMPLETED' || o.status === 'CANCELLED').slice(0, 8);
  const trips = Object.values(s.trips).filter((x) => !x.completedAt);

  return (
    <div className="console">
      <section className="stats">
        <div>
          <b>{sum.orders}</b>
          <small>{t('订单')}</small>
        </div>
        <div>
          <b>{sum.openWalks + sum.activeWalks}</b>
          <small>{t('拣货批次')}</small>
        </div>
        <div>
          <b>{sum.staged}</b>
          <small>{t('已暂存')}</small>
        </div>
        <div>
          <b>{sum.waiting}</b>
          <small>{t('等待中')}</small>
        </div>
        <div>
          <b>{sum.completed}</b>
          <small>{t('已完成')}</small>
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">{t('创建测试订单')}</h2>
        <div className="form-grid">
          <label>
            {t('类型')}
            <select value={type} onChange={(e) => setType(e.target.value as 'PICKUP' | 'DELIVERY')}>
              <option value="PICKUP">{t('自取')}</option>
              <option value="DELIVERY">{t('配送')}</option>
            </select>
          </label>
          <label>
            {t('张数')}
            <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
          </label>
          <label>
            {t('每单最多商品行')}
            <input type="number" min={1} max={40} value={lines} onChange={(e) => setLines(Number(e.target.value) || 1)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
            {t('立即锁单并生成拣货批次')}
          </label>
          {client.statics?.modules?.mto && (
            <label className="toggle">
              <input type="checkbox" checked={withMto} onChange={(e) => setWithMto(e.target.checked)} />
              {t('每单加一份熟食现做')}
            </label>
          )}
          {client.statics?.modules?.oversized && (
            <label className="toggle">
              <input type="checkbox" checked={withBig} onChange={(e) => setWithBig(e.target.checked)} />
              {t('每单加一件大件（2 件）')}
            </label>
          )}
        </div>
        <button className="primary" onClick={() => void create()}>
          {t('创建')}
        </button>
        <p className="note">{t('姓名和商品都是合成数据。验证码只显示在控制台（相当于顾客手机上的取货码）。')}</p>
      </section>

      <section className="card">
        <div className="row-head">
          <h2 className="section-title">{t('进行中的订单（{0}）', active.length)}</h2>
          <div className="actions">
            <button onClick={() => void run({ type: 'ReleaseWalks' })}>{t('生成拣货批次')}</button>
            <button onClick={() => void demo.tick(auth, true)}>{t('排程一次')}</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('订单')}</th>
                <th>{t('顾客')}</th>
                <th>{t('时段')}</th>
                <th>{t('状态')}</th>
                <th>{t('验证码')}</th>
                <th>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {active.map((o) => (
                <tr key={o.id}>
                  <td className="mono">
                    {o.shortCode}
                    <small> {o.type === 'PICKUP' ? t('自取') : t('配送')}</small>
                  </td>
                  <td>{displayName(o.firstName, o.lastName)}</td>
                  <td className="mono">{clock(o.slotStart)}</td>
                  <td>
                    {t(STATUS_TEXT[o.status])}
                    {o.tripId ? ` · ${o.tripId}` : ''}
                    {o.arrivedAt !== undefined ? ` · ${t('已到达')}` : o.etaAt !== undefined ? ` · ${t('{0} 到', clock(o.etaAt))}` : ''}
                  </td>
                  <td className="mono strong">{o.tripId ? '—' : (codes[o.id] ?? '?')}</td>
                  <td className="actions">
                    {o.status === 'CREATED' && <button onClick={() => void run({ type: 'LockOrder', orderId: o.id })}>{t('锁单')}</button>}
                    {!o.tripId && o.arrivedAt === undefined && (
                      <>
                        <button onClick={() => void run({ type: 'UpdateEta', orderId: o.id, etaAt: client.now() + 4 * 60_000 })}>{t('我在路上')}</button>
                        <button onClick={() => void run({ type: 'CheckIn', orderId: o.id, bay: String(1 + (o.id.charCodeAt(o.id.length - 1) % 8)) })}>{t('到店')}</button>
                      </>
                    )}
                    <button className="danger" onClick={() => void run({ type: 'CancelOrder', orderId: o.id, reason: 'console' })}>
                      {t('取消')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {trips.length > 0 && (
        <section className="card">
          <h2 className="section-title">{t('配送行程（{0}）', trips.length)}</h2>
          <ul className="trip-list">
            {trips.map((tr) => (
              <li key={tr.id}>
                <b className="mono">{tr.id}</b>
                <span>{tr.orderIds.map((id) => s.orders[id]?.shortCode).join(' · ')}</span>
                <span>{tr.acceptedAt ? t('司机验证码 {0}', codes[tr.id] ?? '?') : t('等待司机接单')}</span>
                <span className="actions">
                  {!tr.acceptedAt && (
                    <button
                      onClick={async () => {
                        const r = await demo.acceptTrip(auth, tr.id);
                        if (r.code) remember(tr.id, r.code);
                        else if (r.reject) toast(rejectText(r.reject as never, (x) => x), 'error');
                      }}
                    >
                      {t('司机接单')}
                    </button>
                  )}
                  {tr.arrivedAt === undefined && <button onClick={() => void run({ type: 'CheckIn', tripId: tr.id, vehicle: 'Blue hatchback' })}>{t('司机到店')}</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section className="card">
          <h2 className="section-title">{t('最近完成 / 取消')}</h2>
          <ul className="plain">
            {done.map((o) => (
              <li key={o.id}>
                <span className="mono">{o.shortCode}</span> {displayName(o.firstName, o.lastName)} · {t(STATUS_TEXT[o.status])}
                {o.completedAt && o.arrivedAt ? ` · ${t('等待 {0} 秒', Math.round((o.completedAt - o.arrivedAt) / 1000))}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <BackroomConsole />
      {client.statics?.modules?.parcel && <ParcelConsole />}

      <EventFeed />

      <section className="card">
        <h2 className="section-title">{t('门店')}</h2>
        <div className="actions">
          <a className="button" href={labelUrl(auth, 'slots')} target="_blank" rel="noreferrer">
            {t('打印暂存格位标签')}
          </a>
          <button
            className="danger"
            onClick={async () => {
              if (!window.confirm(t('清空这个门店的全部订单和事件？'))) return;
              await demo.reset(auth);
              toast(t('门店已清空'), 'ok');
            }}
          >
            {t('清空门店（演示）')}
          </button>
        </div>
      </section>
    </div>
  );
}

/** 事件名称（未列出的显示原名） */
const EVENT_TEXT: Record<string, string> = {
  OrderCreated: '下单',
  OrderLocked: '锁单',
  OrderCancelled: '取消订单',
  ToteAssignmentsCreated: '分框',
  PickWalkCreated: '拣货批次已生成',
  LabelPrinted: '打印标签',
  LabelReprinted: '重打标签',
  LabelVoided: '标签作废',
  LabelBound: '扫描绑定框',
  PickWalkClaimed: '领取批次',
  PickWalkUnclaimed: '放弃批次',
  ItemPicked: '拣到商品',
  ItemNotFound: '找不到商品',
  SubstitutionPicked: '拣取替代品',
  ColdChainTimerStarted: '冷链开始计时',
  ColdChainAlert: '冷链超时',
  PickWalkCompleted: '完成拣货',
  ExceptionCreated: '转后仓补取',
  ToteStaged: '放进暂存格位',
  ToteMoved: '移动格位',
  OrderStaged: '订单全部暂存',
  CancelledOrderDetected: '发现已取消订单',
  ToteSentToRecovery: '放进回收专区',
  EtaUpdated: '我在路上',
  CustomerArrived: '到店签到',
  PrepStarted: '开始准备（加锁）',
  PrepJoined: '加入协助',
  ToteScannedForPrep: '从暂存区取出',
  ReadyToLoad: '待装车',
  CodeVerified: '验证码通过',
  CodeFailed: '验证码错误',
  AgeVerified: '核验证件',
  VehiclePlacementRecorded: '记录车内位置',
  OrderHandedOff: '交付完成',
  TripProposed: '组合配送行程',
  TripAccepted: '司机接单',
  TripCompleted: '行程交给司机',
  ExceptionAssigned: '领取后仓补取',
  ExceptionItemFound: '后仓找到商品',
  ExceptionNotFound: '后仓也找不到',
  ExceptionDeliveredToStaging: '补取送到暂存格位',
  ExceptionVoided: '后仓补取作废',
  InventoryLoaded: '载入期初库存',
  AsnReceived: '收到到货通知',
  TruckArrived: '卡车到店',
  CasesReceived: '收货',
  ReceiptClosed: '关闭收货单',
  CasePutAway: '上架到库位',
  CaseStatusChanged: '箱子状态变更',
  CycleCountCreated: '生成盘点任务',
  CycleCountClaimed: '领取盘点',
  CycleCountCompleted: '完成盘点',
  SalesRecorded: '门店销售',
  SensorReading: '传感器读数',
  ReplenishmentTaskCreated: '生成补货任务',
  ReplenishmentClaimed: '领取补货',
  ReplenishmentReleased: '补货放回队列',
  ReplenishmentCompleted: '完成补货',
  ReplenishmentCancelled: '取消补货',
  ShelfCheckRequested: '要求核对货架',
  ShelfCounted: '核对货架数量',
  RecommendationIssued: 'AI 建议',
  RecommendationResolved: '处理 AI 建议',
  AiModeSet: '修改 AI 运行模式',
  AiEtaApplied: 'AI 修正到店时间',
  AssociateRoleChanged: '员工调岗',
  AssociateLockChanged: '固定名单变更',
  NoteAdded: '记下门店经验',
  NoteRemoved: '删除门店经验',
  MtoTicketCreated: '熟食现做单',
  MtoStartAdjusted: 'AI 调整开始时间',
  MtoStarted: '开始制作',
  MtoCompleted: '制作完成放入保温',
  MtoPulled: '熟食取出',
  MtoDiscarded: '熟食丢弃',
  ReturnStarted: '开始退货',
  ReturnItemScanned: '扫描退货商品',
  ReturnDispositionSet: '退货去向',
  ReturnCompleted: '退货完成',
  OversizedPiecesCreated: '生成大件任务',
  OversizedClaimed: '领取大件',
  OversizedReleased: '放回大件',
  OversizedLabeled: '大件贴标签',
  OversizedStaged: '大件放进大件区',
  ParcelAsnReceived: '包裹到货通知',
  ParcelInducted: '包裹入站',
  ParcelOver: '多出的包裹',
  ParcelStaged: '包裹放进格位',
  ParcelDamaged: '包裹损坏',
  ParcelShort: '包裹短少',
  ParcelsHandedOff: '包裹交给司机',
};

function EventFeed() {
  const { client, nameOf } = useLive();
  const [events, setEvents] = useState<AnyOpsEvent[]>([]);
  useEffect(
    () =>
      client.onEvents((list) => {
        setEvents((old) => [...list.slice().reverse(), ...old].slice(0, 40));
      }),
    [client],
  );
  return (
    <section className="card">
      <h2 className="section-title">{t('实时事件')}</h2>
      {events.length === 0 && <p className="muted">{t('员工端的操作会实时出现在这里。')}</p>}
      <ul className="feed">
        {events.map((e) => (
          <li key={e.seq}>
            <span className="mono muted">#{e.seq}</span>
            <span className="mono">{clock(e.at)}</span>
            <b title={e.type}>{EVENT_TEXT[e.type] ? t(EVENT_TEXT[e.type] as string) : e.type}</b>
            <span className="muted">{nameOf(e.actor)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 后仓与补货（演示）：到货通知、顾客购物仿真（销售流水 + 传感器）、让某个商品的货架变空 */
function BackroomConsole() {
  const { client, auth } = useLive();
  const s = client.state;
  const st = client.statics;
  const [sim, setSim] = useState<SimStatus | undefined>();
  const [speed, setSpeed] = useState(120);
  const [itemId, setItemId] = useState('');
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => void demo.simStatus(auth).then((x) => alive && setSim(x)).catch(() => undefined);
    poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [auth]);
  if (!st) return null;
  const byItem = planogramByItem(st);
  // 演示用：后仓有货、卖得快的商品
  const candidates = st.planogram
    .filter((p) => sellableCases(s, p.itemId).length > 0)
    .sort((a, b) => b.baseVelocity - a.baseVelocity)
    .slice(0, 25);
  const openRepl = Object.values(s.repl).filter((x) => x.status === 'OPEN' || x.status === 'CLAIMED').length;
  const openEx = Object.values(s.exceptions).filter((x) => x.status === 'OPEN' || x.status === 'ASSIGNED' || x.status === 'FOUND').length;
  const openCounts = Object.values(s.counts).filter((x) => x.status !== 'DONE').length;
  const empty = st.planogram.filter((p) => shelfNow(s, p).est <= 0).length;
  return (
    <section className="card">
      <h2 className="section-title">{t('后仓与补货')}</h2>
      <div className="stats">
        <div>
          <b>{empty}</b>
          <small>{t('估算为空的商品')}</small>
        </div>
        <div>
          <b>{openRepl}</b>
          <small>{t('补货任务')}</small>
        </div>
        <div>
          <b>{openEx}</b>
          <small>{t('后仓补取')}</small>
        </div>
        <div>
          <b>{openCounts}</b>
          <small>{t('盘点任务')}</small>
        </div>
        <div>
          <b>{Object.keys(s.itemCases).length}</b>
          <small>{t('后仓有货的商品')}</small>
        </div>
      </div>
      <div className="actions">
        <button onClick={() => void demo.asn(auth, 6).then(() => toast(t('已发送到货通知'), 'ok'))}>{t('发送到货通知（ASN）')}</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={t('仿真速度')}>
          <option value={30}>30×</option>
          <option value={120}>120×</option>
          <option value={600}>600×</option>
        </select>
        {sim?.running ? (
          <button onClick={() => void demo.sim(auth, 'stop', speed).then(setSim)}>{t('停止顾客购物仿真')}</button>
        ) : (
          <button className="primary" onClick={() => void demo.sim(auth, 'start', speed).then(setSim)}>
            {t('开始顾客购物仿真')}
          </button>
        )}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={!!sim?.autoRestock}
          onChange={(e) => {
            // 先在界面上切换，再以服务端返回的状态为准
            const on = e.target.checked;
            setSim((x) => (x ? { ...x, autoRestock: on } : x));
            void demo.autoRestock(auth, on).then(setSim);
          }}
        />
        {t('自动补货：虚拟补货员按优先级处理补货任务（货架核对仍由员工去做）')}
      </label>
      {sim && (
        <p className="note">
          {t('已售 {0} 件 · 缺货少卖 {1} 件 · 损耗 {2} 件 · 传感器读数 {3} 条', sim.sold, sim.lost, sim.shrink, sim.readings)}
          {sim.autoRestock || sim.autoRestocked ? ` · ${t('自动补货 {0} 次', sim.autoRestocked ?? 0)}` : ''}
        </p>
      )}
      <div className="form-grid">
        <label>
          {t('让这个商品的货架变空')}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{t('选择商品')}</option>
            {candidates.map((p) => (
              <option key={p.itemId} value={p.itemId}>
                {p.name} · {p.locationId}
                {p.sensor ? ` · ${p.sensor}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />
          {t('系统不知道（放错位置 / 损耗），等拣货员或传感器发现')}
        </label>
      </div>
      <button disabled={!itemId} onClick={() => void demo.shelfEmpty(auth, itemId, silent).then(() => toast(t('货架已变空'), 'ok'))}>
        {t('让货架变空')}
      </button>
      {sim && sim.drift.length > 0 && (
        <div className="table-wrap">
          <h3 className="section-title">{t('真实存量与系统估算不一致')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('商品')}</th>
                <th>{t('货位')}</th>
                <th>{t('真实')}</th>
                <th>{t('估算')}</th>
              </tr>
            </thead>
            <tbody>
              {sim.drift.map((d) => (
                <tr key={d.itemId}>
                  <td>
                    {byItem.get(d.itemId)?.name ?? d.name}
                    {d.sensor ? ` · ${d.sensor}` : ''}
                  </td>
                  <td className="mono">{d.locationId}</td>
                  <td className="mono">{d.truth}</td>
                  <td className="mono">{d.est}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        <a className="button" href={labelUrl(auth, 'bins')} target="_blank" rel="noreferrer">
          {t('打印后仓库位标签')}
        </a>
      </div>
    </section>
  );
}

/** 包裹中转（演示）：代替承运商发到货通知，代替司机按行程交接 */
function ParcelConsole() {
  const { client, auth, run } = useLive();
  const trips = parcelTrips(client.state);
  const counts = (ps: Array<{ status: string }>, st: string) => ps.filter((p) => p.status === st).length;
  return (
    <section className="card">
      <div className="row-head">
        <h2 className="section-title">{t('包裹中转')}</h2>
        <button
          onClick={() =>
            void demo
              .parcels(auth, 8, 2)
              .then(() => toast(t('已收到 8 个包裹的到货通知'), 'ok'))
              .catch((e: unknown) => toast(String(e), 'error'))
          }
        >
          {t('包裹到货通知（8 件 / 2 个行程）')}
        </button>
      </div>
      {trips.length === 0 && <p className="muted">{t('没有待处理的包裹')}</p>}
      <ul className="plain">
        {trips.map((tr) => (
          <li key={tr.tripRef} className="row-head">
            <span>
              <b className="mono">{tr.tripRef}</b> ·{' '}
              {t('预期 {0} · 已入站 {1} · 已暂存 {2} · 短少 {3} · 损坏 {4}', counts(tr.parcels, 'EXPECTED'), counts(tr.parcels, 'INDUCTED'), counts(tr.parcels, 'STAGED'), counts(tr.parcels, 'SHORT'), counts(tr.parcels, 'DAMAGED'))}
            </span>
            <button disabled={!counts(tr.parcels, 'STAGED')} onClick={() => void run({ type: 'HandOffParcels', tripRef: tr.tripRef })}>
              {t('司机交接')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
