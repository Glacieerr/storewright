import type { StoreConfig } from '@storewright/store-config';
import { useApp } from '../state/store';
import { SPOT_W } from '../scene/lot';
import { t } from '../i18n';

/**
 * 线上取货车位（决策记录 0013）：数量、位置、车头朝向和编号都可以改。
 * 自动模式下按门店宽度摆在第一排靠近交付门的位置；改为手动后每个车位单独编辑、可以拖动，顾客到店时只能用这些编号。
 */
export function ParkingEditor({ draft, update }: { draft: StoreConfig; update: (fn: (d: StoreConfig) => void) => void }) {
  const geo = useApp((s) => s.geo);
  const sel = useApp((s) => s.areaSel);
  const setSel = useApp((s) => s.setAreaSel);
  const bays = draft.parking?.pickupBays;
  const auto = geo.lot.spots.filter((s) => s.kind === 'pickup');
  const num = (v: string, f: number) => (v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : f);

  if (!bays?.length) {
    return (
      <>
        <label>
          <span>{t('取货车位')}</span>
          <input type="number" min={0} max={30} value={draft.outdoor.pickupBays} onChange={(e) => update((d) => (d.outdoor.pickupBays = Math.min(30, Math.max(0, Number(e.target.value) || 0))))} />
        </label>
        <p className="hint">
          {t('现在 {0} 个取货车位按门店宽度自动摆在第一排靠近交付门的位置。', auto.length)}{' '}
          <button
            className="link"
            onClick={() =>
              update((d) => {
                d.parking = { ...(d.parking ?? {}), pickupBays: auto.map((s, i) => ({ id: `P${i + 1}`, x: Math.round(s.x * 10) / 10, z: Math.round(s.z * 10) / 10, heading: Math.round((s.heading * 180) / Math.PI) })) };
              })
            }
          >
            {t('改为手动摆放')}
          </button>
        </p>
      </>
    );
  }

  const door = draft.layout.points.handoff;
  return (
    <div className="bay-editor">
      <p className="hint">{t('{0} 个取货车位。点一个车位后在场景里拖动它的把手；编号就是顾客到店时选的车位号。', bays.length)}</p>
      <ul className="dock-list">
        {bays.map((b, i) => {
          const key = `bay:${b.id}`;
          const set = (fn: (x: { id: string; x: number; z: number; heading: number }) => void) =>
            update((d) => {
              const x = d.parking?.pickupBays?.[i];
              if (x) fn(x);
            });
          return (
            <li key={`${b.id}-${i}`} className={sel === key ? 'open' : ''}>
              <button className="link" onClick={() => setSel(sel === key ? undefined : key)} aria-pressed={sel === key}>
                {sel === key ? '●' : '○'}
              </button>
              <input className="bay-id" value={b.id} aria-label={t('车位编号')} onChange={(e) => set((x) => (x.id = e.target.value.trim() || x.id))} />
              <input type="number" step={0.5} value={b.x} aria-label="x" onChange={(e) => set((x) => (x.x = num(e.target.value, x.x)))} />
              <input type="number" step={0.5} value={b.z} aria-label="z" onChange={(e) => set((x) => (x.z = num(e.target.value, x.z)))} />
              <select value={((Math.round(b.heading / 90) * 90) % 360 + 360) % 360} aria-label={t('车头朝向')} onChange={(e) => set((x) => (x.heading = Number(e.target.value)))}>
                <option value={0}>{t('朝门店')}</option>
                <option value={180}>{t('背对门店')}</option>
                <option value={90}>{t('朝右')}</option>
                <option value={270}>{t('朝左')}</option>
              </select>
              <button
                className="link danger"
                onClick={() =>
                  update((d) => {
                    d.parking?.pickupBays?.splice(i, 1);
                  })
                }
              >
                {t('删除')}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="inline">
        <button
          onClick={() =>
            update((d) => {
              const list = d.parking?.pickupBays ?? [];
              const last = list[list.length - 1];
              let n = list.length + 1;
              while (list.some((b) => b.id === `P${n}`)) n++;
              list.push(last ? { id: `P${n}`, x: Math.round((last.x + SPOT_W) * 10) / 10, z: last.z, heading: last.heading } : { id: `P${n}`, x: door.x, z: -11.7, heading: 0 });
              d.parking = { ...(d.parking ?? {}), pickupBays: list };
            })
          }
        >
          {t('添加取货车位')}
        </button>
        <button
          onClick={() =>
            update((d) => {
              const list = [...(d.parking?.pickupBays ?? [])].sort((a, b) => Math.hypot(a.x - door.x, a.z) - Math.hypot(b.x - door.x, b.z));
              d.parking = { ...(d.parking ?? {}), pickupBays: list.map((b, k) => ({ ...b, id: `P${k + 1}` })) };
            })
          }
        >
          {t('按离交付门的距离重新编号')}
        </button>
        <button
          className="link"
          onClick={() =>
            update((d) => {
              if (d.parking) delete d.parking.pickupBays;
            })
          }
        >
          {t('恢复自动摆放')}
        </button>
      </div>
    </div>
  );
}
