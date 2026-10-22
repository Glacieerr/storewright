import { useState } from 'react';
import { openChecks, planogramByItem, resolveScan, shelfNow, type ShelfCheck, type StoreStatic } from '@storewright/ops';
import { feedback } from '../../feedback';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { locationParts } from '../../format';
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
              <span className="tag">{c.reason === 'AI' ? t('AI：可能不在货架上') : t('手动')}</span>
              <span className="due">{clock(c.createdAt)}</span>
            </div>
            <p className="note">{t('货位 {0} · 系统估算 {1} 件', c.locationId, p ? Math.round(shelfNow(client.state, p).est) : '?')}</p>
            <button className="primary block" onClick={() => onOpen(c.id)}>
              {t('去核对')}
            </button>
          </article>
        );
      })}
    </>
  );
}

/** 核对：到货位扫描标签 → 数一数货架上有几件 → 提交（作为新的确认值；少了会自动补货） */
export function ShelfCheckFlow({ check, onDone }: { check: ShelfCheck; onDone: () => void }) {
  const { client, run } = useLive();
  const st = client.statics as StoreStatic;
  const p = planogramByItem(st).get(check.itemId);
  const [atShelf, setAtShelf] = useState(false);
  const [units, setUnits] = useState(0);
  const loc = locationParts(check.locationId);
  const onScan = (raw: string) => {
    const r = resolveScan(client.state, st, raw);
    if (r.kind === 'location' && r.locationId === check.locationId) {
      feedback('ok');
      return setAtShelf(true);
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
            <button className="link" onClick={() => setAtShelf(true)}>
              {t('没有货位标签？手动确认已到货位（演示）')}
            </button>
          </>
        )}
        {atShelf && (
          <div className="card">
            <p>{t('第 2 步：货架上实际有几件？（包括后面和旁边被挡住的）')}</p>
            <div className="stepper">
              <button onClick={() => setUnits(Math.max(0, units - 1))}>−</button>
              <b className="mono">{units}</b>
              <button onClick={() => setUnits(units + 1)}>+</button>
            </div>
            <button
              className="primary block"
              onClick={async () => {
                if (await run({ type: 'ConfirmShelf', itemId: check.itemId, units, checkId: check.id })) {
                  toast(units === 0 ? t('已记录：货架上没有，系统会安排补货') : t('已记录：货架上有 {0} 件', units), 'ok');
                  onDone();
                }
              }}
            >
              {t('提交数量')}
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
