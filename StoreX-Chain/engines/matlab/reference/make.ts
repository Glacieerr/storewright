import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambient, REEFER, reeferParams, reeferStep, SETPOINT, type ReeferState } from '../../../src/twin/models';

/**
 * 生成 MATLAB 自检用的参考数据：用孪生里的冷机模型（src/twin/models.ts）跑两段典型的情形，每分钟一行。
 * MATLAB 的 reeferModel.m 用同样的输入重算，和这份数据逐行比（selfTest.m）。
 *   npx tsx engines/matlab/reference/make.ts
 */
const rows: string[] = ['case,zone,t_min,amb,set,door,seal,comp,extra,air,product,cool'];
const cases = [
  // 冷藏车：装车 40 分钟（开门）→ 路上 → 6:00 开始密封不严 → 门店卸货 30 分钟 → 回程
  { name: 'chilled-seal', zone: 'chilled' as const, t0: 4 * 60, n: 240, door: (m: number) => m < 40 || (m >= 150 && m < 180), seal: (m: number) => m >= 120, comp: () => true, extra: () => 0 },
  // 冷冻车：路上 1 小时以后压缩机坏了
  { name: 'frozen-comp', zone: 'frozen' as const, t0: 10 * 60, n: 240, door: (m: number) => m >= 200 && m < 225, seal: () => false, comp: (m: number) => m < 60, extra: () => 0 },
  // 冷藏车：孪生估计的额外漏热 0.12 °C / 分钟
  { name: 'chilled-extra', zone: 'chilled' as const, t0: 14 * 60, n: 180, door: () => false, seal: () => false, comp: () => true, extra: () => 0.12 },
];
for (const c of cases) {
  const p = reeferParams(c.zone, REEFER);
  const set = SETPOINT[c.zone];
  let s: ReeferState = { air: set, product: set + 0.4, cool: false };
  for (let m = 0; m < c.n; m++) {
    const t = (c.t0 + m) * 60;
    const u = { amb: ambient(t), set, door: c.door(m), seal: c.seal(m), comp: c.comp(m), extra: c.extra() };
    s = reeferStep(s, p, u, 1);
    rows.push([c.name, c.zone, c.t0 + m, u.amb.toFixed(9), set, Number(u.door), Number(u.seal), Number(u.comp), u.extra, s.air.toFixed(9), s.product.toFixed(9), Number(s.cool)].join(','));
  }
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'reefer_reference.csv');
writeFileSync(out, `${rows.join('\n')}\n`);
console.log(`${rows.length - 1} 行 → ${out}`);
