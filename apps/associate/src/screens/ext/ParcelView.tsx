import { useState } from 'react';
import { parcelTrips, suggestParcelSlot, type Parcel, type StoreStatic } from '@storewright/ops';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';

const STATUS_TEXT: Record<Parcel['status'], string> = { EXPECTED: '预期到货', INDUCTED: '已入站', STAGED: '已暂存', HANDED_OFF: '已交接', SHORT: '短少', DAMAGED: '损坏', OVER: '多出（待核实）', RETURNED: '已退回快递', HELD: '异常区保留' };
const REASON_TEXT = { SAME_TRIP: '同一行程已经在用这个格位', SIZE_AND_DISTANCE: '尺寸合适、离门口近' } as const;

/**
 * 包裹中转（工作流设计 4.9）：扫描包裹入站，按格位建议暂存，损坏的单独登记；司机按行程整批交接。
 * 决策记录 0026：到货通知里没有的编码先问一句再登记为多出（扫错、输错的不算）；入站后直接扫格位标签放进去；
 * 多出和损坏的包裹选退回快递或放在异常区；员工手机也能按行程交给司机。
 */
export function ParcelView() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const strict = !!s.settings?.requireScan;
  const [unknown, setUnknown] = useState<string | undefined>();
  const [current, setCurrent] = useState<string | undefined>();
  const trips = parcelTrips(s);
  const inducted = Object.values(s.parcels).filter((p) => p.status === 'INDUCTED');
  const open = Object.values(s.parcels).filter((p) => p.status === 'OVER' || p.status === 'DAMAGED');
  const held = Object.values(s.parcels).filter((p) => p.status === 'HELD');
  const slotCodes = new Set((st.parcelSlots ?? []).map((x) => x.code));
  // 扫格位标签时放的是刚扫入站的那一件，没有就放最早入站的
  const target = current && s.parcels[current]?.status === 'INDUCTED' ? current : inducted[0]?.id;
  const induct = async (code: string, tap?: boolean) => {
    if (await run({ type: 'InductParcel', code, ...(tap ? { tap: true } : {}) })) setCurrent(code.trim().toUpperCase());
  };
  const onScan = (raw: string) => {
    const code = raw.trim().toUpperCase();
    if (slotCodes.has(code)) {
      if (!target) toast(t('先扫包裹，再扫格位标签'), 'info');
      else void run({ type: 'StageParcel', parcelId: target, slotCode: code });
      return;
    }
    setUnknown(undefined);
    if (!s.parcels[code]) setUnknown(code);
    else void induct(code);
  };
  return (
    <div className="list">
      <ScanBox onScan={onScan} label={inducted.length ? t('扫包裹编码入站，或扫格位标签放入 {0}', target ?? '') : t('扫描包裹编码入站')} />
      {unknown && (
        <div className="banner warn" role="alert">
          <p>{t('{0} 不在到货通知里。看清编码再扫一次；确实是多出来的包裹再登记。', unknown)}</p>
          <div className="actions">
            <button
              className="primary"
              onClick={() =>
                void run({ type: 'InductParcel', code: unknown, extra: true }).then((ok) => {
                  if (ok) setUnknown(undefined);
                })
              }
            >
              {t('登记为多出（放待核实区）')}
            </button>
            <button className="link" onClick={() => setUnknown(undefined)}>
              {t('扫错了')}
            </button>
          </div>
        </div>
      )}

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
            {strict && <p className="note">{t('放进格位后扫格位标签')}</p>}
            <div className="chips">
              {(st.parcelSlots ?? []).map((x) => (
                <button key={x.code} className={`chip${sug?.slotCode === x.code ? ' suggested' : ''}`} disabled={strict} onClick={() => void run({ type: 'StageParcel', parcelId: p.id, slotCode: x.code, tap: true })}>
                  {x.code}
                  <small> {x.size}</small>
                </button>
              ))}
            </div>
            <div className="actions">
              {sug && !strict && (
                <button className="primary" onClick={() => void run({ type: 'StageParcel', parcelId: p.id, slotCode: sug.slotCode, tap: true })}>
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

      {open.length > 0 && <h2 className="section-title">{t('多出和损坏（{0}）', open.length)}</h2>}
      {open.map((p) => (
        <div key={p.id} className="card">
          <div className="card-head">
            <b className="mono">{p.id}</b>
            <span className="tag warn">{t(STATUS_TEXT[p.status])}</span>
            <span className="muted">{p.status === 'OVER' ? t('{0} 入站，没有到货通知', clock(p.inductedAt ?? 0)) : p.tripRef}</span>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => void run({ type: 'ResolveParcel', parcelId: p.id, action: 'RETURN' })}>
              {t('退回快递')}
            </button>
            <button className="link" onClick={() => void run({ type: 'ResolveParcel', parcelId: p.id, action: 'HOLD' })}>
              {t('放异常区等认领')}
            </button>
          </div>
        </div>
      ))}
      {held.length > 0 && (
        <p className="note">
          {t('异常区保留 {0} 件：', held.length)}
          <span className="mono">{held.map((p) => p.id).join('、')}</span>
        </p>
      )}

      {trips.length > 0 && <h2 className="section-title">{t('按行程（{0}）', trips.length)}</h2>}
      {!trips.length && !inducted.length && !open.length && (
        <div className="empty">
          <p className="empty-title">{t('没有待处理的包裹')}</p>
          <p>{t('承运商发出到货通知后会出现在这里（演示中由控制台发送）。')}</p>
        </div>
      )}
      {trips.map((tr) => {
        const staged = tr.parcels.filter((p) => p.status === 'STAGED').length;
        const loose = tr.parcels.filter((p) => p.status === 'INDUCTED').length;
        return (
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
                  {(p.status === 'EXPECTED' || p.status === 'SHORT') && !strict && (
                    <button className="link" onClick={() => void induct(p.id, true)} title={t('演示：代替扫描')}>
                      {t('点选代替扫描')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {staged > 0 && (
              <div className="actions">
                {/* 司机来取：整个行程一起交（决策记录 0026：以前只有控制台能操作） */}
                <button className="primary" disabled={loose > 0} onClick={() => void run({ type: 'HandOffParcels', tripRef: tr.tripRef })}>
                  {t('交给司机（{0} 件）', staged)}
                </button>
                {loose > 0 && <span className="muted">{t('还有 {0} 件没放进格位', loose)}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
