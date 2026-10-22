import { useState } from 'react';
import { planogramByItem, replBatches, resolveScan, sellableCases, shelfNow, type LiveCase, type ReplTask, type StoreStatic } from '@storewright/ops';
import { feedback } from '../../feedback';
import { duration, t } from '../../i18n';
import { useLive } from '../../live';
import { locationParts } from '../../format';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';
import { ShelfCheckFlow, ShelfCheckList } from './ShelfCheckView';

const REASON_TEXT: Record<ReplTask['reason'], string> = { EXCEPTION: '后仓补取后', EMPTY: '货架空了', LOW: '库存偏低', MANUAL: '手动请求', SENSOR: '传感器' };

/** 补货：领取一批（同一通道）→ 后仓扫描箱子 → 扫描货位 → 输入上架件数（决策 R-05、P-06） */
export function ReplenishView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const [checkId, setCheckId] = useState<string | undefined>();
  const check = checkId ? s.checks[checkId] : undefined;
  if (check && check.status === 'OPEN') return <ShelfCheckFlow check={check} onDone={() => setCheckId(undefined)} />;
  const mine = Object.values(s.repl)
    .filter((x) => x.status === 'CLAIMED' && x.associateId === auth.actor)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (mine.length) return <TaskView task={mine[0] as ReplTask} remaining={mine.length} />;
  const batches = replBatches(s);
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
        return (
          <article key={first.id} className="card">
            <div className="card-head">
              <span className="strong">{t('{0} 通道', locationParts(first.locationId).aisle)}</span>
              <span className="muted">{t('{0} 个任务', b.length)}</span>
              <span className={`due${first.priority <= 30 ? ' late' : ''}`}>{first.priority === 0 ? t('已空') : t('约 {0} 后卖完', duration(first.priority * 60))}</span>
            </div>
            <ul className="plain">
              {b.slice(0, 4).map((x) => (
                <li key={x.id}>
                  {byItem.get(x.itemId)?.name ?? x.itemId} · ×{x.suggestedUnits} <span className="tag">{t(REASON_TEXT[x.reason])}</span>
                </li>
              ))}
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

function TaskView({ task, remaining }: { task: ReplTask; remaining: number }) {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const p = planogramByItem(st).get(task.itemId);
  const [caseId, setCaseId] = useState<string | undefined>();
  const [atShelf, setAtShelf] = useState(false);
  const cases = sellableCases(s, task.itemId);
  const kase: LiveCase | undefined = caseId ? s.cases[caseId] : undefined;
  const est = p ? Math.round(shelfNow(s, p).est) : 0;
  const room = p ? Math.max(1, p.capacity - est) : task.suggestedUnits;
  const [units, setUnits] = useState<number | undefined>();
  const want = Math.min(kase?.units ?? task.suggestedUnits, room);
  const loc = locationParts(task.locationId);

  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'case') {
      if (r.itemId !== task.itemId) {
        feedback('error');
        return toast(t('不是这个商品的箱子'), 'error');
      }
      feedback('ok');
      return setCaseId(r.caseId);
    }
    if (r.kind === 'location') {
      if (r.locationId !== task.locationId) {
        feedback('error');
        return toast(t('货位不对：应该是 {0}', task.locationId), 'error');
      }
      feedback('ok');
      return setAtShelf(true);
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };

  return (
    <div className="walk">
      <header className="walk-head">
        {p && <ZoneChip z={p.tempZone} big />}
        <div>
          <div className="strong">{p?.name ?? task.itemId}</div>
          <div className="muted">
            {t('货架约 {0} / {1} 件', est, p?.capacity ?? '?')} · {t(REASON_TEXT[task.reason])} · {t('本批还有 {0} 个', remaining)}
          </div>
        </div>
      </header>
      <section className="phase">
        <h3 className="section-title">{kase ? t('✓ 已取箱 {0}（{1} 件）', kase.id, kase.units) : t('第 1 步：到后仓取一箱')}</h3>
        {!kase && (
          <ul className="tote-list">
            {cases.map((c) => (
              <li key={c.id}>
                <button className="row-btn" onClick={() => setCaseId(c.id)}>
                  <span className="mono strong">{c.binCode}</span>
                  <span className="mono">{c.id}</span>
                  <span>{t('{0} 件', c.units)}</span>
                </button>
              </li>
            ))}
            {!cases.length && <li className="banner warn">{t('记录里后仓没有这个商品了')}</li>}
          </ul>
        )}
        <h3 className="section-title">{atShelf ? t('✓ 已到货位 {0}', task.locationId) : t('第 2 步：到货位 {0} 通道 · {1} {2} 号 · 第 {3} 层，扫描货位标签', loc.aisle, loc.side, loc.bay, loc.level)}</h3>
        <ScanBox label={t('扫描箱子或货位标签')} onScan={onScan} />
        {!atShelf && (
          <button className="link" onClick={() => setAtShelf(true)}>
            {t('没有货位标签？手动确认已到货位（演示）')}
          </button>
        )}
        {kase && atShelf && (
          <div className="card">
            <p>{t('第 3 步：上架件数（货架还能放 {0} 件）', room)}</p>
            <div className="stepper">
              <button onClick={() => setUnits(Math.max(1, (units ?? want) - 1))}>−</button>
              <b className="mono">{units ?? want}</b>
              <button onClick={() => setUnits(Math.min(kase.units, (units ?? want) + 1))}>+</button>
            </div>
            <button
              className="primary block"
              onClick={async () => {
                if (await run({ type: 'CompleteReplenishment', taskId: task.id, caseId: kase.id, locationId: task.locationId, units: units ?? want })) {
                  toast(kase.units - (units ?? want) > 0 ? t('完成。箱里还剩 {0} 件，放回 {1}', kase.units - (units ?? want), kase.binCode ?? '') : t('完成'), 'ok');
                  setCaseId(undefined);
                  setAtShelf(false);
                  setUnits(undefined);
                }
              }}
            >
              {t('完成上架')}
            </button>
          </div>
        )}
      </section>
      <div className="actions">
        <button className="warn" onClick={() => void run({ type: 'CancelReplenishment', taskId: task.id })}>
          {t('后仓找不到')}
        </button>
        <button onClick={() => void run({ type: 'ReleaseReplenishment', taskIds: [task.id] })}>{t('放回队列')}</button>
      </div>
    </div>
  );
}
