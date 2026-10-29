import { GENERATOR_LIMITS, type YardSettings } from '@storewright/store-config';
import { t } from '../i18n';

/**
 * 卸货场的设置（决策记录 0019）：进场道路在门店哪一侧、接主路还是经侧面的支路、离停车场多远；
 * 待命车位数（0 = 按场地自动）与甩挂车位数。门店生成器和布局编辑器共用。
 */
export function YardFields({ value, onChange }: { value: YardSettings; onChange: (patch: Partial<YardSettings>) => void }) {
  const L = GENERATOR_LIMITS;
  const num = (v: string, range: readonly [number, number]) => Math.min(range[1], Math.max(range[0], Math.round(Number(v) || 0)));
  return (
    <>
      <label>
        <span>{t('进场道路')}</span>
        <span className="inline">
          <select value={value.side} onChange={(e) => onChange({ side: e.target.value as YardSettings['side'] })} aria-label={t('进场道路在哪一侧')}>
            <option value="RIGHT">{t('门店右侧')}</option>
            <option value="LEFT">{t('门店左侧')}</option>
          </select>
          <select value={value.via} onChange={(e) => onChange({ via: e.target.value as YardSettings['via'] })} aria-label={t('进场道路接到哪里')}>
            <option value="DRIVE">{t('专用通道接主路')}</option>
            <option value="STREET">{t('经侧面支路')}</option>
          </select>
        </span>
      </label>
      <label>
        <span>{t('离停车场')}</span>
        <input type="number" min={L.yardOffset[0]} max={L.yardOffset[1]} value={value.offsetM} onChange={(e) => onChange({ offsetM: num(e.target.value, L.yardOffset) })} />
      </label>
      <label>
        <span>{t('待命车位')}</span>
        <input type="number" min={L.yardSlots[0]} max={L.yardSlots[1]} value={value.slots} onChange={(e) => onChange({ slots: num(e.target.value, L.yardSlots) })} />
      </label>
      <label>
        <span>{t('甩挂车位')}</span>
        <input type="number" min={L.trailerStalls[0]} max={L.trailerStalls[1]} value={value.trailerStalls} onChange={(e) => onChange({ trailerStalls: num(e.target.value, L.trailerStalls) })} />
      </label>
      <p className="hint">{t('半挂车进出主路按 15 米的圆弧转弯（路口是喇叭口），卸货场里沿单向车道绕行、从司机一侧倒车靠台。待命车位填 0 表示按场地宽度自动；车位不够时后到的车排在进场道路上。')}</p>
    </>
  );
}
