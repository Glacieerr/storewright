import { STRESS } from '../../src/analysis/studies';
import type { DisruptionKey } from '../../src/sim/config';
import { t } from './i18n';

/** 网页上的演练：沿用报告里的五种扰动，起始日让动画那一天正好在扰动里 */
export type Drill = DisruptionKey | 'none';

export { DRILL_START } from '../../src/scenario/drill';

export const DRILLS: { key: Drill; label: string; detail: string; days: number }[] = [{ key: 'none', label: t('正常的一天'), detail: t('没有扰动'), days: 0 }, ...STRESS.map((c) => ({ key: c.key as Drill, label: c.label, detail: c.detail, days: c.days }))];
