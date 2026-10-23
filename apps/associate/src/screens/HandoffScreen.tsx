import { useState } from 'react';
import { VEHICLE_POSITIONS, type VehiclePosition } from '@storewright/domain';
import { displayName, handoffBoard, needsAgeCheck, orderShortages, resolveScan, sessionKeyFor, sessionTotes, type BoardRow, type StoreStatic } from '@storewright/ops';
import { labelUrl } from '../api';
import { feedback } from '../feedback';
import { clock, duration, t } from '../i18n';
import { useLive, useNow } from '../live';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { ZoneChip } from '../ui/ZoneChip';

/** 交付：看板（四色状态，先到先服务）→ 准备（扫描任意一个框即加锁）→ 核验 → 交付 */
export function HandoffScreen() {
  const { client } = useLive();
  const [open, setOpen] = useState<string | undefined>();
  const now = useNow(1000);
  const st = client.statics as StoreStatic | undefined;
  if (!st) return null;
  if (open) return <SessionView sessionKey={open} onBack={() => setOpen(undefined)} />;
  // 自动运营的订单和行程由虚拟员工交付，不在员工的交付看板上
  const rows = handoffBoard(client.state, st, now).filter((r) => r.orderIds.every((id) => client.state.orders[id]?.track !== 'AUTO'));
  const onScan = (raw: string) => {
    const r = resolveScan(client.state, st, raw);
    if (r.kind === 'label') return setOpen(sessionKeyFor(client.state, r.orderId));
    if (r.kind === 'order') return setOpen(sessionKeyFor(client.state, r.orderId));
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };
  return (
    <div className="handoff">
      <ScanBox label={t('扫描任意一个框，或输入订单短号')} onScan={onScan} />
      <h2 className="section-title">{t('交付看板（{0}）', rows.length)}</h2>
      {rows.length === 0 && <p className="muted">{t('锁单后的订单会出现在这里。')}</p>}
      <ul className="board">
        {rows.map((r) => (
          <li key={r.key}>
            <BoardItem row={r} now={now} onOpen={() => setOpen(r.key)} />
          </li>
        ))}
      </ul>
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
  const trip = s.trips[sessionKey];
  const orderIds = trip ? trip.orderIds.filter((id) => s.orders[id]?.status !== 'CANCELLED') : [sessionKey];
  const orders = orderIds.map((id) => s.orders[id]).filter((o) => !!o);
  const ss = s.sessions[sessionKey];
  const mine = !!ss && (ss.owner === auth.actor || ss.helpers.includes(auth.actor));
  const ageBlocked = !!ss && ss.status === 'HANDING_OFF' && needsAgeCheck(s, orderIds) && !ss.ageVerified && !removeAge;
  const arrivedAt = trip ? trip.arrivedAt : orders[0]?.arrivedAt;
  const totes = sessionTotes(s, orderIds);
  const staged = orders.every((o) => o.stagedAt !== undefined);
  const title = trip ? t('行程 {0}', trip.id) : orders[0] ? displayName(orders[0].firstName, orders[0].lastName) : sessionKey;

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
      </header>

      {trip && <TripCancelNotice tripId={trip.id} />}

      {!ss && (
        <section className="phase">
          {staged ? (
            <>
              <p>{t('扫描任意一个框开始准备，订单会锁定给你，其他人只能加入协助。')}</p>
              <ScanBox label={t('扫描框标签')} onScan={(c) => void onScan(c)} />
              <button className="primary block" onClick={() => void run({ type: 'StartPrep', key: sessionKey })}>
                {t('开始准备')}
              </button>
            </>
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

      {ss && mine && ss.status === 'PREPPING' && (
        <section className="phase">
          <h3 className="section-title">{t('从暂存区取出（{0} / {1}）', ss.scanned.length, totes.length)}</h3>
          <ScanBox label={t('逐框扫描')} onScan={(c) => void onScan(c)} />
          <ul className="prep-list">
            {totes.map((x) => {
              const done = ss.scanned.includes(x.id);
              return (
                <li key={x.id} className={done ? 'done' : ''}>
                  <button className="row-btn" disabled={done} onClick={() => x.labelId && void run({ type: 'ScanPrepTote', key: sessionKey, labelId: x.labelId })}>
                    <span className="check">{done ? '✓' : ''}</span>
                    <ZoneChip z={x.tempZone} />
                    <span className="mono strong">{x.slotCode ?? '—'}</span>
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

      {ss && mine && ss.status === 'READY' && (
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
              {ss.manualRequired && (
                <div className="manual-alt">
                  <p className="muted">{t('也可以改用人工核验：核对证件和订单信息。')}</p>
                  <button type="button" onClick={() => void run({ type: 'VerifyManually', key: sessionKey })}>
                    {t('已人工核验')}
                  </button>
                </div>
              )}
            </form>
          )}
        </section>
      )}

      {ss && mine && ss.status === 'HANDING_OFF' && (
        <section className="phase">
          {/* 年龄核验没完成时不能完成交付（决策 H-05：核验证件，或移除年龄限制商品） */}
          <h3 className="section-title">{t('交付')}</h3>
          {needsAgeCheck(s, orderIds) && !ss.ageVerified && (
            <div className="check-block">
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
            </div>
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
          {ageBlocked && <p className="banner warn">{t('先核验证件，或勾选「无法核验：移除年龄限制商品」后再完成交付')}</p>}
          <button
            className="primary block"
            disabled={ageBlocked}
            onClick={async () => {
              if (await run({ type: 'CompleteHandoff', key: sessionKey, removeAgeItems: removeAge })) {
                toast(t('交付完成'), 'ok');
                onBack();
              }
            }}
          >
            {t('完成交付')}
          </button>
        </section>
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
  return (
    <section className="phase trip-cancel">
      <p className="banner warn">
        {reason} · {t('行程正在重新派单（第 {0} 次）', tr.cancellations?.length ?? 1)}
        {last.atRisk ? ` · ${t('可能赶不上送达时段，请通知带班负责人')}` : ''}
      </p>
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
