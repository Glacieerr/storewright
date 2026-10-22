import { parcelTrips, suggestParcelSlot, type Parcel, type StoreStatic } from '@storewright/ops';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';

const STATUS_TEXT: Record<Parcel['status'], string> = { EXPECTED: '预期到货', INDUCTED: '已入站', STAGED: '已暂存', HANDED_OFF: '已交接', SHORT: '短少', DAMAGED: '损坏', OVER: '多出（待核实）' };
const REASON_TEXT = { SAME_TRIP: '同一行程已经在用这个格位', SIZE_AND_DISTANCE: '尺寸合适、离门口近' } as const;

/**
 * 包裹中转（工作流设计 4.9）：扫描包裹入站（没有到货通知的标为多出），按格位建议暂存，
 * 损坏的单独登记；司机按行程整批交接。
 */
export function ParcelView() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const trips = parcelTrips(s);
  const inducted = Object.values(s.parcels).filter((p) => p.status === 'INDUCTED');
  const over = Object.values(s.parcels).filter((p) => p.status === 'OVER');
  const induct = (code: string) => void run({ type: 'InductParcel', code });
  return (
    <div className="list">
      <ScanBox onScan={induct} label={t('扫描包裹编码入站')} />

      {inducted.length > 0 && <h2 className="section-title">{t('待暂存（{0}）', inducted.length)}</h2>}
      {inducted.map((p) => {
        const sug = suggestParcelSlot(s, st, p);
        return (
          <div key={p.id} className="card">
            <div className="card-head">
              <b className="mono">{p.id}</b>
              <span className="tag">{p.sizeClass}</span>
              <span className="muted">
                {p.tripRef} · {Math.round(p.weightKg * 10) / 10} kg
              </span>
            </div>
            {sug ? (
              <p className="ext-ai">
                <b>{t('建议格位 {0}', sug.slotCode)}</b> · {t(REASON_TEXT[sug.reason])}
              </p>
            ) : (
              <p className="banner warn">{t('没有合适的空格位')}</p>
            )}
            <div className="chips">
              {(st.parcelSlots ?? []).map((x) => (
                <button key={x.code} className={`chip${sug?.slotCode === x.code ? ' suggested' : ''}`} onClick={() => void run({ type: 'StageParcel', parcelId: p.id, slotCode: x.code })}>
                  {x.code}
                  <small> {x.size}</small>
                </button>
              ))}
            </div>
            <div className="actions">
              {sug && (
                <button className="primary" onClick={() => void run({ type: 'StageParcel', parcelId: p.id, slotCode: sug.slotCode })}>
                  {t('放到 {0}', sug.slotCode)}
                </button>
              )}
              <button className="link danger" onClick={() => void run({ type: 'ReportParcelDamaged', parcelId: p.id })}>
                {t('登记损坏')}
              </button>
            </div>
          </div>
        );
      })}

      {over.length > 0 && (
        <>
          <h2 className="section-title">{t('多出（待核实，{0}）', over.length)}</h2>
          <ul className="plain">
            {over.map((p) => (
              <li key={p.id}>
                <span className="mono">{p.id}</span> · {t('{0} 入站，没有到货通知', clock(p.inductedAt ?? 0))}
              </li>
            ))}
          </ul>
        </>
      )}

      {trips.length > 0 && <h2 className="section-title">{t('按行程（{0}）', trips.length)}</h2>}
      {!trips.length && !inducted.length && !over.length && (
        <div className="empty">
          <p className="empty-title">{t('没有待处理的包裹')}</p>
          <p>{t('承运商发出到货通知后会出现在这里（演示中由控制台发送）。')}</p>
        </div>
      )}
      {trips.map((tr) => (
        <div key={tr.tripRef} className="card">
          <div className="card-head">
            <b className="mono">{tr.tripRef}</b>
            <span className="muted">{t('{0} 件', tr.parcels.length)}</span>
          </div>
          <ul className="plain">
            {tr.parcels.map((p) => (
              <li key={p.id} className="row-head">
                <span>
                  <span className="mono">{p.id}</span> · {p.sizeClass} · <span className={`tag${p.status === 'SHORT' || p.status === 'DAMAGED' ? ' warn' : p.status === 'STAGED' ? ' ok' : ''}`}>{t(STATUS_TEXT[p.status])}</span>
                  {p.slotCode && <b className="mono"> {p.slotCode}</b>}
                </span>
                {(p.status === 'EXPECTED' || p.status === 'SHORT') && (
                  <button className="link" onClick={() => induct(p.id)} title={t('演示：代替扫描')}>
                    {t('点选代替扫描')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
