import { DISRUPTION_LABEL } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { useClock } from '../state/clock';
import { t, translate } from '../i18n';

/** 场景顶部的大事件横幅：显示正在发生的火警、警情、停电或系统故障 */
export function IncidentBanner() {
  const now = useClock(3);
  const timeline = useApp((s) => s.timeline);
  const active = (timeline?.incidents.disruptions ?? []).filter((d) => d.kind !== 'PRINTER_JAM' && now >= d.start && now < d.end);
  if (!active.length) return null;
  return (
    <div className="incident-banner" role="alert">
      {active.map((d) => t('{0} · 剩余 {1} 分钟', translate(DISRUPTION_LABEL[d.kind]), Math.ceil((d.end - now) / 60))).join('　')}
    </div>
  );
}
