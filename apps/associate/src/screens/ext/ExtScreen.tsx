import { useState } from 'react';
import { currentRole } from '@storewright/ops';
import { t } from '../../i18n';
import { useLive } from '../../live';
import { rememberedSub, rememberSub } from '../../nav';
import { MtoView } from './MtoView';
import { OversizedView } from './OversizedView';
import { ParcelView } from './ParcelView';
import { ReturnsView } from './ReturnsView';

type Section = 'mto' | 'returns' | 'oversized' | 'parcel';

const LABEL: Record<Section, string> = { mto: '熟食现做', returns: '退货', oversized: '大件', parcel: '包裹' };
const DEFAULT: Record<string, Section> = { DELI: 'mto', BACKROOM: 'parcel', HANDOFF: 'returns', STAGE: 'oversized' };

/** 扩展模块（决策记录 0011）：门店配置里启用的模块才显示 */
export function ExtScreen() {
  const { client, auth } = useLive();
  const s = client.state;
  const mods = client.statics?.modules;
  const sections = (['mto', 'returns', 'oversized', 'parcel'] as const).filter((k) => mods?.[k]);
  const role = currentRole(client.statics, client.state, auth.actor, client.now()) ?? '';
  const preferred = DEFAULT[role];
  // 记住上次的子页（决策记录 0026）：交付员去熟食现做取东西再回来，不会跳回退货
  const remembered = rememberedSub('ext') as Section | undefined;
  const [section, setSectionState] = useState<Section | undefined>(remembered && sections.includes(remembered) ? remembered : preferred && sections.includes(preferred) ? preferred : sections[0]);
  const setSection = (k: Section) => {
    rememberSub('ext', k);
    setSectionState(k);
  };
  if (!sections.length || !section) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有启用扩展模块')}</p>
        <p>{t('在门店配置里启用熟食现做、退货、大件或包裹中转后会出现在这里。')}</p>
      </div>
    );
  }
  const badge: Record<Section, number> = {
    mto: Object.values(s.mto).filter((x) => x.status === 'QUEUED' || x.status === 'COOKING' || x.status === 'HELD').length,
    returns: Object.values(s.returns).filter((x) => x.status === 'OPEN').length,
    oversized: Object.values(s.oversized).filter((x) => x.status !== 'STAGED').length,
    parcel: Object.values(s.parcels).filter((x) => x.status === 'INDUCTED' || x.status === 'OVER' || x.status === 'DAMAGED').length,
  };
  return (
    <div className="inventory">
      <div className="segmented wide" role="tablist">
        {sections.map((k) => (
          <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
            <span className="seg-label">{t(LABEL[k])}</span>
            {badge[k] > 0 && <em>{badge[k]}</em>}
          </button>
        ))}
      </div>
      {section === 'mto' && <MtoView />}
      {section === 'returns' && <ReturnsView />}
      {section === 'oversized' && <OversizedView />}
      {section === 'parcel' && <ParcelView />}
    </div>
  );
}

/** 扩展页的徽标数（底部标签栏用） */
export function extBadge(s: ReturnType<typeof useLive>['client']['state']): number {
  return (
    Object.values(s.mto).filter((x) => x.status === 'QUEUED' || x.status === 'HELD').length +
    Object.values(s.oversized).filter((x) => x.status === 'OPEN').length +
    Object.values(s.parcels).filter((x) => x.status === 'INDUCTED' || x.status === 'OVER' || x.status === 'DAMAGED').length
  );
}
