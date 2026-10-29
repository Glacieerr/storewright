import { useState } from 'react';
import { displayName, recoveryNeeded, resolveScan, stagingOccupancy, suggestSlots, toStageTotes, type LiveTote, type OpsState, type StoreStatic } from '@storewright/ops';
import { feedback } from '../feedback';
import { duration, t } from '../i18n';
import { useLive, useNow } from '../live';
import { zone } from '../rejects';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { ZoneChip } from '../ui/ZoneChip';
import { SopTip } from '../ui/SopTip';

/** 暂存：扫描框标签 → 自选格位（系统建议作参考）→ 扫描格位标签确认（决策 S-02） */
export function StageScreen() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic | undefined;
  const [toteId, setToteId] = useState<string | undefined>();
  const [recovery, setRecovery] = useState<string | undefined>();
  // 要移到回收专区、等扫回收专区标签的框（门店要求扫码时，决策记录 0026）
  const [toRecover, setToRecover] = useState<string | undefined>();
  // 每 5 秒刷新一次：冷链倒计时（hook 放在提前返回之前）
  const now = useNow(5000);
  if (!st) return null;
  // 门店要求扫码（决策记录 0026）：格位只能扫，不能点
  const strict = !!s.settings?.requireScan;
  const tote = toteId ? s.totes[toteId] : undefined;
  const order = tote ? s.orders[tote.orderId] : undefined;
  // 拣完的框，和取出后要放回暂存区的框；不含自动运营的订单
  const waiting = toStageTotes(s);
  const suggestions = tote && tote.status !== 'RECOVERY' ? suggestSlots(s, st, tote.id, 4, now) : [];
  // 按到店时间放格位（决策记录 0023 · B5）
  const arriveAt = order ? (order.arrivedAt ?? order.aiEtaAt ?? order.etaAt ?? order.slotStart) : undefined;
  const soon = arriveAt !== undefined && arriveAt - now <= 30 * 60_000;
  const late = arriveAt !== undefined && arriveAt - now >= 90 * 60_000;

  const stage = async (slotCode: string, tap?: boolean) => {
    if (!tote?.labelId) return;
    const before = s.totes[tote.id]?.status;
    const ok = await run({ type: 'StageTote', labelId: tote.labelId, slotCode, ...(tap ? { tap: true } : {}) });
    if (!ok) return;
    const after = client.state.totes[tote.id];
    if (after?.status === 'RECOVERY' && before !== 'RECOVERY') {
      setRecovery(after.tempZone);
      feedback('error');
    } else toast(t('已放进 {0}', slotCode), 'ok', 1800);
    setToteId(undefined);
  };

  const recover = async (x: LiveTote, area?: string) => {
    if (!x.labelId) return;
    if (await run({ type: 'RecoverTote', labelId: x.labelId, ...(area ? { area } : { tap: true }) })) {
      toast(t('已移到回收专区'), 'ok', 1800);
      setToRecover(undefined);
      setRecovery(undefined);
    }
  };

  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'label') {
      if (r.voided) return toast(t('这个标签已作废，请用新标签'), 'error');
      setRecovery(undefined);
      const t0 = s.totes[r.toteId];
      if (s.orders[r.orderId]?.status === 'CANCELLED' && t0?.labelId) {
        // 订单已取消：提示放回收专区；门店要求扫码时再扫一下回收专区的标签（决策记录 0026）
        setToteId(r.toteId);
        if (strict && t0.status !== 'RECOVERY') {
          setToRecover(t0.id);
          setRecovery(t0.tempZone);
          feedback('error');
          return;
        }
        void run({ type: 'StageTote', labelId: t0.labelId, slotCode: '-' }).then((ok) => ok && setRecovery(t0.tempZone));
        return;
      }
      // 还没拣完、正在交付准备的框（决策记录 0026：以前要到放格位时才提示）
      const busy = t0 ? notStageable(s, t0) : undefined;
      if (busy) {
        feedback('error');
        return toast(busy, 'error');
      }
      setToteId(r.toteId);
      return;
    }
    if (r.kind === 'recovery') {
      const x = toRecover ? s.totes[toRecover] : undefined;
      if (!x) return toast(t('先扫要移到回收专区的框'), 'error');
      void recover(x, r.code);
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
      {/* 暂存快满（决策记录 0024 · D4） */}
      <SopTip sopId="staging-full" when={stagingOccupancy(s, st).some((z) => z.alert)} />
      {recovery && (
        <p className="banner error big" role="alert">
          {toRecover ? t('订单已取消：把这个框放进{0}回收专区，再扫一下回收专区的标签', zone(recovery)) : t('订单已取消：把这个框放进{0}回收专区', zone(recovery))}
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
              <h4>{strict ? t('建议格位（扫格位标签放进去）') : t('建议格位（可以自选其他格位）')}</h4>
              {soon && <p className="note">{t('顾客半小时内到：建议放离交付点近的格位')}</p>}
              {late && <p className="note">{t('顾客一个半小时以后才到：放远一点，把近的格位留给快到的顾客')}</p>}
              <div className="chips">
                {suggestions.map((c) => (
                  <button key={c} className="chip mono" disabled={strict} onClick={() => void stage(c, true)}>
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
                <button className={`row-btn${x.id === toteId ? ' selected' : ''}`} disabled={strict} onClick={() => setToteId(x.id)}>
                  <ZoneChip z={x.tempZone} />
                  <span className="mono">{o?.shortCode}</span>
                  <span>{t('框 {0}/{1}', x.index, x.count)}</span>
                  <span className="muted">{o ? displayName(o.firstName, o.lastName) : ''}</span>
                  {x.status === 'PULLED' && <span className="tag">{t('待放回')}</span>}
                  <ColdLeft s={s} tote={x} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <Recovery
        strict={strict}
        onPick={(x) => {
          setToteId(x.id);
          if (strict) {
            // 门店要求扫码：去回收专区扫标签
            setToRecover(x.id);
            setRecovery(x.tempZone);
          } else void recover(x);
        }}
      />
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

/** 还不能暂存的框：没拣完、正在交付准备里 */
function notStageable(s: OpsState, x: LiveTote): string | undefined {
  if (x.status === 'PLANNED' || x.status === 'IN_WALK' || x.status === 'BOUND') {
    const w = x.walkId ? s.walks[x.walkId] : undefined;
    return w && w.status !== 'OPEN' ? t('这个框还没拣完（批次 {0} 正在拣），拣完再暂存', w.id) : t('这个框还没拣完，拣完再暂存');
  }
  if (x.status === 'PULLED' && Object.values(s.sessions).some((ss) => ss.status !== 'COMPLETED' && ss.scanned.includes(x.id))) return t('这个框正在交付准备里');
  return undefined;
}

/** 冷链框还剩多少时间放进暂存（决策记录 0026：计时到放进暂存为止） */
function ColdLeft({ s, tote }: { s: OpsState; tote: LiveTote }) {
  const w = tote.walkId ? s.walks[tote.walkId] : undefined;
  if (!w || w.coldStartedAt === undefined || w.coldLimitSec === undefined || tote.status !== 'PICKED') return null;
  const left = w.coldLimitSec - (Date.now() - w.coldStartedAt) / 1000;
  return <span className={`tag${left < 300 ? ' warn-tag' : ''}`}>{left > 0 ? t('冷链 {0}', duration(left)) : t('冷链已超时')}</span>;
}

/** 订单已取消的框：移到回收专区（门店要求扫码时扫回收专区的标签） */
function Recovery({ strict, onPick }: { strict: boolean; onPick: (x: LiveTote) => void }) {
  const { client } = useLive();
  const list = recoveryNeeded(client.state);
  if (!list.length) return null;
  return (
    <section>
      <h2 className="section-title warn-text">{t('需要移到回收专区（{0}）', list.length)}</h2>
      <ul className="tote-list">
        {list.map((x) => (
          <li key={x.id}>
            <button className="row-btn" onClick={() => onPick(x)} title={strict ? t('移过去后扫回收专区的标签') : t('移过去后点一下')}>
              <ZoneChip z={x.tempZone} />
              <span className="mono">{x.status === 'PULLED' ? t('已取出') : x.slotCode}</span>
              <span>{t('订单 {0}', client.state.orders[x.orderId]?.shortCode ?? '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
