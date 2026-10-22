import { useState } from 'react';
import { planLoads } from '@storewright/ai';
import { displayName, oversizedByOrder, type OversizedTask } from '@storewright/ops';
import { labelUrl } from '../../api';
import { feedback } from '../../feedback';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';

const kg = (v: number) => Math.round(v * 10) / 10;

const STATUS_TEXT: Record<OversizedTask['status'], string> = { OPEN: '待领取', CLAIMED: '已领取', LABELED: '已贴标签', STAGED: '已暂存' };

/**
 * 大件（工作流设计 4.3）：领取一单的大件（按装载建议一趟领几件），先扫商品条码再打印这一件的标签，
 * 放到大件区。需要两人搬运的件单独一趟。
 */
export function OversizedView() {
  const { client, auth, run, nameOf } = useLive();
  const s = client.state;
  const areas = client.statics?.oversizedAreas ?? [];
  const [area, setArea] = useState<string | undefined>();
  const byOrder = [...oversizedByOrder(s).entries()]
    .map(([orderId, pieces]) => ({ orderId, pieces, order: s.orders[orderId] }))
    .filter((x) => x.pieces.some((p) => p.status !== 'STAGED') && x.order && x.order.status !== 'CANCELLED' && x.order.status !== 'COMPLETED')
    .sort((a, b) => (a.order?.slotStart ?? 0) - (b.order?.slotStart ?? 0));
  const mine = Object.values(s.oversized).filter((p) => p.associateId === auth.actor && (p.status === 'CLAIMED' || p.status === 'LABELED'));
  const onScan = (raw: string) => {
    const code = raw.trim().replace(/^0+/, '');
    const p = mine.find((x) => x.status === 'CLAIMED' && x.gtin.replace(/^0+/, '') === code);
    if (!p) {
      feedback('error');
      return toast(t('这个条码不是你领取的大件'), 'error');
    }
    void run({ type: 'ScanOversized', pieceId: p.id, code: raw });
  };
  if (!byOrder.length && !mine.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有待处理的大件')}</p>
        <p>{t('锁单时分框算法分出的大件会出现在这里（演示中由控制台下单时勾选）。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      {mine.length > 0 && (
        <div className="card">
          <h2 className="section-title">{t('我领取的大件（{0}）', mine.length)}</h2>
          {mine.some((p) => p.status === 'CLAIMED') && <ScanBox onScan={onScan} label={t('扫描商品条码，然后打印这一件的标签')} />}
          <ul className="plain">
            {mine.map((p) => (
              <li key={p.id} className="row-head">
                <span>
                  <b>{p.name}</b> · {p.index}/{p.count} · {kg(p.weightKg)} kg {p.teamLift && <span className="tag warn">{t('需两人搬运')}</span>}
                  <span className="tag">{t(STATUS_TEXT[p.status])}</span>
                </span>
                {p.status === 'CLAIMED' && (
                  <span className="actions">
                    <button className="link" onClick={() => onScan(p.gtin)} title={t('演示：代替扫描')}>
                      {t('点选代替扫描')}
                    </button>
                    <button className="link" onClick={() => void run({ type: 'ReleaseOversized', pieceIds: [p.id] })}>
                      {t('放回')}
                    </button>
                  </span>
                )}
                {p.status === 'LABELED' && (
                  <span className="actions">
                    <a className="link" href={labelUrl(auth, `oversized/${p.id}.svg`)} target="_blank" rel="noopener">
                      {t('打印标签 {0}/{1}', p.index, p.count)}
                    </a>
                    <button className="primary" disabled={!(area ?? areas[0]) && areas.length > 0} onClick={() => void run({ type: 'StageOversized', pieceId: p.id, area: area ?? areas[0] ?? 'BULK' })}>
                      {t('放到 {0}', area ?? areas[0] ?? 'BULK')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {areas.length > 1 && mine.some((p) => p.status === 'LABELED') && (
            <div className="chips">
              {areas.map((a) => (
                <button key={a} className={`chip${(area ?? areas[0]) === a ? ' on' : ''}`} onClick={() => setArea(a)}>
                  {a}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {byOrder.map(({ orderId, pieces, order }) => {
        const open = pieces.filter((p) => p.status === 'OPEN');
        const trips = planLoads(open.map((p) => ({ id: p.id, weightKg: p.weightKg, teamLift: p.teamLift })));
        const first = trips[0];
        const staged = pieces.filter((p) => p.status === 'STAGED').length;
        return (
          <div key={orderId} className="card">
            <div className="card-head">
              <b>{order ? displayName(order.firstName, order.lastName.slice(0, 1)) : orderId}</b>
              <span className="mono">{order?.shortCode}</span>
              <span className="due">{order ? t('{0} 取货', clock(order.slotStart)) : ''}</span>
            </div>
            <div className="facts">
              <span>{t('已暂存 {0}/{1}', staged, pieces.length)}</span>
              {pieces
                .filter((p) => p.status !== 'OPEN' && p.status !== 'STAGED' && p.associateId !== auth.actor)
                .map((p) => (
                  <span key={p.id}>{t('{0} 处理中（{1}）', nameOf(p.associateId), `${p.index}/${p.count}`)}</span>
                ))}
              {pieces
                .filter((p) => p.status === 'STAGED')
                .map((p) => (
                  <span key={p.id}>
                    {p.index}/{p.count} → {p.area}
                  </span>
                ))}
            </div>
            {first && (
              <>
                <p className="note">
                  {t('装载建议：分 {0} 趟', trips.length)} ·{' '}
                  {trips
                    .map((tr, i) =>
                      t('第 {0} 趟 {1} 件（{2} kg）{3}', i + 1, tr.pieceIds.length, Math.round(tr.weightKg * 10) / 10, tr.teamLift ? t('，需两人') : ''),
                    )
                    .join('；')}
                </p>
                <ul className="plain">
                  {open.map((p) => (
                    <li key={p.id}>
                      {p.name} · {p.index}/{p.count} · {kg(p.weightKg)} kg {p.teamLift && <span className="tag warn">{t('需两人搬运')}</span>}
                    </li>
                  ))}
                </ul>
                <button className="primary block" onClick={() => void run({ type: 'ClaimOversized', orderId, maxPieces: first.pieceIds.length, pieceIds: first.pieceIds })}>
                  {t('领取第 1 趟（{0} 件）', first.pieceIds.length)}
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
