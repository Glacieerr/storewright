import { useState } from 'react';
import { batchLoad, planogramByItem, replBatches, resolveScan, sellableCases, shelfNow, usableCases, type ReplTask, type StoreStatic } from '@storewright/ops';
import { feedback } from '../../feedback';
import { clock, duration, t } from '../../i18n';
import { useLive } from '../../live';
import { useIntent, useSessionState } from '../../nav';
import { QtyInput } from '../../ui/QtyInput';
import { locationParts } from '../../format';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';
import { ShelfCheckFlow, ShelfCheckList } from './ShelfCheckView';

const REASON_TEXT: Record<ReplTask['reason'], string> = { EXCEPTION: '后仓补取后', EMPTY: '货架空了', LOW: '库存偏低', MANUAL: '手动请求', SENSOR: '传感器', PREPICK: '拣货前补上', RISK: '可能断货' };

/** 补货的依据（决策记录 0021 · C2）：接下来几小时线上要几件、货架估计几件、断货概率；拣货前补货写着截止时间 */
export function replWhyText(x: ReplTask): string | undefined {
  const parts: string[] = [];
  if (x.reason === 'PREPICK' || x.dueAt !== undefined) parts.push(t('拣货员约 {0} 走到，之前补上', clock(x.dueAt ?? 0)));
  const w = x.why;
  if (w && (w.online >= 1 || (x.risk ?? 0) >= 0.3)) {
    parts.push(
      w.ordered > 0
        ? t('接下来 {0} 小时线上要 {1} 件（已下单 {2} 单 {3} 件），货架估计 {4} 件', w.horizonH, Math.round(w.online), w.orders, w.ordered, Math.round(w.est))
        : t('接下来 {0} 小时线上约要 {1} 件，货架估计 {2} 件', w.horizonH, Math.round(w.online), Math.round(w.est)),
    );
  }
  if (x.risk !== undefined && x.risk >= 0.3) parts.push(t('断货概率 {0}%', Math.round(x.risk * 100)));
  return parts.length ? parts.join(' · ') : undefined;
}

/** 补货：领取一批（同一通道）→ 后仓扫描箱子 → 扫描货位 → 输入上架件数（决策 R-05、P-06） */
export function ReplenishView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const [checkId, setCheckId] = useState<string | undefined>();
  // 提醒、「下一步」直接打开某个核对任务（决策记录 0026）
  useIntent('checkId', setCheckId);
  const check = checkId ? s.checks[checkId] : undefined;
  if (check && check.status === 'OPEN') return <ShelfCheckFlow check={check} onDone={() => setCheckId(undefined)} />;
  const mine = Object.values(s.repl)
    .filter((x) => x.status === 'CLAIMED' && x.associateId === auth.actor)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  // 手上有补货任务时，核对货架的任务也列在下面（流程梳理发现，决策记录 0025：以前点提醒过来看不到）
  if (mine.length)
    return (
      <>
        <BatchView tasks={mine} />
        <div className="list">
          <ShelfCheckList onOpen={setCheckId} />
        </div>
      </>
    );
  // 按推车的装载上限分批（决策记录 0026）：一批的箱子加起来不超过推车的重量和体积
  const batches = replBatches(s, st);
  const byItem = planogramByItem(st);
  const hasChecks = Object.values(s.checks).some((c) => c.status === 'OPEN');
  if (!batches.length && !hasChecks) {
    return (
      <div className="empty">
        <p className="empty-title">{t('暂时没有补货任务')}</p>
        <p>{t('货架存量低于阈值、后仓有货时会自动生成任务。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <ShelfCheckList onOpen={setCheckId} />
      {batches.length > 0 && <h2 className="section-title">{t('补货批次（{0}）', batches.length)}</h2>}
      {batches.map((b) => {
        const first = b[0] as ReplTask;
        const load = batchLoad(st, b);
        return (
          <article key={first.id} className="card">
            <div className="card-head">
              <span className="strong">{t('{0} 通道', locationParts(first.locationId).aisle)}</span>
              <span className="muted">{t('{0} 个任务', b.length)}</span>
              <span className={`due${first.priority <= 30 ? ' late' : ''}`}>{first.dueAt !== undefined ? t('{0} 前', clock(first.dueAt)) : first.priority === 0 ? t('已空') : t('约 {0} 后卖完', duration(first.priority * 60))}</span>
            </div>
            <p className="note">{t('约 {0} 千克 · {1} 升（推车上限 {2} 千克 / {3} 升）', load.kg, load.liters, load.cartKg, load.cartL)}</p>
            <ul className="plain">
              {b.map((x) => {
                const why = replWhyText(x);
                return (
                  <li key={x.id}>
                    {byItem.get(x.itemId)?.name ?? x.itemId} · ×{x.suggestedUnits} <span className={`tag${x.reason === 'PREPICK' || x.reason === 'RISK' ? ' warn-tag' : ''}`}>{t(REASON_TEXT[x.reason])}</span>
                    {why && <small className="repl-why">{why}</small>}
                  </li>
                );
              })}
            </ul>
            <button className="primary block" onClick={() => void run({ type: 'ClaimReplenishment', taskIds: b.map((x) => x.id) })}>
              {t('领取这一批')}
            </button>
          </article>
        );
      })}
    </div>
  );
}

/**
 * 一批补货（决策记录 0026）：先在后仓把整批的箱子取齐（扫到哪个商品的箱子就记到哪个任务上），再按货位顺序逐个上架；
 * 做到哪一步记在这台手机上，切到别的页面再回来还在。箱里剩下的放回原库位后点一下。
 */
function BatchView({ tasks }: { tasks: ReplTask[] }) {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const strict = !!s.settings?.requireScan;
  const plan = planogramByItem(st);
  type Step = { caseId?: string; at?: string; units?: number };
  const [prog, setProg] = useSessionState<Record<string, Step>>('repl-batch', {});
  const [putBack, setPutBack] = useSessionState<Array<{ caseId: string; bin: string; units: number }>>('repl-putback', []);
  const step = (id: string): Step => prog[id] ?? {};
  const patch = (id: string, p: Step) => setProg((m) => ({ ...m, [id]: { ...(m[id] ?? {}), ...p } }));
  // 按货位顺序：取箱按后仓库位、上架按货架货位
  const route = [...tasks].sort((a, b) => a.locationId.localeCompare(b.locationId) || a.id.localeCompare(b.id));
  const caseOf = (x: ReplTask) => {
    const id = step(x.id).caseId;
    const c = id ? s.cases[id] : undefined;
    return c && c.itemId === x.itemId && c.units > 0 ? c : undefined;
  };
  // 补取时已经拿在手上的那一箱优先（决策记录 0026）
  const suggested = (x: ReplTask) => (x.fromCaseId && usableCases(s, x.itemId).find((c) => c.id === x.fromCaseId)) || usableCases(s, x.itemId)[0] || sellableCases(s, x.itemId)[0];
  const picked = route.filter((x) => caseOf(x)).length;
  const [currentId, setCurrentId] = useState<string | undefined>();
  const current = route.find((x) => x.id === currentId && caseOf(x)) ?? route.find((x) => caseOf(x));

  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'case') {
      // 记到这个商品还没取箱的任务上
      const target = route.find((x) => x.itemId === r.itemId && !caseOf(x));
      if (!target) {
        feedback('error');
        return toast(route.some((x) => x.itemId === r.itemId) ? t('这个商品的箱子已经取过了') : t('不是这一批要补的商品'), 'error');
      }
      feedback('ok');
      patch(target.id, { caseId: r.caseId });
      const left = route.filter((x) => x.id !== target.id && !caseOf(x)).length;
      return toast(left ? t('已取箱：{0}（还差 {1} 箱）', plan.get(target.itemId)?.name ?? target.itemId, left) : t('整批的箱子取齐了：按货位顺序去上架'), 'ok', 2000);
    }
    if (r.kind === 'location') {
      const target = route.find((x) => x.locationId === r.locationId && caseOf(x));
      if (!target) {
        feedback('error');
        return toast(route.some((x) => x.locationId === r.locationId) ? t('这个货位的箱子还没取') : t('货位不对：应该是 {0}', current?.locationId ?? ''), 'error');
      }
      feedback('ok');
      setCurrentId(target.id);
      patch(target.id, { at: r.locationId });
      return;
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };

  const complete = async (x: ReplTask) => {
    const kase = caseOf(x);
    if (!kase) return;
    const p = plan.get(x.itemId);
    const est = p ? Math.round(shelfNow(s, p).est) : 0;
    const room = p ? Math.max(1, p.capacity - est) : x.suggestedUnits;
    const units = step(x.id).units ?? Math.min(kase.units, room);
    const at = step(x.id).at;
    const ok = await run({ type: 'CompleteReplenishment', taskId: x.id, caseId: kase.id, locationId: at && at !== '*' ? at : x.locationId, units, ...(at && at !== '*' ? {} : { tap: true }) });
    if (!ok) return;
    const left = kase.units - units;
    if (left > 0 && kase.binCode) setPutBack((l) => [...l, { caseId: kase.id, bin: kase.binCode as string, units: left }]);
    toast(left > 0 ? t('完成。箱里还剩 {0} 件，放回 {1}', left, kase.binCode ?? '') : t('完成'), 'ok');
    setProg((m) => {
      const n = { ...m };
      delete n[x.id];
      return n;
    });
  };

  const cur = current;
  const curPlan = cur ? plan.get(cur.itemId) : undefined;
  const curCase = cur ? caseOf(cur) : undefined;
  const est = curPlan ? Math.round(shelfNow(s, curPlan).est) : 0;
  const room = curPlan ? Math.max(1, curPlan.capacity - est) : (cur?.suggestedUnits ?? 1);
  const loc = cur ? locationParts(cur.locationId) : undefined;
  const at = cur ? step(cur.id).at : undefined;

  return (
    <div className="walk">
      {putBack.length > 0 && (
        <section className="card putback">
          {putBack.map((b, i) => (
            <p key={`${b.caseId}-${i}`} className="row-line">
              <span>{t('把箱子 {0} 放回库位 {1}（还剩 {2} 件）', b.caseId, b.bin, b.units)}</span>
              <button className="chip" onClick={() => setPutBack((l) => l.filter((_, k) => k !== i))}>
                {t('已放回')}
              </button>
            </p>
          ))}
        </section>
      )}
      <ScanBox label={t('扫描箱子或货位标签')} onScan={onScan} />
      <section className="phase">
        <h3 className="section-title">{t('取箱清单：已取 {0} / {1} 箱', picked, route.length)}</h3>
        <ul className="tote-list batch-cases">
          {route.map((x) => {
            const p = plan.get(x.itemId);
            const kase = caseOf(x);
            const sug = suggested(x);
            return (
              <li key={x.id} className={kase ? 'done' : ''}>
                <button className="row-btn" disabled={!!kase || strict || !sug} onClick={() => sug && patch(x.id, { caseId: sug.id })}>
                  <span className="check">{kase ? '✓' : ''}</span>
                  <span className="mono strong">{kase ? kase.id : (sug?.binCode ?? '—')}</span>
                  <span>{p?.name ?? x.itemId}</span>
                  <span className="muted">{t(REASON_TEXT[x.reason])}</span>
                </button>
                {!kase && (
                  <span className="row-actions">
                    {sug ? (
                      <button className="link" onClick={() => void run({ type: 'CancelReplenishment', taskId: x.id, ...(sug.binCode ? { binCode: sug.binCode } : {}) })}>
                        {t('{0} 找不到', sug.binCode ?? t('后仓'))}
                      </button>
                    ) : (
                      <span className="warn-text">{t('记录里后仓没有能用的箱子了')}</span>
                    )}
                    <button className="link" onClick={() => void run({ type: 'ReleaseReplenishment', taskIds: [x.id] })}>
                      {t('放回队列')}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {!strict && <p className="note">{t('没有扫码枪时，点一下这一行就算取到建议的那一箱（演示用）。')}</p>}
      </section>
      {cur && curCase && loc && (
        <section className="phase">
          <h3 className="section-title">{at ? t('✓ 已到货位 {0}', cur.locationId) : t('上架：{0}，到货位 {1} 通道 · {2} {3} 号 · 第 {4} 层，扫描货位标签', curPlan?.name ?? cur.itemId, loc.aisle, loc.side, loc.bay, loc.level)}</h3>
          {!at && !strict && (
            <button className="link" onClick={() => patch(cur.id, { at: '*' })}>
              {t('没有货位标签？手动确认已到货位（演示）')}
            </button>
          )}
          {at && (
            <div className="card">
              <p>{t('上架件数（货架约 {0} / {1} 件，还能放 {2} 件；箱里 {3} 件）', est, curPlan?.capacity ?? '?', room, curCase.units)}</p>
              <QtyInput value={step(cur.id).units ?? Math.min(curCase.units, room)} onChange={(v) => patch(cur.id, { units: v })} min={1} max={curCase.units} label={t('上架件数')} />
              <button className="primary block" onClick={() => void complete(cur)}>
                {t('完成上架')}
              </button>
            </div>
          )}
        </section>
      )}
      <div className="actions">
        <button onClick={() => void run({ type: 'ReleaseReplenishment', taskIds: route.map((x) => x.id) })}>{t('整批放回队列')}</button>
      </div>
    </div>
  );
}
