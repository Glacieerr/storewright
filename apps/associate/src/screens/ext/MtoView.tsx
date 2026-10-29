import { useState } from 'react';
import { displayName, mtoBoard, type MtoTicket } from '@storewright/ops';
import { clock, t } from '../../i18n';
import { useLive, useNow } from '../../live';
import { ScanBox } from '../../ui/ScanBox';

const DISCARD_TEXT: Record<NonNullable<MtoTicket['discardReason']>, string> = { HOLD_EXPIRED: '保温超时', MANUAL: '手动丢弃', ORDER_CANCELLED: '订单取消' };

/**
 * 熟食现做（工作流设计 4.8）：排队中按建议开始时间排序（AI 根据菜品与厨房负载调整时标出），
 * 制作完成放入保温位并开始计时，超过保温时限自动丢弃；交付准备时取出。
 */
export function MtoView() {
  const { client, run, nameOf } = useLive();
  const s = client.state;
  const now = useNow(10_000);
  const board = mtoBoard(s);
  const hotSlots = client.statics?.hotSlots ?? [];
  const [slot, setSlot] = useState<Record<string, string>>({});
  // 门店要求扫码时，保温位只能扫标签（决策记录 0026）；扫码框一次只开一个（自动获取焦点）
  const strict = !!s.settings?.requireScan;
  const [scanFor, setScanFor] = useState<string | undefined>();
  const all = Object.values(s.mto);
  const pulled = all.filter((x) => x.status === 'PULLED').length;
  const discarded = all.filter((x) => x.status === 'DISCARDED');
  const usedSlots = new Set(board.held.map((x) => x.slotCode).filter(Boolean));
  const who = (x: MtoTicket) => {
    const o = s.orders[x.orderId];
    return o ? `${displayName(o.firstName, o.lastName.slice(0, 1))} · ${t('{0} 取货', clock(o.slotStart))}` : x.orderId;
  };
  if (!all.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有现做单')}</p>
        <p>{t('订单里有熟食现做商品时会出现在这里（演示中由控制台下单时勾选）。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <p className="note">{t('今天已取出 {0} 份 · 已丢弃 {1} 份（保温超时 {2}）', pulled, discarded.length, discarded.filter((x) => x.discardReason === 'HOLD_EXPIRED').length)}</p>

      <h2 className="section-title">{t('排队中（{0}）', board.queued.length)}</h2>
      {board.queued.map((x) => {
        const late = now > x.startAt;
        return (
          <div key={x.id} className="card">
            <div className="card-head">
              <b>
                {x.name} × {x.qty}
              </b>
              {x.hot && <span className="tag">{t('热食')}</span>}
              {x.aiAdjusted && (
                <span className="tag ai" title={t('标准建议 {0}', clock(x.standardStartAt))}>
                  {t('AI 调整')}
                </span>
              )}
              <span className={`due${late ? ' late' : ''}`}>{late ? t('应在 {0} 开始，已晚', clock(x.startAt)) : t('建议 {0} 开始', clock(x.startAt))}</span>
            </div>
            <div className="facts">
              <span>{who(x)}</span>
              {x.aiAdjusted && <span>{t('标准建议 {0}', clock(x.standardStartAt))}</span>}
              <span>{t('{0} 前做好', clock(x.dueAt))}</span>
            </div>
            <div className="actions">
              <button className="primary" onClick={() => void run({ type: 'StartMto', ticketId: x.id })}>
                {t('开始制作')}
              </button>
              <button className="link danger" onClick={() => void run({ type: 'DiscardMto', ticketId: x.id })}>
                {t('丢弃')}
              </button>
            </div>
          </div>
        );
      })}

      <h2 className="section-title">{t('制作中（{0}）', board.cooking.length)}</h2>
      {board.cooking.map((x) => {
        const free = hotSlots.filter((c) => !usedSlots.has(c));
        const chosen = slot[x.id] ?? free[0];
        const needSlot = x.hot && hotSlots.length > 0;
        // 要求扫码时默认给第一份热食开扫码框
        const scanning = needSlot && (scanFor === x.id || (strict && scanFor === undefined && board.cooking.find((y) => y.hot)?.id === x.id));
        return (
          <div key={x.id} className="card">
            <div className="card-head">
              <b>
                {x.name} × {x.qty}
              </b>
              <span className={`due${now > x.dueAt ? ' late' : ''}`}>{t('{0} 前做好', clock(x.dueAt))}</span>
            </div>
            <div className="facts">
              <span>{who(x)}</span>
              <span>{t('{0} 开始 · {1}', clock(x.startedAt ?? now), nameOf(x.associateId))}</span>
            </div>
            {needSlot && (
              <div className="chips">
                {free.map((c) => (
                  <button key={c} className={`chip${chosen === c ? ' on' : ''}`} disabled={strict} onClick={() => setSlot({ ...slot, [x.id]: c })}>
                    {c}
                  </button>
                ))}
                {!free.length && <span className="muted">{t('保温位已满')}</span>}
              </div>
            )}
            {scanning && <ScanBox label={t('扫保温位标签：做好放进去')} hint={free[0] ? t('例如 {0}', free[0]) : undefined} onScan={(code) => run({ type: 'CompleteMto', ticketId: x.id, slotCode: code })} />}
            <div className="actions">
              {!(needSlot && strict) && (
                <button className="primary" onClick={() => void run({ type: 'CompleteMto', ticketId: x.id, ...(needSlot && chosen ? { slotCode: chosen, tap: true } : {}) })}>
                  {needSlot && chosen ? t('完成，放入 {0}', chosen) : t('完成')}
                </button>
              )}
              {needSlot && !scanning && (
                <button className={strict ? 'primary' : 'link'} onClick={() => setScanFor(x.id)}>
                  {t('扫保温位放入')}
                </button>
              )}
              {/* 做坏了、掉了：制作中也能丢弃（决策记录 0026） */}
              <button className="link danger" onClick={() => void run({ type: 'DiscardMto', ticketId: x.id })}>
                {t('丢弃')}
              </button>
            </div>
          </div>
        );
      })}

      <h2 className="section-title">{t('保温中（{0}）', board.held.length)}</h2>
      {board.held.map((x) => {
        const left = Math.round(((x.discardAt ?? now) - now) / 60_000);
        return (
          <div key={x.id} className="card">
            <div className="card-head">
              <b>
                {x.name} × {x.qty}
              </b>
              {x.slotCode && <span className="tag mono">{x.slotCode}</span>}
              <span className={`due${left <= 10 ? ' late' : ''}`}>{t('{0} 分钟后丢弃', Math.max(0, left))}</span>
            </div>
            <div className="facts">
              <span>{who(x)}</span>
            </div>
            <div className="actions">
              <button className="primary" onClick={() => void run({ type: 'PullMto', ticketId: x.id })}>
                {t('取出（交付准备）')}
              </button>
              <button className="link danger" onClick={() => void run({ type: 'DiscardMto', ticketId: x.id })}>
                {t('丢弃')}
              </button>
            </div>
          </div>
        );
      })}

      {discarded.length > 0 && (
        <>
          <h2 className="section-title">{t('已丢弃')}</h2>
          <ul className="plain">
            {discarded.slice(-5).map((x) => (
              <li key={x.id}>
                {x.name} × {x.qty} · {t(DISCARD_TEXT[x.discardReason ?? 'MANUAL'])} · {clock(x.discardedAt ?? now)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
