import { useState } from 'react';
import { LOT_TASKS, openChecks, planogramByItem, resolveScan, shelfNow, type ShelfCheck, type ShelfFound, type StoreStatic } from '@storewright/ops';
import { feedback } from '../../feedback';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { locationParts, nearText } from '../../format';
import { QtyInput } from '../../ui/QtyInput';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';

/** 核对货架任务列表（AI 发现「系统有货、可能找不到」时生成） */
export function ShelfCheckList({ onOpen }: { onOpen: (id: string) => void }) {
  const { client } = useLive();
  const checks = openChecks(client.state);
  const byItem = planogramByItem(client.statics as StoreStatic);
  if (!checks.length) return null;
  return (
    <>
      <h2 className="section-title">{t('核对货架（{0}）', checks.length)}</h2>
      {checks.map((c) => {
        const p = byItem.get(c.itemId);
        return (
          <article key={c.id} className="card">
            <div className="card-head">
              <span className="strong">{p?.name ?? c.itemId}</span>
              <span className="tag">{checkLabel(c)}</span>
              <span className="due">{clock(c.createdAt)}</span>
            </div>
            <p className="note">{lotTaskText(c) ?? t('货位 {0} · 系统估算 {1} 件', c.locationId, p ? Math.round(shelfNow(client.state, p).est) : '?')}</p>
            {c.reason === 'SEARCH' && !!c.near?.length && <p className="note">{t('拣货员报告找不到，多半放错了地方：先看原货位，再看同一通道的 {0}', nearText(c.near))}</p>}
            {c.reason === 'RECALL' && <p className="note">{t('召回的批号已经从货架上拿下来了，剩下的是别的批号：数一下货架上还有几件')}</p>}
            <button className="primary block" onClick={() => onOpen(c.id)}>
              {LOT_TASKS.includes(c.reason) ? t('去做') : t('去核对')}
            </button>
          </article>
        );
      })}
    </>
  );
}

const SEARCH_FOUND: ReadonlyArray<[ShelfFound, string]> = [
  ['HOME', '就在原货位'],
  ['NEARBY', '在附近找到，已放回'],
  ['NONE', '附近也没有'],
];

/** 任务的种类 */
function checkLabel(c: ShelfCheck): string {
  switch (c.reason) {
    case 'AI':
      return t('AI：可能不在货架上');
    case 'SEARCH':
      return t('AI：可能放错了地方');
    case 'MARKDOWN':
      return t('贴折扣签');
    case 'PULL':
      return t('下架过期');
    case 'DONATE':
      return t('拿下来捐赠');
    case 'RETURN':
      return t('退货放回');
    case 'RECALL':
      return t('召回下架后数一下');
    default:
      return t('手动');
  }
}

/** 货架上的批次任务要做什么（决策记录 0026） */
function lotTaskText(c: ShelfCheck): string | undefined {
  if (c.reason === 'MARKDOWN') return t('货位 {0}：批号 {1} 贴 {2}% 折扣签，约 {3} 件', c.locationId, c.lot ?? '', Math.round((c.pct ?? 0) * 100), c.expected ?? '?');
  if (c.reason === 'PULL') return t('货位 {0}：批号 {1} 已经过期，从货架上拿下来，约 {2} 件', c.locationId, c.lot ?? '', c.expected ?? '?');
  if (c.reason === 'DONATE') return t('货位 {0}：批号 {1} 拿下来送去捐赠，约 {2} 件', c.locationId, c.lot ?? '', c.expected ?? '?');
  if (c.reason === 'RETURN') return t('货位 {0}：退货的 {1} 件放回货架', c.locationId, c.expected ?? '?');
  return undefined;
}

/** 核对：到货位扫描标签 → 数一数货架上有几件 → 提交（作为新的确认值；少了会自动补货） */
export function ShelfCheckFlow({ check, onDone }: { check: ShelfCheck; onDone: () => void }) {
  const { client, run } = useLive();
  const st = client.statics as StoreStatic;
  const p = planogramByItem(st).get(check.itemId);
  // 扫到的货位（手动确认时是 '*'，提交时标成点选，决策记录 0026）
  const [atShelf, setAtShelf] = useState<string | undefined>();
  // 批次任务（决策记录 0026）：数的是做了几件，默认是大约的件数
  const lotTask = LOT_TASKS.includes(check.reason);
  const [units, setUnits] = useState(lotTask ? (check.expected ?? 0) : 0);
  const strict = !!client.state.settings?.requireScan;
  // 附近找一找（决策记录 0022 · C1）：商品在哪里找到的，用来判断拣货员的报告对不对
  const search = check.reason === 'SEARCH';
  const [found, setFound] = useState<ShelfFound | undefined>();
  const loc = locationParts(check.locationId);
  const onScan = (raw: string) => {
    const r = resolveScan(client.state, st, raw);
    if (r.kind === 'location' && r.locationId === check.locationId) {
      feedback('ok');
      return setAtShelf(r.locationId);
    }
    feedback('error');
    toast(r.kind === 'location' ? t('货位不对：应该是 {0}', check.locationId) : t('无法识别：{0}', raw), 'error');
  };
  return (
    <div className="walk">
      <header className="walk-head">
        {p && <ZoneChip z={p.tempZone} big />}
        <div>
          <div className="strong">{p?.name ?? check.itemId}</div>
          <div className="muted">{t('系统估算 {0} 件 · 容量 {1}', p ? Math.round(shelfNow(client.state, p).est) : '?', p?.capacity ?? '?')}</div>
        </div>
      </header>
      <section className="phase">
        <h3 className="section-title">{atShelf ? t('✓ 已到货位 {0}', check.locationId) : t('第 1 步：到货位 {0} 通道 · {1} {2} 号 · 第 {3} 层，扫描货位标签', loc.aisle, loc.side, loc.bay, loc.level)}</h3>
        {!atShelf && (
          <>
            <ScanBox label={t('扫描货位标签')} onScan={onScan} />
            {!strict && (
              <button className="link" onClick={() => setAtShelf('*')}>
                {t('没有货位标签？手动确认已到货位（演示）')}
              </button>
            )}
          </>
        )}
        {atShelf && (
          <div className="card">
            {search && (
              <>
                <p>{t('在哪里找到的？')}</p>
                <div className="chips" role="radiogroup" aria-label={t('在哪里找到的？')}>
                  {SEARCH_FOUND.map(([k, label]) => (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={found === k}
                      className={`chip${found === k ? ' on' : ''}`}
                      onClick={() => {
                        setFound(k);
                        if (k === 'NONE') setUnits(0);
                      }}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
                {!!check.near?.length && <p className="note">{t('附近：{0}。在附近找到的请放回原货位再数。', nearText(check.near))}</p>}
              </>
            )}
            {lotTask && <p className="banner info">{lotTaskText(check)}</p>}
            {found !== 'NONE' && (
              <>
                <p>{lotTask ? t('第 2 步：做了几件？') : t('第 2 步：货架上实际有几件？（包括后面和旁边被挡住的）')}</p>
                <QtyInput value={units} onChange={setUnits} label={t('货架上有几件')} />
              </>
            )}
            <button
              className="primary block"
              disabled={search && !found}
              onClick={async () => {
                if (await run({ type: 'ConfirmShelf', itemId: check.itemId, units, checkId: check.id, ...(search && found ? { found } : {}), ...(atShelf && atShelf !== '*' ? { locationId: atShelf } : { tap: true }) })) {
                  toast(lotTask ? t('已记录：{0} {1} 件', checkLabel(check), units) : units === 0 ? t('已记录：货架上没有，系统会安排补货') : t('已记录：货架上有 {0} 件', units), 'ok');
                  onDone();
                }
              }}
            >
              {lotTask ? t('做好了，提交 {0} 件', units) : t('提交数量')}
            </button>
          </div>
        )}
      </section>
      <div className="actions">
        <button onClick={onDone}>{t('返回')}</button>
      </div>
    </div>
  );
}
