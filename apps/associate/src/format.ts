import { t } from './i18n';

/**
 * 货位编码 → 拣货员看得懂的说明。编码格式：楼层-通道-侧别货架段-层，例如 F1-A09-L12-2。
 */
export function locationParts(id: string): { aisle: string; side: string; bay: string; level: string } {
  const parts = id.split('-');
  const level = parts.at(-1) ?? '';
  const sideBay = parts.at(-2) ?? '';
  const aisle = parts.slice(1, -2).join('-') || parts[0] || id;
  const sideCode = sideBay[0] ?? '';
  const side = sideCode === 'L' ? t('左侧') : sideCode === 'R' ? t('右侧') : sideCode === 'W' ? t('靠墙') : '';
  return { aisle, side, bay: sideBay.slice(1).replace(/^0+/, ''), level };
}

export function locationText(id: string): string {
  const p = locationParts(id);
  return t('{0} 通道 · {1} {2} 号 · 第 {3} 层', p.aisle, p.side, p.bay, p.level);
}

/** 商品条码后几位（口头核对） */
export function gtinTail(gtin: string): string {
  return gtin.slice(-5);
}
