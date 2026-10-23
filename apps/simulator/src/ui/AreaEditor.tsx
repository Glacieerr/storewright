import { useState } from 'react';
import { addArea, addDock, AREA_KINDS, materializeAreas, removeArea, removeDock, storeAreas, type AreaKind, type StoreConfig } from '@storewright/store-config';
import { useApp } from '../state/store';
import { AREA_NAME } from './areaNames';
import { t } from '../i18n';

/**
 * 区域与卸货门（决策记录 0013）：收货、后仓存储、暂存的每一块区域都可以新建、改类型、改温区和容量、
 * 输入或拖动位置与大小、删除；卸货门可以增删、沿后墙移动、设为冷藏门或地面门。
 * 门店还在用自动生成的区域时，先把它们写进配置再编辑（结果不变）。
 */

const GROUPS: Array<[string, string]> = [
  ['RECEIVING', '收货'],
  ['STORAGE', '后仓存储'],
  ['STAGING', '暂存'],
];
const TEMPS: Array<[string, string]> = [
  ['AMBIENT', '常温'],
  ['CHILLED', '冷藏'],
  ['FROZEN', '冷冻'],
  ['HOT', '保温'],
];
const UNIT: Record<string, string> = { PALLET: '托盘位', CASE: '箱', TOTE: '框', ITEM: '件', PARCEL: '个包裹' };

export function AreaEditor({ draft, update }: { draft: StoreConfig; update: (fn: (d: StoreConfig) => void) => void }) {
  const sel = useApp((s) => s.areaSel);
  const setSel = useApp((s) => s.setAreaSel);
  const [kind, setKind] = useState<AreaKind>('QA');
  const resolved = storeAreas(draft);
  const auto = !draft.areas;
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== '' ? Math.round(Number(v) * 10) / 10 : fallback);

  return (
    <div className="form area-editor">
      <h3>{t('区域与卸货门')}</h3>
      {auto && (
        <p className="hint">
          {t('现在用的是按门店尺寸自动生成的区域。改为手动编辑后，可以逐个移动、改大小、新建和删除（布局不变）。')}{' '}
          <button className="link" onClick={() => update((d) => materializeAreas(d))}>
            {t('改为手动编辑')}
          </button>
        </p>
      )}
      {GROUPS.map(([g, label]) => {
        const list = resolved.areas.filter((a) => a.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="area-group-edit">
            <h4>{t(label)}</h4>
            <ul>
              {list.map((a) => {
                const open = sel === a.id;
                return (
                  <li key={a.id} className={open ? 'open' : ''}>
                    <button className="area-row" onClick={() => setSel(open ? undefined : a.id)} aria-expanded={open}>
                      <b>{a.label || t(AREA_NAME[a.kind] ?? a.kind)}</b>
                      <span className="mono muted">{a.id}</span>
                      <span className="muted">
                        {t('{0} {1}', a.capacity, t(UNIT[a.unit] ?? a.unit))} · {(a.x1 - a.x0).toFixed(1)} × {(a.z1 - a.z0).toFixed(1)} m
                      </span>
                    </button>
                    {open && !auto && (
                      <AreaFields id={a.id} draft={draft} update={update} num={num} onRemove={() => setSel(undefined)} />
                    )}
                    {open && auto && <p className="hint">{t('先点上面的「改为手动编辑」。')}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <div className="inline">
        <select value={kind} onChange={(e) => setKind(e.target.value as AreaKind)} aria-label={t('新区域的类型')}>
          {GROUPS.map(([g, label]) => (
            <optgroup key={g} label={t(label)}>
              {(Object.keys(AREA_KINDS) as AreaKind[])
                .filter((k) => AREA_KINDS[k].group === g)
                .map((k) => (
                  <option key={k} value={k}>
                    {t(AREA_NAME[k] ?? k)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button
          onClick={() => {
            let id = '';
            update((d) => {
              id = addArea(d, kind);
            });
            setSel(id);
          }}
        >
          {t('添加区域')}
        </button>
      </div>

      <h4>{t('卸货门')}</h4>
      <ul className="dock-list">
        {resolved.docks.map((d) => (
          <li key={d.id}>
            <span className="mono">{d.id}</span>
            {auto ? (
              <span className="muted">
                x = {d.x.toFixed(1)} m{d.reefer ? ` · ${t('冷藏')}` : ''}
              </span>
            ) : (
              <>
                <input
                  type="number"
                  step={0.5}
                  value={d.x}
                  aria-label={t('{0} 的位置（米）', d.id)}
                  onChange={(e) =>
                    update((c) => {
                      const k = c.docks?.find((q) => q.id === d.id);
                      if (k) k.x = num(e.target.value, k.x);
                    })
                  }
                />
                <select
                  value={d.kind}
                  aria-label={t('{0} 的类型', d.id)}
                  onChange={(e) =>
                    update((c) => {
                      const k = c.docks?.find((q) => q.id === d.id);
                      if (k) k.kind = e.target.value as 'DOCK' | 'GRADE';
                    })
                  }
                >
                  <option value="DOCK">{t('高台卸货口')}</option>
                  <option value="GRADE">{t('地面卷帘门')}</option>
                </select>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={d.reefer}
                    onChange={(e) =>
                      update((c) => {
                        const k = c.docks?.find((q) => q.id === d.id);
                        if (k) k.reefer = e.target.checked;
                      })
                    }
                  />
                  {t('冷藏')}
                </label>
                <button className="link danger" disabled={resolved.docks.length <= 1} onClick={() => update((c) => removeDock(c, d.id))}>
                  {t('删除')}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <button onClick={() => update((d) => void addDock(d))}>{t('添加卸货门')}</button>
      <p className="hint">{t('在场景里拖动选中区域中间的把手移动它，拖动右后角的把手改大小；卸货门的把手沿后墙左右拖动。冷藏车优先停冷藏门。')}</p>
    </div>
  );
}

function AreaFields({ id, draft, update, num, onRemove }: { id: string; draft: StoreConfig; update: (fn: (d: StoreConfig) => void) => void; num: (v: string, f: number) => number; onRemove: () => void }) {
  const a = draft.areas?.find((x) => x.id === id);
  if (!a) return null;
  const set = (fn: (x: NonNullable<StoreConfig['areas']>[number]) => void) =>
    update((d) => {
      const x = d.areas?.find((q) => q.id === id);
      if (x) fn(x);
    });
  return (
    <div className="area-fields">
      <label>
        <span>{t('名称')}</span>
        <input value={a.label ?? ''} placeholder={t(AREA_NAME[a.kind] ?? a.kind)} onChange={(e) => set((x) => (e.target.value ? (x.label = e.target.value) : delete x.label))} />
      </label>
      <label>
        <span>{t('类型')}</span>
        <select value={a.kind} onChange={(e) => set((x) => (x.kind = e.target.value as AreaKind))}>
          {(Object.keys(AREA_KINDS) as AreaKind[]).map((k) => (
            <option key={k} value={k}>
              {t(AREA_NAME[k] ?? k)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('温区')}</span>
        <select value={a.tempZone ?? AREA_KINDS[a.kind].temp} onChange={(e) => set((x) => (x.tempZone = e.target.value as 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'HOT'))}>
          {TEMPS.map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('容量')}</span>
        <input type="number" min={1} value={a.capacity ?? ''} placeholder={t('按面积自动')} onChange={(e) => set((x) => (e.target.value ? (x.capacity = Math.max(1, Math.round(Number(e.target.value)))) : delete x.capacity))} />
      </label>
      <label>
        <span>{t('预警线（%）')}</span>
        <input type="number" min={10} max={100} value={Math.round((a.alertAt ?? 0.85) * 100)} onChange={(e) => set((x) => (x.alertAt = Math.min(1, Math.max(0.1, Number(e.target.value) / 100 || 0.85))))} />
      </label>
      <label>
        <span>{t('位置（米）')}</span>
        <span className="inline coords">
          {(['x0', 'z0', 'x1', 'z1'] as const).map((k) => (
            <input key={k} type="number" step={0.5} value={a[k]} aria-label={k} onChange={(e) => set((x) => (x[k] = num(e.target.value, x[k])))} />
          ))}
        </span>
      </label>
      <button
        className="link danger"
        onClick={() => {
          update((d) => removeArea(d, id));
          onRemove();
        }}
      >
        {t('删除这个区域')}
      </button>
    </div>
  );
}
