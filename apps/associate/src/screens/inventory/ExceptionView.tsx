import { useState } from 'react';
import { planogramByItem, resolveScan, sellableCases, type LiveException, type StoreStatic } from '@storewright/ops';
import { feedback } from '../../feedback';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';

/**
 * 后仓补取（决策 X-01～X-04）：领取 → 扫描后仓箱子（= 确认找到）→ 点选库位还有 / 已空 → 送到订单的框所在格位并扫描确认。
 * 后仓也找不到时标记，系统生成盘点任务。
 */
export function ExceptionView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const me = st.roster.find((a) => a.id === auth.actor);
  if (!me?.exceptionAuthorized) {
    return (
      <div className="empty">
        <p className="empty-title">{t('需要永久授权')}</p>
        <p>{t('后仓补取只能由有永久授权的员工执行。')}</p>
      </div>
    );
  }
  const mine = Object.values(s.exceptions).find((x) => x.associateId === auth.actor && (x.status === 'ASSIGNED' || x.status === 'FOUND'));
  if (mine) return <ExceptionTask x={mine} />;
  const open = Object.values(s.exceptions)
    .filter((x) => x.status === 'OPEN')
    .sort((a, b) => (s.orders[a.orderId]?.slotStart ?? 0) - (s.orders[b.orderId]?.slotStart ?? 0) || a.id.localeCompare(b.id));
  const byItem = planogramByItem(st);
  if (!open.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有待补取的商品')}</p>
        <p>{t('拣货员报告「货架空、后仓可能有货」时会出现在这里。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <h2 className="section-title">{t('待补取（{0}）', open.length)}</h2>
      {open.map((x) => {
        const o = s.orders[x.orderId];
        const name = o?.lines.find((l) => l.lineId === x.lineId)?.name ?? byItem.get(x.itemId)?.name ?? x.itemId;
        return (
          <article key={x.id} className="card">
            <div className="card-head">
              <span className="mono strong">{x.id}</span>
              <span>{t('订单 {0}', o?.shortCode ?? '')}</span>
              {o && <span className="due">{t('时段 {0}', clock(o.slotStart))}</span>}
            </div>
            <p>
              {name} · ×{x.qty}
            </p>
            <button className="primary block" onClick={() => void run({ type: 'ClaimException', exceptionId: x.id })}>
              {t('领取')}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function ExceptionTask({ x }: { x: LiveException }) {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const [picked, setPicked] = useState<string | undefined>();
  const o = s.orders[x.orderId];
  const line = o?.lines.find((l) => l.lineId === x.lineId);
  const p = planogramByItem(st).get(x.itemId);
  const tote = o?.toteIds.map((id) => s.totes[id]).find((tt) => tt?.lines.some((l) => l.lineId === x.lineId));
  const cases = sellableCases(s, x.itemId);

  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (x.status === 'ASSIGNED' && r.kind === 'case') {
      if (r.itemId !== x.itemId) {
        feedback('error');
        return toast(t('不是这个商品的箱子'), 'error');
      }
      feedback('ok');
      return setPicked(r.caseId);
    }
    if (x.status === 'FOUND' && r.kind === 'slot') {
      void run({ type: 'DeliverException', exceptionId: x.id, slotCode: r.code });
      return;
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };

  return (
    <div className="walk">
      <header className="walk-head">
        {p && <ZoneChip z={p.tempZone} big />}
        <div>
          <div className="strong">
            {line?.name ?? x.itemId} · ×{x.qty}
          </div>
          <div className="muted">
            {x.id} · {t('订单 {0}', o?.shortCode ?? '')}
            {o ? ` · ${t('时段 {0}', clock(o.slotStart))}` : ''}
          </div>
        </div>
      </header>
      {x.status === 'ASSIGNED' && (
        <section className="phase">
          <h3 className="section-title">{t('后仓里有这个商品的箱子')}</h3>
          <ul className="tote-list">
            {cases.map((c) => (
              <li key={c.id}>
                <button className={`row-btn${picked === c.id ? ' selected' : ''}`} onClick={() => setPicked(c.id)}>
                  <span className="mono strong">{c.binCode}</span>
                  <span className="mono">{c.id}</span>
                  <span>{t('{0} 件', c.units)}</span>
                </button>
              </li>
            ))}
          </ul>
          <ScanBox label={t('扫描箱子标签（= 确认找到）')} onScan={onScan} />
          {picked && (
            <div className="card">
              <p>{t('取出 {0} 件后，这个库位里这个商品：', x.qty)}</p>
              <div className="actions">
                <button className="primary" onClick={() => void run({ type: 'ExceptionFound', exceptionId: x.id, caseId: picked, binEmpty: false })}>
                  {t('还有')}
                </button>
                <button onClick={() => void run({ type: 'ExceptionFound', exceptionId: x.id, caseId: picked, binEmpty: true })}>{t('已空')}</button>
              </div>
            </div>
          )}
          <button className="block warn" onClick={() => void run({ type: 'ExceptionMissing', exceptionId: x.id })}>
            {t('后仓也找不到')}
          </button>
        </section>
      )}
      {x.status === 'FOUND' && (
        <section className="phase">
          <p className="banner info">{t('已找到。补货任务已自动生成，箱里剩下的件数会补到货架上。')}</p>
          {tote?.status === 'STAGED' ? (
            <>
              <h3 className="section-title">{t('送到暂存格位 {0}，放进框 {1}/{2}', tote.slotCode ?? '', tote.index, tote.count)}</h3>
              <ScanBox label={t('扫描格位标签确认')} onScan={onScan} />
              <button className="link" onClick={() => tote.slotCode && void run({ type: 'DeliverException', exceptionId: x.id, slotCode: tote.slotCode })}>
                {t('没有格位标签？手动确认（演示）')}
              </button>
            </>
          ) : (
            <p className="banner warn">{t('这个订单的框还没放进暂存区（{0}），稍后再送', tote?.status ?? '—')}</p>
          )}
        </section>
      )}
    </div>
  );
}
