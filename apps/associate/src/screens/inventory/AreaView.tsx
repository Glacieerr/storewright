import { areaUsage, type AreaUsage } from '@storewright/ops';
import { t } from '../../i18n';
import { useLive } from '../../live';

/** 区域类型的名称（决策记录 0013） */
export const AREA_NAME: Record<string, string> = {
  UNLOAD: '卸货区',
  RECEIVING_HOLD: '收货暂放区',
  QA: '待检区',
  RTV: '退供应商区',
  RETURNS: '顾客退货处理区',
  PALLETS: '空托盘区',
  BALER: '纸箱回收与报废区',
  RACKS: '托盘货架区',
  COOLER: '冷藏库',
  FREEZER: '冷冻库',
  OVERSTOCK: '高位库存区',
  BULK: '大件区',
  CAGE: '贵重商品笼',
  CHEM: '化学品隔离区',
  CHARGING: '叉车充电区',
  STAGING: '暂存区',
  STAGING_DELIVERY: '配送暂存道',
  STAGING_OVERSIZED: '大件暂存区',
  HOT_HOLD: '熟食保温区',
  PARCEL: '包裹区',
  RECOVERY: '回收专区',
};

const GROUP_NAME: Record<string, string> = { RECEIVING: '收货', STORAGE: '后仓存储', STAGING: '暂存' };
const UNIT_NAME: Record<string, string> = { PALLET: '托盘位', CASE: '箱', TOTE: '框', ITEM: '件', PARCEL: '个包裹' };
const TEMP_NAME: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻', HOT: '保温' };

export function areaName(kind: string, label?: string): string {
  return label || t(AREA_NAME[kind] ?? kind);
}

/** 区域管理：每个区域的占用、容量和预警，按收货 / 后仓存储 / 暂存分组 */
export function AreaBoard() {
  const { client } = useLive();
  const st = client.statics;
  if (!st?.areas?.length) return <p className="note">{t('这家门店还没有区域信息。')}</p>;
  const usage = areaUsage(client.state, st);
  const alerts = usage.filter((u) => u.alert);
  const groups: Array<[string, AreaUsage[]]> = (['RECEIVING', 'STORAGE', 'STAGING'] as const).map((g) => [g, usage.filter((u) => u.area.group === g)]);
  return (
    <div className="area-board">
      <p className={`note ${alerts.length ? 'warn' : ''}`}>
        {alerts.length ? t('{0} 个区域超过预警：{1}', alerts.length, alerts.map((u) => areaName(u.area.kind, u.area.label)).join('、')) : t('全部区域都在预警线以下。')}
      </p>
      {groups.map(([g, list]) =>
        list.length ? (
          <section key={g} className="area-group">
            <h3 className="section-title">{t(GROUP_NAME[g] ?? g)}</h3>
            <ul>
              {list.map((u) => (
                <li key={u.area.id} className={u.alert ? 'alert' : ''}>
                  <div className="area-head">
                    <b>{areaName(u.area.kind, u.area.label)}</b>
                    <span className="mono muted">{u.area.id}</span>
                    {u.area.tempZone !== 'AMBIENT' && <span className={`zone-chip z-${u.area.tempZone}`}>{t(TEMP_NAME[u.area.tempZone] ?? u.area.tempZone)}</span>}
                    {u.alert && <span className="pill alert">{t('超过预警')}</span>}
                  </div>
                  {u.tracked ? (
                    <>
                      <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={u.capacity} aria-valuenow={u.used} aria-label={areaName(u.area.kind, u.area.label)}>
                        <i style={{ width: `${Math.min(100, Math.round(u.rate * 100))}%` }} />
                      </div>
                      <small className="muted">
                        {t('{0} / {1} {2}', u.used, u.capacity, t(UNIT_NAME[u.area.unit] ?? u.area.unit))} · {Math.round(u.rate * 100)}% · {t('预警线 {0}%', Math.round(u.area.alertAt * 100))} · {(u.area.x1 - u.area.x0).toFixed(1)} × {(u.area.z1 - u.area.z0).toFixed(1)} m
                      </small>
                    </>
                  ) : (
                    <small className="muted">
                      {t('容量 {0} {1}，作业记录里没有这个区域的占用', u.capacity, t(UNIT_NAME[u.area.unit] ?? u.area.unit))} · {(u.area.x1 - u.area.x0).toFixed(1)} × {(u.area.z1 - u.area.z0).toFixed(1)} m
                    </small>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
