import { useState } from 'react';
import { displayName, recoveryNeeded, resolveScan, stagingOccupancy, suggestSlots, type StoreStatic } from '@storewright/ops';
import { feedback } from '../feedback';
import { t } from '../i18n';
import { useLive } from '../live';
import { zone } from '../rejects';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { ZoneChip } from '../ui/ZoneChip';

/** 暂存：扫描框标签 → 自选格位（系统建议作参考）→ 扫描格位标签确认（决策 S-02） */
export function StageScreen() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic | undefined;
  const [toteId, setToteId] = useState<string | undefined>();
  const [recovery, setRecovery] = useState<string | undefined>();
  if (!st) return null;
  const tote = toteId ? s.totes[toteId] : undefined;
  const order = tote ? s.orders[tote.orderId] : undefined;
  const waiting = Object.values(s.totes)
    .filter((x) => x.status === 'PICKED')
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  const suggestions = tote && tote.status !== 'RECOVERY' ? suggestSlots(s, st, tote.id, 4) : [];

  const stage = async (slotCode: string) => {
    if (!tote?.labelId) return;
    const before = s.totes[tote.id]?.status;
    const ok = await run({ type: 'StageTote', labelId: tote.labelId, slotCode });
    if (!ok) return;
    const after = client.state.totes[tote.id];
    if (after?.status === 'RECOVERY' && before !== 'RECOVERY') {
      setRecovery(after.tempZone);
      feedback('error');
    } else toast(t('已放进 {0}', slotCode), 'ok', 1800);
    setToteId(undefined);
  };

  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'label') {
      if (r.voided) return toast(t('这个标签已作废，请用新标签'), 'error');
      setRecovery(undefined);
      const t0 = s.totes[r.toteId];
      if (s.orders[r.orderId]?.status === 'CANCELLED' && t0?.labelId) {
        // 订单已取消：直接提示放回收专区
        setToteId(r.toteId);
        void run({ type: 'StageTote', labelId: t0.labelId, slotCode: '-' }).then((ok) => ok && setRecovery(t0.tempZone));
        return;
      }
      setToteId(r.toteId);
      return;
    }
    if (r.kind === 'slot') {
      if (!tote) return toast(t('请先扫描框标签'), 'error');
      void stage(r.code);
      return;
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };

  return (
    <div className="stage">
      <Occupancy />
      {recovery && (
        <p className="banner error big" role="alert">
          {t('订单已取消：把这个框放进{0}回收专区', zone(recovery))}
        </p>
      )}
      <ScanBox label={tote ? t('扫描格位标签（或点下面的格位）') : t('扫描框标签')} onScan={onScan} />
      {tote && order && tote.status !== 'RECOVERY' && (
        <article className="card">
          <div className="card-head">
            <ZoneChip z={tote.tempZone} />
            <span className="strong">{displayName(order.firstName, order.lastName)}</span>
            <span className="mono">{order.shortCode}</span>
          </div>
          <p>
            {t('框 {0}/{1}', tote.index, tote.count)} · {order.type === 'PICKUP' ? t('自取') : t('配送')}
            {tote.slotCode ? ` · ${t('当前在 {0}', tote.slotCode)}` : ''}
          </p>
          {suggestions.length > 0 && (
            <>
              <h4>{t('建议格位（可以自选其他格位）')}</h4>
              <div className="chips">
                {suggestions.map((c) => (
                  <button key={c} className="chip mono" onClick={() => void stage(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </>
          )}
          <button className="link" onClick={() => setToteId(undefined)}>
            {t('换一个框')}
          </button>
        </article>
      )}
      <section>
        <h2 className="section-title">{t('待暂存（{0}）', waiting.length)}</h2>
        {waiting.length === 0 && <p className="muted">{t('拣完的框会出现在这里。')}</p>}
        <ul className="tote-list">
          {waiting.map((x) => {
            const o = s.orders[x.orderId];
            return (
              <li key={x.id}>
                <button className={`row-btn${x.id === toteId ? ' selected' : ''}`} onClick={() => setToteId(x.id)}>
                  <ZoneChip z={x.tempZone} />
                  <span className="mono">{o?.shortCode}</span>
                  <span>{t('框 {0}/{1}', x.index, x.count)}</span>
                  <span className="muted">{o ? displayName(o.firstName, o.lastName) : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <Recovery onPick={(id) => setToteId(id)} />
    </div>
  );
}

function Occupancy() {
  const { client } = useLive();
  const st = client.statics;
  if (!st) return null;
  return (
    <div className="occupancy" aria-label={t('暂存占用率')}>
      {stagingOccupancy(client.state, st).map((z) => (
        <div key={z.tempZone} className={`occ${z.alert ? ' alert' : ''}`}>
          <ZoneChip z={z.tempZone} />
          <div className="bar">
            <i style={{ width: `${Math.min(100, z.rate * 100)}%` }} />
          </div>
          <span className="mono">{Math.round(z.rate * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

/** 已暂存但订单已取消的框：移到回收专区 */
function Recovery({ onPick }: { onPick: (toteId: string) => void }) {
  const { client, run } = useLive();
  const list = recoveryNeeded(client.state);
  if (!list.length) return null;
  return (
    <section>
      <h2 className="section-title warn-text">{t('需要移到回收专区（{0}）', list.length)}</h2>
      <ul className="tote-list">
        {list.map((x) => (
          <li key={x.id}>
            <button
              className="row-btn"
              onClick={() => {
                onPick(x.id);
                if (x.labelId) void run({ type: 'RecoverTote', labelId: x.labelId });
              }}
            >
              <ZoneChip z={x.tempZone} />
              <span className="mono">{x.slotCode}</span>
              <span>{t('订单 {0}', client.state.orders[x.orderId]?.shortCode ?? '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
