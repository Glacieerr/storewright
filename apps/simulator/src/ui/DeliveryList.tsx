import { useApp } from '../state/store';
import { setTime } from '../state/clock';
import { clockText } from './format';
import { t, translate } from '../i18n';

const KIND_LABEL: Record<string, string> = { SEMI: '半挂车', REEFER: '冷藏半挂车', BOX: '厢式货车', VAN: '面包车' };

/**
 * 今日到货（决策记录 0019）：当天每一辆到货车的到达时刻（比预约晚 10 分钟以上时标出）、送什么、车型、托盘数和卸货门。
 * 按星期、季节和门店规模排班，路况会让车晚到。点车名跳到它进场前，镜头跟随它。
 */
export function DeliveryList() {
  const trucks = useApp((s) => s.timeline?.inbound.trucks);
  if (!trucks?.length) return null;
  const count = (...src: string[]) => trucks.filter((d) => src.includes(d.source ?? 'DC')).length;
  const follow = (id: string, arrive: number) => {
    setTime(Math.max(0, arrive - 150));
    useApp.getState().setFollow(id);
  };
  return (
    <details className="deliveries gap-top">
      <summary>{t('今日到货 {0} 辆：配送中心 {1}、供应商直送 {2}、快递 {3}', trucks.length, count('DC', 'DC_GM'), count('VENDOR'), count('PARCEL'))}</summary>
      <table className="cmp">
        <thead>
          <tr>
            <th>{t('到货车辆')}</th>
            <th>{t('到达时刻')}</th>
            <th>{t('托盘')}</th>
            <th>{t('门')}</th>
          </tr>
        </thead>
        <tbody>
          {trucks.map((d) => {
            const late = d.appt === undefined ? 0 : Math.round((d.arrive - d.appt) / 60);
            return (
              <tr key={d.id}>
                <td>
                  <button className="linklike" onClick={() => follow(d.id, d.arrive)} title={t('跳到这辆车进场前，镜头跟随')}>
                    {translate(d.label)}
                  </button>
                  {!d.label.includes('半挂车') && <span className="kind"> · {t(KIND_LABEL[d.kind] ?? d.kind)}</span>}
                </td>
                <td>
                  {clockText(d.arrive)}
                  {late >= 10 && <span className="late" title={t('比预约晚 {0} 分钟', late)}> +{late}′</span>}
                </td>
                <td>{d.pallets}</td>
                <td>{d.door + 1}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
