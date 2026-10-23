import { useMemo, useState } from 'react';
import { activeWalkOf, openWalks, pickRows, resolveScan, sellableCases, walkRemaining, type LiveWalk, type PickRow } from '@storewright/ops';
import { labelUrl, substitutes, type SubstituteSuggestion } from '../api';
import { feedback } from '../feedback';
import { clock, duration, t } from '../i18n';
import { useLive, useNow } from '../live';
import { gtinTail, locationParts, locationText } from '../format';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { ZoneChip } from '../ui/ZoneChip';

/** 拣货：领取批次 → 扫描绑定框 → 按路线顺序逐行拣货 → 送到暂存区 */
export function PickScreen({ onDone }: { onDone: () => void }) {
  const { client, auth } = useLive();
  const walk = activeWalkOf(client.state, auth.actor);
  return walk ? <WalkView walk={walk} onDone={onDone} /> : <WalkList />;
}

function WalkList() {
  const { client, run } = useLive();
  const now = useNow(15_000);
  // 自动运营的批次由虚拟员工处理，不在员工手机上显示
  const walks = openWalks(client.state).filter((w) => w.track !== 'AUTO');
  if (!walks.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('暂时没有可以领取的拣货批次')}</p>
        <p>{t('新的批次生成后会自动出现在这里。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <h2 className="section-title">{t('可以领取的批次（{0}）', walks.length)}</h2>
      {walks.map((w) => {
        const rows = pickRows(client.state, w).filter((r) => !r.cancelled);
        const late = w.dueAt < now + w.estimatedSec * 1000;
        return (
          <article key={w.id} className="card walk-card">
            <div className="card-head">
              <ZoneChip z={w.tempZone} />
              <span className="mono strong">{w.id}</span>
              <span className={`due${late ? ' late' : ''}`}>{t('截止 {0}', clock(w.dueAt))}</span>
            </div>
            <div className="facts">
              <span>{t('{0} 个框', w.toteIds.length)}</span>
              <span>{t('{0} 个货位', w.stops.length)}</span>
              <span>{t('{0} 件', rows.reduce((n, r) => n + r.qty, 0))}</span>
              <span>{t('约 {0} 分钟', Math.max(1, Math.round(w.estimatedSec / 60)))}</span>
              <span>{t('{0} 米', Math.round(w.distanceM))}</span>
            </div>
            {w.coldLimitSec !== undefined && <p className="note">{t('冷链时限 {0} 分钟：从第一件冷藏 / 冷冻商品放进框开始计时', Math.round(w.coldLimitSec / 60))}</p>}
            <button className="primary block" onClick={() => void run({ type: 'ClaimWalk', walkId: w.id })}>
              {t('领取这个批次')}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function WalkView({ walk, onDone }: { walk: LiveWalk; onDone: () => void }) {
  const { client, auth, run } = useLive();
  const s = client.state;
  const now = useNow(1000);
  const rows = useMemo(() => pickRows(s, walk).filter((r) => !r.cancelled), [s, walk, client.version]);
  const totes = walk.toteIds.map((id) => s.totes[id]).filter((x) => !!x && s.orders[x.orderId]?.status !== 'CANCELLED');
  const unbound = totes.filter((x) => x && !walk.bound.includes(x.id));
  const remaining = walkRemaining(s, walk);
  const doneUnits = rows.reduce((n, r) => n + r.done, 0);
  const totalUnits = rows.reduce((n, r) => n + r.qty, 0);
  const current = rows.find((r) => r.done < r.qty);
  const [missing, setMissing] = useState<PickRow | null>(null);
  const [qtyFor, setQtyFor] = useState<PickRow | null>(null);

  const cold = walk.coldStartedAt !== undefined && walk.coldLimitSec !== undefined ? walk.coldLimitSec - (now - walk.coldStartedAt) / 1000 : undefined;

  const onScan = (raw: string) => {
    if (!client.statics) return;
    const r = resolveScan(s, client.statics, raw);
    if (r.kind === 'label') {
      if (r.voided) return toast(t('这个标签已作废，请用新标签'), 'error');
      if (!walk.toteIds.includes(r.toteId)) return toast(t('这个框不在当前批次里'), 'error');
      if (walk.bound.includes(r.toteId)) return toast(t('这个框已经扫过了'), 'info');
      void run({ type: 'BindLabel', walkId: walk.id, labelId: r.labelId });
      return;
    }
    if (r.kind === 'item' && current) {
      if (r.gtin !== current.gtin) {
        feedback('error');
        return toast(t('不是这件商品：请找 {0}', current.name), 'error');
      }
      // 多件同品：扫描一次后输入数量（决策 P-07）
      if (current.qty - current.done > 1) return setQtyFor(current);
      void run({ type: 'PickItem', walkId: walk.id, toteId: current.toteId, lineId: current.lineId, qty: 1 });
      return;
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };

  return (
    <div className="walk">
      <header className="walk-head">
        <ZoneChip z={walk.tempZone} big />
        <div>
          <div className="mono strong">{walk.id}</div>
          <div className="muted">{t('截止 {0} · 已拣 {1} / {2} 件', clock(walk.dueAt), doneUnits, totalUnits)}</div>
        </div>
        {cold !== undefined && (
          <div className={`cold${cold < 300 || walk.coldAlerted ? ' alert' : ''}`} role="timer">
            <span>{t('冷链')}</span>
            <b className="mono">{cold > 0 ? duration(cold) : t('已超时')}</b>
          </div>
        )}
      </header>
      <div className="progress" aria-hidden>
        <i style={{ width: `${totalUnits ? (doneUnits / totalUnits) * 100 : 0}%` }} />
      </div>
      {walk.coldAlerted && <p className="banner error">{t('冷链超时：请立即把冷藏 / 冷冻框送回暂存区')}</p>}

      {unbound.length > 0 ? (
        <section className="phase">
          <h2 className="section-title">{t('第 1 步：给框贴标签并扫描（{0} / {1}）', totes.length - unbound.length, totes.length)}</h2>
          <ScanBox label={t('扫描框上的标签')} onScan={onScan} />
          <ul className="tote-list">
            {totes.map((x) => {
              if (!x) return null;
              const o = s.orders[x.orderId];
              const bound = walk.bound.includes(x.id);
              return (
                <li key={x.id} className={bound ? 'done' : ''}>
                  <button className="row-btn" disabled={bound} onClick={() => x.labelId && void run({ type: 'BindLabel', walkId: walk.id, labelId: x.labelId })}>
                    <span className="check">{bound ? '✓' : ''}</span>
                    <span className="mono">{x.labelId?.replace('SW1:', '')}</span>
                    <span>{t('订单 {0}', o?.shortCode ?? '')}</span>
                    <span>{t('框 {0}/{1}', x.index, x.count)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="note">
            {t('没有扫码枪时，点一下框也可以绑定（演示用）。')}{' '}
            <a href={labelUrl(auth, `walk/${walk.id}`)} target="_blank" rel="noreferrer">
              {t('打印本批标签')}
            </a>
          </p>
        </section>
      ) : current ? (
        <section className="phase">
          <PickCard row={current} total={rows.length} index={rows.indexOf(current)} />
          <ScanBox label={t('扫描商品条码')} hint={t('条码尾号 {0}', gtinTail(current.gtin))} onScan={onScan} />
          <div className="actions">
            <button className="primary" onClick={() => void run({ type: 'PickItem', walkId: walk.id, toteId: current.toteId, lineId: current.lineId, qty: current.qty - current.done })}>
              {t('已拣到 {0} 件', current.qty - current.done)}
            </button>
            <button className="warn" onClick={() => setMissing(current)}>
              {t('找不到')}
            </button>
          </div>
          <UpNext rows={rows.filter((r) => r.done < r.qty && r !== current).slice(0, 4)} />
        </section>
      ) : (
        <section className="phase center">
          <p className="big-ok">✓</p>
          <h2>{t('这一车拣完了')}</h2>
          <p>{t('把推车送到暂存区，逐框扫描放进格位。')}</p>
          <button
            className="primary block"
            disabled={remaining > 0}
            onClick={async () => {
              if (await run({ type: 'CompleteWalk', walkId: walk.id })) onDone();
            }}
          >
            {t('完成拣货，去暂存')}
          </button>
        </section>
      )}

      {walk.status === 'CLAIMED' && (
        <button className="link danger" onClick={() => void run({ type: 'UnclaimWalk', walkId: walk.id })}>
          {t('放弃这个批次')}
        </button>
      )}
      {missing && <NotFoundSheet walk={walk} row={missing} onClose={() => setMissing(null)} />}
      {qtyFor && <QtySheet row={qtyFor} onClose={() => setQtyFor(null)} onConfirm={(q) => void run({ type: 'PickItem', walkId: walk.id, toteId: qtyFor.toteId, lineId: qtyFor.lineId, qty: q }).then(() => setQtyFor(null))} />}
    </div>
  );
}

function PickCard({ row, index, total }: { row: PickRow; index: number; total: number }) {
  const p = locationParts(row.locationId);
  return (
    <article className="pick-card" aria-live="polite">
      <div className="pick-step muted">{t('第 {0} / {1} 行', index + 1, total)}</div>
      <div className="loc">
        <div>
          <small>{t('通道')}</small>
          <b>{p.aisle}</b>
        </div>
        <div>
          <small>{p.side}</small>
          <b>{p.bay}</b>
        </div>
        <div>
          <small>{t('层')}</small>
          <b>{p.level}</b>
        </div>
      </div>
      <h3 className="item-name">{row.name}</h3>
      <div className="pick-meta">
        <span className="qty">
          ×<b>{row.qty - row.done}</b>
        </span>
        <span>
          {t('放进框 {0}/{1}', row.toteIndex, row.toteCount)} · {t('订单 {0}', row.orderShortCode)}
        </span>
      </div>
      <div className="tags">
        {row.ageRestricted && <span className="tag">21+</span>}
        {!row.allowSubstitution && <span className="tag">{t('不允许替代')}</span>}
        {row.done > 0 && <span className="tag ok">{t('已拣 {0}', row.done)}</span>}
      </div>
    </article>
  );
}

function UpNext({ rows }: { rows: PickRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="upnext">
      <h4>{t('接下来')}</h4>
      <ol>
        {rows.map((r) => (
          <li key={`${r.toteId}|${r.lineId}`}>
            <span className="mono">{locationText(r.locationId)}</span>
            <span>
              {r.name} ×{r.qty - r.done}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function QtySheet({ row, onClose, onConfirm }: { row: PickRow; onClose: () => void; onConfirm: (q: number) => void }) {
  const max = row.qty - row.done;
  const [q, setQ] = useState(max);
  return (
    <div className="sheet" role="dialog" aria-label={t('数量')}>
      <div className="sheet-body">
        <h3>{row.name}</h3>
        <p>{t('还需要 {0} 件，这次放进框里几件？', max)}</p>
        <div className="stepper">
          <button onClick={() => setQ((x) => Math.max(1, x - 1))}>−</button>
          <b className="mono">{q}</b>
          <button onClick={() => setQ((x) => Math.min(max, x + 1))}>+</button>
        </div>
        <div className="actions">
          <button onClick={onClose}>{t('取消')}</button>
          <button className="primary" onClick={() => onConfirm(q)}>
            {t('确认')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 找不到：替代（推荐附近同类商品）/ 转后仓补取 / 标记缺货（工作流设计 4.4、4.5 节） */
function NotFoundSheet({ walk, row, onClose }: { walk: LiveWalk; row: PickRow; onClose: () => void }) {
  const { auth, run, client } = useLive();
  // 只有库存记录显示后仓有货时才能转后仓补取（决策 P-08）
  const backroom = client.state.suspect[row.itemId] === undefined ? sellableCases(client.state, row.itemId).length : 0;
  const [subs, setSubs] = useState<SubstituteSuggestion[] | null>(null);
  const [subModel, setSubModel] = useState<string | undefined>();
  const qty = row.qty - row.done;
  const base = { walkId: walk.id, toteId: row.toteId, lineId: row.lineId, qty } as const;
  const finish = async (ok: Promise<boolean>) => {
    if (await ok) onClose();
  };
  return (
    <div className="sheet" role="dialog" aria-label={t('找不到')}>
      <div className="sheet-body">
        <h3>{t('找不到：{0}', row.name)}</h3>
        <p className="muted">{t('缺 {0} 件。按顾客下单时的偏好处理，不等待顾客回复。', qty)}</p>
        {row.allowSubstitution ? (
          subs === null ? (
            <button
              className="block"
              onClick={() =>
                void substitutes(auth, row.itemId).then((r) => {
                  setSubs(r.items);
                  setSubModel(r.model);
                })
              }
            >
              {t('查看替代商品')}
            </button>
          ) : subs.length ? (
            <ul className="subs">
              {subs.map((x, i) => (
                <li key={x.itemId}>
                  <button
                    className={`row-btn${subModel && i === 0 ? ' ai-top' : ''}`}
                    onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED', substitute: { name: x.name, gtin: x.gtin, ...(subModel ? { rank: i + 1, model: subModel } : {}) } }))}
                  >
                    <span>
                      {subModel && i === 0 && <span className="tag ok">{t('AI 推荐')}</span>}
                      {x.name}
                      {x.p !== undefined && <small className="sub-why">{[t('预计顾客接受 {0}%', Math.round(x.p * 100)), ...(x.reasons ?? []).map(subReason)].join(' · ')}</small>}
                    </span>
                    <span className="mono">${x.unitPrice.toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">{t('附近没有合适的替代商品')}</p>
          )
        ) : (
          <p className="note">{t('顾客不允许替代这件商品')}</p>
        )}
        <button className="block" disabled={!backroom} onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'EXCEPTION' }))}>
          {backroom ? t('后仓有 {0} 箱：转后仓补取', backroom) : t('库存记录显示后仓没有')}
        </button>
        <button className="block warn" onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'SHORT' }))}>
          {t('标记缺货')}
        </button>
        <button className="link" onClick={onClose}>
          {t('取消')}
        </button>
      </div>
    </div>
  );
}

/** 替代推荐的理由（AI 排序时） */
function subReason(r: { factor: string; value?: number }): string {
  switch (r.factor) {
    case 'SAME_STEM':
      return t('同一种商品');
    case 'SAME_BRAND':
      return t('同品牌');
    case 'SAME_FLAVOR':
      return t('口味相同');
    case 'FLAVOR_CHANGE':
      return t('口味不同');
    case 'SAME_SIZE':
      return t('规格相同');
    case 'SIZE_CHANGE':
      return t('规格不同');
    case 'ORGANIC_DOWNGRADE':
      return t('不是有机');
    case 'PRICE_UP':
      return t('贵 {0}%', r.value ?? 0);
    case 'PRICE_DOWN':
      return t('便宜 {0}%', Math.abs(r.value ?? 0));
    default:
      return r.factor;
  }
}
