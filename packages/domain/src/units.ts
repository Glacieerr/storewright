export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;

/** 商品体积（升），尺寸单位为厘米 */
export const volumeLiters = (d: { l: number; w: number; h: number }): number => (d.l * d.w * d.h) / 1000;

/** 仿真秒 → "HH:MM" */
export function formatClock(sec: number): string {
  const total = Math.floor(sec / 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const minutes = (m: number): number => m * 60;
export const hours = (h: number): number => h * 3600;
