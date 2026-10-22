import { DISRUPTION_LABEL, type DisruptionKind } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { clockText } from './format';
import { t, translate } from '../i18n';

const TRIGGERS: Array<[DisruptionKind, string]> = [
  ['FIRE_ALARM', '🔥 火警'],
  ['POLICE', '🚓 警情'],
  ['POWER_OUTAGE', '⚡ 停电'],
  ['SYSTEM_OUTAGE', '🖥 系统故障'],
];

/** 突发状况：随机小状况与大事件开关、从当前时刻触发大事件、今天的事件列表 */
export function IncidentPanel() {
  const tm = useClock(2);
  const incidents = useApp((s) => s.incidents);
  const timeline = useApp((s) => s.timeline);
  const app = useApp.getState;
  const all = timeline?.incidents.disruptions ?? [];
  const small = timeline?.incidents.small ?? [];
  const count = (k: string) => small.filter((e) => e.kind === k && e.t <= tm).length;
  return (
    <section>
      <h3>{t('突发状况')}</h3>
      <div className="chips">
        <button className={incidents.small ? 'chip active' : 'chip'} onClick={() => app().setIncidents({ small: !incidents.small })} title={t('标签丢失、商品破损、框找不到、打印机卡纸')}>
          {incidents.small ? t('随机小状况 开') : t('随机小状况 关')}
        </button>
        <button className={incidents.randomLarge ? 'chip active' : 'chip'} onClick={() => app().setIncidents({ randomLarge: !incidents.randomLarge })} title={t('平均每天约 0.6 次火警、警情、停电或系统故障')}>
          {incidents.randomLarge ? t('随机大事件 开') : t('随机大事件 关')}
        </button>
      </div>
      <div className="chips gap-top" role="group" aria-label={t('触发大事件')}>
        <span className="chips-label">{t('现在触发')}</span>
        {TRIGGERS.map(([k, label]) => (
          <button key={k} className="chip" onClick={() => app().triggerIncident(k)}>
            {t(label)}
          </button>
        ))}
      </div>
      {incidents.small && (
        <p className="hint">
          {t('截至 {0}：标签重打 {1} 次 · 商品破损重拣 {2} 次 · 找不到框 {3} 次', clockText(tm), count('LABEL_REPRINT'), count('DAMAGED_ITEM'), count('MISSING_TOTE'))}
        </p>
      )}
      {all.length > 0 && (
        <ul className="incident-list">
          {all.map((d) => {
            const active = tm >= d.start && tm < d.end;
            const manual = incidents.manual.some((m) => m.id === d.id);
            return (
              <li key={d.id} className={active ? 'active' : tm >= d.end ? 'past' : ''}>
                <span className="mono">
                  {clockText(d.start)}–{clockText(d.end)}
                </span>{' '}
                {translate(DISRUPTION_LABEL[d.kind])}
                {active && <span className="tag-live">{t('进行中')}</span>}
                {manual && (
                  <button className="link" onClick={() => app().removeIncident(d.id)}>
                    {t('撤销')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">{t('大事件从当前时刻开始，仿真从头重算这一天并回到当前时刻：火警全员疏散、警情暂停车边交付、停电暂停拣货和暂存、系统故障暂停订单下发。')}</p>
    </section>
  );
}
