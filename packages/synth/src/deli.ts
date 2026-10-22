import { createRng, hashString } from '@storewright/domain';

/**
 * 合成熟食制作记录（Phase 6 · 出餐时间预测）。
 * 每道菜有标准制作时长，实际时长 = 标准 × 这道菜在本店的系数（模型看不到，0.85–1.35）
 * + 同时在做的单数 × 2.5 分钟 + 随机波动。全部为假设参数。
 */

export interface DeliDish {
  id: string;
  name: string;
  prepMin: number;
  holdMin: number;
  hot: boolean;
}

/** 演示门店的熟食菜单（虚构） */
export const DELI_MENU: DeliDish[] = [
  { id: 'M-CHICKEN', name: 'Rotisserie Chicken', prepMin: 45, holdMin: 240, hot: true },
  { id: 'M-PIZZA', name: 'Fresh Pizza 14"', prepMin: 18, holdMin: 120, hot: true },
  { id: 'M-WINGS', name: 'Hot Wings (12 pc)', prepMin: 22, holdMin: 120, hot: true },
  { id: 'M-SUB', name: 'Made-to-order Sub', prepMin: 6, holdMin: 240, hot: false },
  { id: 'M-SALAD', name: 'Chef Salad', prepMin: 8, holdMin: 240, hot: false },
  { id: 'M-SUSHI', name: 'Sushi Combo', prepMin: 12, holdMin: 180, hot: false },
];

export interface DeliRecord {
  t: number;
  dishId: string;
  standardMin: number;
  /** 开始制作时同时在做的单数 */
  load: number;
  actualMin: number;
  hidden: { dishFactor: number };
}

export function generateDeliHistory(opts: { seed: number; days?: number; perDay?: number; menu?: DeliDish[] }): DeliRecord[] {
  const rng = createRng(hashString(`${opts.seed}:deli`));
  const menu = opts.menu ?? DELI_MENU;
  const factor = new Map(menu.map((d) => [d.id, Math.round(rng.uniform(0.85, 1.35) * 100) / 100]));
  const out: DeliRecord[] = [];
  const days = opts.days ?? 60;
  for (let day = 0; day < days; day++) {
    const n = rng.poisson(opts.perDay ?? 30);
    for (let i = 0; i < n; i++) {
      const d = menu[rng.int(0, menu.length - 1)] as DeliDish;
      const load = rng.poisson(2);
      const f = factor.get(d.id) as number;
      const actual = Math.max(2, d.prepMin * f + 2.5 * load + rng.normal(0, 0.12 * d.prepMin));
      out.push({ t: day * 1440 + rng.int(8 * 60, 20 * 60), dishId: d.id, standardMin: d.prepMin, load, actualMin: Math.round(actual * 10) / 10, hidden: { dishFactor: f } });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
