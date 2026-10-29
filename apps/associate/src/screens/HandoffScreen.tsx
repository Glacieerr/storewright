import { useState } from 'react';
import { VEHICLE_POSITIONS, type VehiclePosition } from '@storewright/domain';
import { canManageAi, DEFAULT_DRIVER_CANCEL, displayName, handoffBoard, lineRecalled, needsAgeCheck, noShowWindow, orderShortages, resolveScan, sessionKeyFor, sessionTotes, type BoardRow, type StoreStatic } from '@storewright/ops';
import { coldAlertOn, sensorsFor } from '@storewright/twin';
import { labelUrl } from '../api';
import { feedback } from '../feedback';
import { clock, duration, t } from '../i18n';
import { useLive, useNow } from '../live';
import { useIntent } from '../nav';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { SopTip } from '../ui/SopTip';
import { ZoneChip } from '../ui/ZoneChip';

/** 交付：看板（四色状态，先到先服务）→ 准备（扫描任意一个框即加锁）→ 核验 → 交付 */
export function HandoffScreen() {
  const { client, run } = useLive();
  const [open, setOpen] = useState<string | undefined>();
  const [showAll, setShowAll] = useState(false);
  // 提醒、「下一步」直接打开这个订单或行程（决策记录 0026）
  useIntent('sessionKey', setOpen);
  const now = useNow(1000);
  const st = client.statics as StoreStatic | undefined;
  if (!st) return null;
  if (open) return <SessionView sessionKey={open} onBack={() => setOpen(undefined)} />;
  // 自动运营的订单和行程由虚拟员工交付，不在员工的交付看板上
  const rows = handoffBoard(client.state, st, now).filter((r) => r.orderIds.every((id) => client.state.orders[id]?.track !== 'AUTO'));
  // 看板太长时（决策记录 0026）：已到、快到的在上面，还没到的收起来
  const near = rows.filter((r) => r.color !== 'GREY' || r.session);
  const far = rows.filter((r) => r.color === 'GREY' && !r.session);
  const shown = rows.length > 10 && !showAll ? near : rows;
  const onScan = async (raw: string) => {
    const s = client.state;
    const r = resolveScan(s, st, raw);
    if (r.kind === 'label') {
      const key = sessionKeyFor(s, r.orderId);
      // 扫框即开始准备（决策记录 0026）：订单都暂存好了、门店允许现在开始时，打开、开始准备、记下这一框一次完成
      const trip = s.trips[key];
      const orderIds = trip ? trip.orderIds.filter((id) => s.orders[id]?.status !== 'CANCELLED') : [key];
      const staged = orderIds.every((id) => s.orders[id]?.stagedAt !== undefined);
      const arrived = trip ? trip.arrivedAt !== undefined : s.orders[key]?.arrivedAt !== undefined;
      const gateOk = s.settings?.prepGate !== 'ARRIVED' || arrived;
      const delivery = !trip && s.orders[key]?.type === 'DELIVERY';
      if (!s.sessions[key] && staged && gateOk && !delivery && s.totes[r.toteId]?.status === 'STAGED') {
        if (await run({ type: 'StartPrep', key })) void run({ type: 'ScanPrepTote', key, labelId: r.labelId });
      }
      return setOpen(key);
    }
    if (r.kind === 'order') return setOpen(sessionKeyFor(client.state, r.orderId));
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };
  return (
    <div className="handoff">
      <ScanBox label={t('扫描任意一个框，或输入订单短号')} onScan={(c) => void onScan(c)} />
      <h2 className="section-title">{t('交付看板（{0}）', rows.length)}</h2>
      {rows.length === 0 && <p className="muted">{t('锁单后的订单会出现在这里。')}</p>}
      <ul className="board">
        {shown.map((r) => (
          <li key={r.key}>
            <BoardItem row={r} now={now} onOpen={() => setOpen(r.key)} />
          </li>
        ))}
      </ul>
      {rows.length > 10 && far.length > 0 && (
        <button className="link" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('收起还没到的订单') : t('还没到的订单（{0}）', far.length)}
        </button>
      )}
    </div>
  );
}

const COLOR_TEXT = { GREY: '未到达', YELLOW: '即将到达', BLUE: '已到达', RED: '等待过久' } as const;

function BoardItem({ row, now, onOpen }: { row: BoardRow; now: number; onOpen: () => void }) {
  const { nameOf } = useLive();
  const ss = row.session;
  const status = ss ? (ss.status === 'PREPPING' ? t('准备中（{0}）', nameOf(ss.owner)) : ss.status === 'READY' ? t('待装车') : t('交付中')) : row.ready ? t('未开始') : t('拣货 / 暂存中 {0}/{1}', row.staged, row.totes);
  return (
    <button className={`board-row c-${row.color.toLowerCase()}`} onClick={onOpen}>
      <span className="color-tag">{t(COLOR_TEXT[row.color])}</span>
      <span className="b-title">
        <b>{row.kind === 'TRIP' ? t('行程 {0}（{1} 单）', row.title, row.orderIds.length) : row.title}</b>
        <small>
          {row.type === 'PICKUP' ? t('自取') : t('配送')}
          {row.shortCode ? ` · ${row.shortCode}` : ''}
          {row.bay ? ` · ${t('车位 {0}', row.bay)}` : ''}
          {row.vehicle ? ` · ${row.vehicle}` : ''}
        </small>
      </span>
      <span className="b-time mono">
        {row.arrivedAt !== undefined ? t('等待 {0}', duration(row.waitSec)) : row.etaAt !== undefined ? t('{0} 分钟后到', Math.max(0, Math.round((row.etaAt - now) / 60000))) : clock(row.slotStart)}
        {row.arrivedAt === undefined && row.reportedEtaAt !== undefined && <small className="ai-eta">{t('AI 修正 · 顾客报 {0} 分钟', Math.max(0, Math.round((row.reportedEtaAt - now) / 60000)))}</small>}
      </span>
      <span className="b-status">{status}</span>
    </button>
  );
}

const POSITION_TEXT: Record<VehiclePosition, string> = { FRONT_PASSENGER: '副驾', REAR_LEFT: '后排左', REAR_RIGHT: '后排右', TRUNK: '尾箱' };

function SessionView({ sessionKey, onBack }: { sessionKey: string; onBack: () => void }) {
  const { client, auth, run, nameOf } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const now = useNow(1000);
  const [code, setCode] = useState('');
  const [removeAge, setRemoveAge] = useState(false);
  const [removeRecalled, setRemoveRecalled] = useState(false);
  const [bigDone, setBigDone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const strict = !!s.settings?.requireScan;
  const trip = s.trips[sessionKey];
  const orderIds = trip ? trip.orderIds.filter((id) => s.orders[id]?.status !== 'CANCELLED') : [sessionKey];
  const orders = orderIds.map((id) => s.orders[id]).filter((o) => !!o);
  const ss = s.sessions[sessionKey];
  const mine = !!ss && (ss.owner === auth.actor || ss.helpers.includes(auth.actor));
  const lead = canManageAi(st, auth.actor);
  const age = needsAgeCheck(s, orderIds);
  const ageBlocked = !!ss && ss.status === 'HANDING_OFF' && age && !ss.ageVerified && !removeAge;
  const arrivedAt = trip ? trip.arrivedAt : orders[0]?.arrivedAt;
  const totes = sessionTotes(s, orderIds);
  const staged = orders.every((o) => o.stagedAt !== undefined);
  const title = trip ? t('行程 {0}', trip.id) : orders[0] ? displayName(orders[0].firstName, orders[0].lastName) : sessionKey;
  // 召回商品已经拣进框里（决策记录 0026）
  // 只召回部分批号的：货架下架之后拣的不算（决策记录 0026）
  const recalledLines = orders.flatMap((o) => o.lines.filter((l) => (o.lineResults[l.lineId]?.picked ?? 0) > 0 && lineRecalled(s, l.itemId, o.lineResults[l.lineId]?.pickedAt)).map((l) => ({ o, l, tote: o.toteIds.map((id) => s.totes[id]).find((x) => x?.lines.some((tl) => tl.lineId === l.lineId)) })));
  const recallBlocked = recalledLines.length > 0 && !removeRecalled;
  // 后仓补取中（决策记录 0026）：完成交付时按缺货算
  const fetching = Object.values(s.exceptions).filter((x) => orderIds.includes(x.orderId) && (x.status === 'OPEN' || x.status === 'ASSIGNED' || x.status === 'FOUND'));
  // 熟食现做、大件（决策记录 0026）
  const tickets = Object.values(s.mto ?? {}).filter((x) => orderIds.includes(x.orderId) && x.status !== 'DISCARDED');
  const pieces = Object.values(s.oversized ?? {}).filter((x) => orderIds.includes(x.orderId));
  const mtoBlocked = tickets.some((x) => x.status !== 'PULLED');
  const bigBlocked = pieces.length > 0 && !bigDone;
  const allPulled = !!ss && totes.every((x) => ss.scanned.includes(x.id));
  // 会核验年龄的人（名单上的技能）
  const ageHelpers = st.roster.filter((a) => a.role === 'LEAD' || a.skills?.includes('AGE_CHECK')).map((a) => a.name);
  // 带班负责人可以改派没来的司机（决策记录 0026：以前只有控制台能改派）
  const noShow = trip && trip.acceptedAt !== undefined && trip.completedAt === undefined ? noShowWindow(trip, now, DEFAULT_DRIVER_CANCEL) : undefined;

  const onScan = async (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind !== 'label') {
      feedback('error');
      return toast(t('请扫描框上的标签'), 'error');
    }
    if (!orderIds.includes(r.orderId)) {
      feedback('error');
      return toast(t('这个框不属于这个订单'), 'error');
    }
    if (!ss) {
      // 扫描任意一个框即开始准备并加锁（决策 D-05）
      if (!(await run({ type: 'StartPrep', key: sessionKey }))) return;
    }
    void run({ type: 'ScanPrepTote', key: sessionKey, labelId: r.labelId });
  };

  if (!orders.length) {
    return (
      <div className="session">
        <button className="link" onClick={onBack}>
          ← {t('返回看板')}
        </button>
        <p>{t('订单已完成或已取消')}</p>
      </div>
    );
  }
  // 准备中取消（流程梳理发现，决策记录 0025）：交付准备已经结束，已取出的框放进回收专区
  if (!trip && orders[0]?.status === 'CANCELLED') {
    return (
      <div className="session">
        <button className="link" onClick={onBack}>
          ← {t('返回看板')}
        </button>
        <CancelledTotes orderIds={orderIds} />
        <p>{t('订单已取消')}</p>
      </div>
    );
  }

  return (
    <div className="session">
      <button className="link" onClick={onBack}>
        ← {t('返回看板')}
      </button>
      <header className="session-head">
        <h2>{title}</h2>
        <p className="muted">
          {trip ? t('{0} 单 · 司机 {1}', orders.length, trip.driverName ?? t('未接单')) : `${orders[0]?.type === 'PICKUP' ? t('自取') : t('配送')} · ${orders[0]?.shortCode ?? ''}`}
          {' · '}
          {arrivedAt !== undefined ? t('已到达，等待 {0}', duration((now - arrivedAt) / 1000)) : t('未到达')}
          {(trip?.bay ?? orders[0]?.bay) ? ` · ${t('车位 {0}', trip?.bay ?? orders[0]?.bay ?? '')}` : ''}
          {(trip?.vehicle ?? orders[0]?.vehicle) ? ` · ${trip?.vehicle ?? orders[0]?.vehicle}` : ''}
        </p>
        {/* 店员代签到（决策记录 0026）：顾客没在手机上签到、直接走到柜台 */}
        {arrivedAt === undefined && (trip ? !!trip.acceptedAt : orders[0]?.type === 'PICKUP') && (
          <button className="chip" onClick={() => void run(trip ? { type: 'CheckIn', tripId: trip.id } : { type: 'CheckIn', orderId: sessionKey })}>
            {trip ? t('司机已到（店员签到）') : t('顾客已到（店员签到）')}
          </button>
        )}
        {lead && noShow?.allowed && (
          <button className="chip warn" onClick={() => void run({ type: 'RedispatchTrip', tripId: sessionKey })}>
            {t('司机没来，改派')}
          </button>
        )}
      </header>

      {trip && <TripCancelNotice tripId={trip.id} />}
      {trip && <CancelledTotes orderIds={trip.orderIds} />}
      {client.statics && orders.some((o) => client.statics && coldAlertOn(client.state, client.statics, o.id, sensorsFor(client.statics))) && <p className="banner warn">{t('冷链告警：这张订单的冷藏冷冻框放过的暂存柜温度超标，交付前检查商品温度，必要时联系带班负责人。')}</p>}
      {/* 提前说（决策记录 0026）：有 21+ 商品、召回商品、后仓补取中、熟食、大件 */}
      {age && !ss?.ageVerified && <p className="note warn-text">{t('这单有 21+ 商品：交给顾客前要核验证件。会核验的人：{0}', ageHelpers.join('、'))}</p>}
      {recalledLines.length > 0 && (
        <div className="banner error">
          <p>{t('召回商品：交给顾客前从框里取出来')}</p>
          <ul className="plain">
            {recalledLines.map(({ o, l, tote }) => (
              <li key={`${o.id}|${l.lineId}`}>
                {l.name} × {o.lineResults[l.lineId]?.picked ?? 0}
                {tote ? ` · ${t('框 {0}/{1}', tote.index, tote.count)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fetching.length > 0 && (
        <p className="note">
          {fetching.map((x) => t('后仓补取中：{0} × {1}（{2}）', s.orders[x.orderId]?.lines.find((l) => l.lineId === x.lineId)?.name ?? x.itemId, x.units ?? x.qty, x.associateId ? nameOf(x.associateId) : t('还没人领'))).join('；')}
          {' '}
          {t('可以等一等；完成交付时没送到的按缺货算。')}
        </p>
      )}
      {tickets.length > 0 && (
        <section className="phase mto-in-handoff">
          <h3 className="section-title">{t('熟食现做')}</h3>
          <ul className="plain">
            {tickets.map((x) => (
              <li key={x.id} className="row-line">
                <span>
                  {x.name} × {x.qty} · {x.status === 'PULLED' ? t('已取出') : x.status === 'HELD' ? t('在保温位 {0}', x.slotCode ?? '—') : x.status === 'COOKING' ? t('正在做') : t('还没开始做（{0} 前做好）', clock(x.dueAt))}
                </span>
                {x.status === 'HELD' && (
                  <button className="chip" onClick={() => void run({ type: 'PullMto', ticketId: x.id })}>
                    {t('取出')}
                  </button>
                )}
                {x.status !== 'PULLED' && (
                  <button className="link" onClick={() => void run({ type: 'DiscardMto', ticketId: x.id })}>
                    {t('顾客不要了')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {pieces.length > 0 && (
        <section className="phase">
          <h3 className="section-title">{t('大件')}</h3>
          <ul className="plain">
            {pieces.map((x) => (
              <li key={x.id}>
                {x.name} {x.index}/{x.count} · {x.status === 'STAGED' ? t('在 {0}', x.area ?? '—') : t('还没放到大件区（{0}）', x.status)}
              </li>
            ))}
          </ul>
          <label className="toggle">
            <input type="checkbox" checked={bigDone} onChange={(e) => setBigDone(e.target.checked)} />
            <span>{t('大件已经取出、交给顾客')}</span>
          </label>
        </section>
      )}

      {!ss && (
        <section className="phase">
          {staged ? (
            s.settings?.prepGate === 'ARRIVED' && arrivedAt === undefined ? (
              <p className="banner info">{t('门店设置：顾客到了才能开始准备。')}</p>
            ) : (
              <>
                <p>{t('扫描任意一个框开始准备，订单会锁定给你，其他人只能加入协助。')}</p>
                {arrivedAt === undefined && <p className="note">{t('顾客还没到：先取常温的框，冷藏冷冻的最后取。')}</p>}
                <ScanBox label={t('扫描框标签')} onScan={(c) => void onScan(c)} />
                <button className="primary block" onClick={() => void run({ type: 'StartPrep', key: sessionKey })}>
                  {t('开始准备')}
                </button>
              </>
            )
          ) : (
            <p className="banner warn">{t('订单还没有全部暂存，请告诉顾客预计等待时间和原因。')}</p>
          )}
        </section>
      )}

      {ss && !mine && (
        <section className="phase">
          <p className="banner info">{t('{0} 正在准备这个订单', nameOf(ss.owner))}</p>
          <button className="primary block" onClick={() => void run({ type: 'JoinPrep', key: sessionKey })}>
            {t('加入协助')}
          </button>
        </section>
      )}

      {/* 先核验、再取框（决策记录 0026）：顾客到了随时可以核验 */}
      {ss && mine && !ss.verified && (
        <section className="phase">
          <h3 className="section-title">{t('核验验证码')}</h3>
          {arrivedAt === undefined ? (
            <p className="banner warn">{t('顾客还没有到达。到达后先核对姓名或车位，再输入验证码。')}</p>
          ) : trip && !trip.codeHash ? (
            <>
              <p className="banner warn">{t('司机没有验证码')}</p>
              <p>{t('请人工核验：核对证件和订单信息。')}</p>
              <button className="primary block" onClick={() => void run({ type: 'VerifyManually', key: sessionKey })}>
                {t('已人工核验')}
              </button>
            </>
          ) : (
            <form
              className="code-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run({ type: 'VerifyCode', key: sessionKey, code }).then(() => setCode(''));
              }}
            >
              <input className="code-input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))} placeholder="····" autoCapitalize="characters" autoComplete="off" aria-label={t('验证码')} />
              <button className="primary" type="submit" disabled={code.length < 4}>
                {t('核验')}
              </button>
              {/* 输错不限次数（决策记录 0014）；错到一定次数后另外提供人工核验 */}
              {ss.codeFailures > 0 && <p className="error-text">{t('验证码不正确（已错 {0} 次），请顾客再核对一遍', ss.codeFailures)}</p>}
              <SopTip sopId="code-failed" when={ss.codeFailures > 0} />
              {ss.manualRequired && (
                <div className="manual-alt">
                  <p className="muted">{t('也可以改用人工核验：核对证件和订单信息。')}</p>
                  <button type="button" onClick={() => void run({ type: 'VerifyManually', key: sessionKey })}>
                    {t('已人工核验')}
                  </button>
                </div>
              )}
              {!allPulled && <p className="note">{t('顾客在柜台时可以先核验，再去取框。')}</p>}
            </form>
          )}
        </section>
      )}
      {ss && mine && ss.verified && !allPulled && <p className="banner info">{t('已核验，把剩下的框取出来就可以交了。')}</p>}

      {ss && mine && !allPulled && (
        <section className="phase">
          <h3 className="section-title">{t('从暂存区取出（{0} / {1}）', ss.scanned.length, totes.length)}</h3>
          <ScanBox label={t('逐框扫描')} onScan={(c) => void onScan(c)} />
          <ul className="prep-list">
            {totes.map((x) => {
              const done = ss.scanned.includes(x.id);
              return (
                <li key={x.id} className={done ? 'done' : ''}>
                  <button className="row-btn" disabled={done || strict} onClick={() => x.labelId && void run({ type: 'ScanPrepTote', key: sessionKey, labelId: x.labelId, tap: true })}>
                    <span className="check">{done ? '✓' : ''}</span>
                    <ZoneChip z={x.tempZone} />
                    <span className="mono strong">{x.status === 'PULLED' ? t('在手上') : (x.slotCode ?? '—')}</span>
                    <span>
                      {s.orders[x.orderId]?.shortCode} · {t('框 {0}/{1}', x.index, x.count)}
                    </span>
                  </button>
                  {!done && (
                    <a className="reprint" href={labelUrl(auth, `tote/${x.id}.svg`)} target="_blank" rel="noreferrer" onClick={() => void run({ type: 'ReprintLabel', toteId: x.id }, { quiet: true })}>
                      {t('标签丢失？重打')}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          {ss.helpers.length > 0 && <p className="note">{t('协助：{0}', ss.helpers.map(nameOf).join('、'))}</p>}
        </section>
      )}

      {ss && mine && ss.status === 'HANDING_OFF' && (
        <section className="phase">
          {/* 年龄核验没完成时不能完成交付（决策 H-05：核验证件，或移除年龄限制商品） */}
          <h3 className="section-title">{t('交付')}</h3>
          {age && !ss.ageVerified && (
            <div className="check-block">
              <SopTip sopId="age-check" />
              <p className="banner warn">{t('含年龄限制商品（21+）：请核验证件')}</p>
              <div className="actions">
                <button className="primary" onClick={() => void run({ type: 'VerifyAge', key: sessionKey })}>
                  {t('已核验证件')}
                </button>
                <label className="toggle">
                  <input type="checkbox" checked={removeAge} onChange={(e) => setRemoveAge(e.target.checked)} />
                  {t('无法核验：移除年龄限制商品')}
                </label>
              </div>
              {/* 移除时列出是哪几件、在哪个框（决策记录 0026） */}
              {removeAge && (
                <ul className="plain note">
                  {orders.flatMap((o) =>
                    o.lines
                      .filter((l) => l.ageRestricted && (o.lineResults[l.lineId]?.picked ?? 0) + (o.lineResults[l.lineId]?.substituted ?? 0) > 0)
                      .map((l) => {
                        const tote = o.toteIds.map((id) => s.totes[id]).find((x) => x?.lines.some((tl) => tl.lineId === l.lineId));
                        return <li key={`${o.id}|${l.lineId}`}>{t('取出：{0}{1}', l.name, tote ? `（${t('框 {0}/{1}', tote.index, tote.count)}）` : '')}</li>;
                      }),
                  )}
                </ul>
              )}
            </div>
          )}
          {recalledLines.length > 0 && (
            <label className="toggle">
              <input type="checkbox" checked={removeRecalled} onChange={(e) => setRemoveRecalled(e.target.checked)} />
              <span>{t('召回商品已经从框里取出')}</span>
            </label>
          )}
          {orders.map((o) => {
            const short = orderShortages(o);
            return (
              <div key={o.id} className="order-block">
                <h4>
                  {displayName(o.firstName, o.lastName)} · <span className="mono">{o.shortCode}</span>
                </h4>
                {short.length ? (
                  <ul className="shortages">
                    {short.map((x) => (
                      <li key={x.lineId}>
                        {x.name}：{x.substituted > 0 ? t('替换为 {0} ×{1}', x.substituteName ?? '', x.substituted) : ''}
                        {x.short > 0 ? t('缺货 {0} 件', x.short) : ''}
                        {/* 顾客对替代品满意吗（决策记录 0023 · B4：真实标签，不改变计费和退货规则） */}
                        {x.substituted > 0 && (
                          <span className="sub-rate" role="group" aria-label={t('顾客对替代品满意吗')}>
                            <button className={`chip${x.subAccepted === true ? ' on' : ''}`} onClick={() => void run({ type: 'RateSubstitution', orderId: o.id, lineId: x.lineId, accepted: true }, { quiet: true })}>
                              {t('顾客满意')}
                            </button>
                            <button className={`chip${x.subAccepted === false ? ' on' : ''}`} onClick={() => void run({ type: 'RateSubstitution', orderId: o.id, lineId: x.lineId, accepted: false }, { quiet: true })}>
                              {t('不太满意')}
                            </button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t('没有缺货和替代')}</p>
                )}
                {trip && (
                  <div className="placements" role="radiogroup" aria-label={t('车内位置')}>
                    {VEHICLE_POSITIONS.map((p) => (
                      <button key={p} className={`chip${trip.placements[o.id] === p ? ' on' : ''}`} onClick={() => void run({ type: 'RecordPlacement', tripId: trip.id, orderId: o.id, position: p }, { quiet: true })}>
                        {t(POSITION_TEXT[p])}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="note">{t('替代商品按实际价格计费；不当场拒收，顾客可以在收货后申请退货。')}</p>
          {orders.some((o) => orderShortages(o).some((x) => x.substituted > 0)) && <p className="note">{t('顺便问一句顾客对替代品满不满意：只用来改进替代推荐（本店的替代用，不用于营销），不影响计费和退货。')}</p>}
          {ageBlocked && <p className="banner warn">{t('先核验证件，或勾选「无法核验：移除年龄限制商品」后再完成交付')}</p>}
          {recallBlocked && <p className="banner warn">{t('先把召回商品从框里取出，勾选后再完成交付')}</p>}
          {mtoBlocked && <p className="banner warn">{t('熟食还没取出：取出，或者顾客不要了再完成交付')}</p>}
          {bigBlocked && <p className="banner warn">{t('大件交给顾客后打勾，再完成交付')}</p>}
          <button
            className="primary block"
            disabled={ageBlocked || recallBlocked || mtoBlocked || bigBlocked}
            onClick={async () => {
              if (await run({ type: 'CompleteHandoff', key: sessionKey, removeAgeItems: removeAge, ...(recalledLines.length ? { removeRecalled: true } : {}) })) {
                toast(t('交付完成'), 'ok');
                onBack();
              }
            }}
          >
            {t('完成交付')}
          </button>
        </section>
      )}

      {/* 退出交付准备（决策记录 0026）：扫错了、顾客没来时，取出的框放回暂存区 */}
      {ss && mine && (
        <div className="leave-prep">
          {leaving ? (
            <span className="confirm-row">
              <span>{ss.scanned.length ? t('结束准备：取出的 {0} 个框要放回暂存区（暂存页「待暂存」里标「放回」）', ss.scanned.length) : t('结束准备？')}</span>
              <button
                className="primary"
                onClick={async () => {
                  if (await run({ type: 'AbandonPrep', key: sessionKey })) {
                    toast(t('已结束准备'), 'ok');
                    onBack();
                  }
                }}
              >
                {t('确认结束')}
              </button>
              <button onClick={() => setLeaving(false)}>{t('取消')}</button>
            </span>
          ) : (
            <button className="link danger" onClick={() => setLeaving(true)}>
              {t('放回暂存，结束准备')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 司机取消或门店改派后的提示：放回暂存区的框，以及行程正在重新派单（决策记录 0014） */
function TripCancelNotice({ tripId }: { tripId: string }) {
  const { client, auth } = useLive();
  const s = client.state;
  const tr = s.trips[tripId];
  const last = tr?.cancellations?.at(-1);
  if (!tr || !last || tr.acceptedAt !== undefined) return null;
  const reason = last.reason === 'WAITED_TOO_LONG' ? t('司机等待 {0} 分钟后取消', last.waitedMin ?? 0) : last.reason === 'NO_SHOW' ? t('司机没来，门店已改派') : t('司机取消了接单');
  const mine = last.sessionOwner === auth.actor;
  const inHand = tr.orderIds.flatMap((id) => s.orders[id]?.toteIds ?? []).filter((id) => s.totes[id]?.status === 'PULLED');
  return (
    <section className="phase trip-cancel">
      <p className="banner warn">
        {reason} · {t('行程正在重新派单（第 {0} 次）', tr.cancellations?.length ?? 1)}
        {last.atRisk ? ` · ${t('可能赶不上送达时段：已经提醒带班负责人')}` : ''}
      </p>
      {/* 门店要求扫码时不自动记成已放回（决策记录 0026）：到暂存页扫框、扫格位放回 */}
      {last.returns.length === 0 && inHand.length > 0 && (
        <p>{t('{0} 个已取出的框要放回暂存区：到暂存页「待暂存」里扫框、扫格位放回（标「放回」）。', inHand.length)}</p>
      )}
      {last.returns.length > 0 && (
        <>
          <p>{mine ? t('请把你取出的 {0} 个框放回暂存区：', last.returns.length) : t('{0} 个已取出的框要放回暂存区：', last.returns.length)}</p>
          <ul className="return-list">
            {last.returns.map((r) => {
              const tote = s.totes[r.toteId];
              const o = tote ? s.orders[tote.orderId] : undefined;
              return (
                <li key={r.toteId}>
                  <span className="mono">{o?.shortCode ?? ''} · {tote ? `${tote.index}/${tote.count}` : r.toteId}</span>
                  <span>→</span>
                  <b className="mono">{r.slotCode}</b>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="muted">{t('顾客已收到送达延后的通知。新司机接单后照常准备和交付。')}</p>
    </section>
  );
}

/** 准备中取消的订单（流程梳理发现，决策记录 0025）：已经取出的框放进对应温区的回收专区，放好后点一下 */
function CancelledTotes({ orderIds }: { orderIds: readonly string[] }) {
  const { client, run } = useLive();
  const s = client.state;
  const pulled = Object.values(s.totes).filter((x) => orderIds.includes(x.orderId) && s.orders[x.orderId]?.status === 'CANCELLED' && x.status === 'PULLED');
  if (!pulled.length) return null;
  return (
    <section className="phase">
      <p className="banner warn">{t('订单已取消：把已经取出的框放进对应温区的回收专区，放好后点一下。')}</p>
      <ul className="tote-list">
        {pulled.map((x) => (
          <li key={x.id}>
            <button className="row-btn" onClick={() => x.labelId && void run({ type: 'RecoverTote', labelId: x.labelId })}>
              <ZoneChip z={x.tempZone} />
              <span className="mono">{s.orders[x.orderId]?.shortCode}</span>
              <span>{t('框 {0}/{1}', x.index, x.count)}</span>
              <span className="tag">{t('已放进回收专区')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
