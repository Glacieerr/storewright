import type { TempZone } from '@storewright/domain';
import { zone } from '../rejects';

const LETTER: Record<TempZone, string> = { AMBIENT: 'A', CHILLED: 'C', FROZEN: 'F', HOT: 'H' };

/** 温区：字母 + 文字 + 颜色（不能只靠颜色区分） */
export function ZoneChip({ z, big }: { z: TempZone; big?: boolean }) {
  return (
    <span className={`zone zone-${z.toLowerCase()}${big ? ' big' : ''}`}>
      <b>{LETTER[z]}</b>
      {zone(z)}
    </span>
  );
}
