import { useState } from 'react';
import { DEFAULT_YARD_OFFSET, GENERATOR_LIMITS, GENERATOR_PRESETS, randomGeneratorParams, templateParams, type GeneratorParams } from '@storewright/store-config';
import { YardFields } from './YardFields';
import { useApp } from '../state/store';
import { t, translate } from '../i18n';

function NumberField({ label, value, range, step = 1, onChange }: { label: string; value: number; range: readonly [number, number]; step?: number; onChange: (v: number) => void }) {
  return (
    <label>
      <span>{t(label)}</span>
      <input type="number" min={range[0]} max={range[1]} step={step} value={value} onChange={(e) => onChange(Math.min(range[1], Math.max(range[0], Number(e.target.value) || range[0])))} />
    </label>
  );
}

const DEFAULT_BACKROOM = { extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: 3, forklifts: 1, palletJacks: 2 };
const DEFAULT_YARD = { side: 'RIGHT' as const, via: 'DRIVE' as const, offsetM: DEFAULT_YARD_OFFSET, slots: 0, trailerStalls: 0 };

function HourSelect({ value, range, onChange }: { value: number; range: readonly [number, number]; onChange: (h: number) => void }) {
  const hours: number[] = [];
  for (let h = range[0]; h <= range[1]; h++) hours.push(h);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {hours.map((h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </select>
  );
}

/**
 * 门店生成器：从预设或随机参数出发，逐项调整楼层、货架、暂存区和附属设施，
 * 一键生成并实时应用（可撤销）。
 */
export function GeneratorPanel() {
  const [p, setP] = useState<GeneratorParams>(() => templateParams(useApp.getState().template));
  const [msg, setMsg] = useState<string>();
  const patch = (fn: (d: GeneratorParams) => void) =>
    setP((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const apply = (params: GeneratorParams) => {
    const issues = useApp.getState().applyGenerated(params);
    setMsg(issues.length ? t('生成的配置有 {0} 个问题：{1}', issues.length, translate(issues[0]?.message ?? '')) : t('已生成并实时应用（可撤销）'));
  };
  const L = GENERATOR_LIMITS;

  return (
    <details className="form generator" open>
      <summary>
        <h3>{t('门店生成器')}</h3>
      </summary>
      <div className="chips">
        {GENERATOR_PRESETS.map((preset) => (
          <button key={preset.id} className="chip" onClick={() => setP(preset.params())}>
            {t(preset.label)}
          </button>
        ))}
        <button
          className="chip"
          onClick={() => {
            const next = randomGeneratorParams(1 + Math.floor(Math.random() * 99999));
            setP(next);
            apply(next);
          }}
        >
          {t('🎲 随机门店')}
        </button>
      </div>
      <NumberField label="常温通道" value={p.ambientAisles} range={L.ambientAisles} onChange={(v) => patch((d) => (d.ambientAisles = v))} />
      <NumberField label="冷冻通道" value={p.frozenAisles} range={L.frozenAisles} onChange={(v) => patch((d) => (d.frozenAisles = v))} />
      <NumberField label="一楼百货" value={p.gmAislesF1} range={L.gmAislesF1} onChange={(v) => patch((d) => (d.gmAislesF1 = v))} />
      <NumberField label="货架段数" value={p.bays} range={L.bays} onChange={(v) => patch((d) => (d.bays = v))} />
      <NumberField label="货架层数" value={p.levels} range={L.levels} onChange={(v) => patch((d) => (d.levels = v))} />
      <label>
        <span>{t('暂存规模')}</span>
        <select value={p.stagingScale} onChange={(e) => patch((d) => (d.stagingScale = Number(e.target.value)))}>
          {[0.5, 1, 1.5, 2, 2.5, 3].map((v) => (
            <option key={v} value={v}>
              {t('{0} 倍', v)}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={p.perimeter} onChange={(e) => patch((d) => (d.perimeter = e.target.checked))} />
        {t('左墙蔬果、后墙冷藏柜')}
      </label>
      <label className="check">
        <input type="checkbox" checked={!!p.secondFloor} onChange={(e) => patch((d) => (d.secondFloor = e.target.checked ? { gmAisles: 0, bays: 16, levels: 5, elevators: 1, escalators: 1 } : null))} />
        {t('二楼百货区')}
      </label>
      {p.secondFloor && (
        <>
          <NumberField label="二楼通道" value={p.secondFloor.gmAisles} range={L.secondFloorGmAisles} onChange={(v) => patch((d) => d.secondFloor && (d.secondFloor.gmAisles = v))} />
          <NumberField label="二楼段数" value={p.secondFloor.bays} range={L.bays} onChange={(v) => patch((d) => d.secondFloor && (d.secondFloor.bays = v))} />
          <NumberField label="电梯" value={p.secondFloor.elevators ?? 1} range={L.elevators} onChange={(v) => patch((d) => d.secondFloor && (d.secondFloor.elevators = v))} />
          <NumberField label="扶梯组数" value={p.secondFloor.escalators ?? 0} range={L.escalators} onChange={(v) => patch((d) => d.secondFloor && (d.secondFloor.escalators = v))} />
          <p className="hint">{t('二楼通道填 0 表示按货梯的位置自动铺满二楼（二楼从左墙盖到货梯旁的卸货区，一楼其余部分是单层）。电梯依次放在左前、左后、右前；扶梯（每组上下各一条）在前走廊靠近顾客入口。员工推着拣货车只能乘电梯。')}</p>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={!!p.autoService} onChange={(e) => patch((d) => (d.autoService = e.target.checked ? { side: 'LEFT', oilBays: 2, tireBays: 2 } : null))} />
        {t('汽车服务中心（换机油、换轮胎）')}
      </label>
      {p.autoService && (
        <>
          <label>
            <span>{t('位置')}</span>
            <select value={p.autoService.side} onChange={(e) => patch((d) => d.autoService && (d.autoService.side = e.target.value as 'LEFT' | 'RIGHT'))}>
              <option value="LEFT">{t('门店左侧')}</option>
              <option value="RIGHT">{t('门店右侧')}</option>
            </select>
          </label>
          <NumberField label="机油工位" value={p.autoService.oilBays} range={L.serviceBays} onChange={(v) => patch((d) => d.autoService && (d.autoService.oilBays = v))} />
          <NumberField label="轮胎工位" value={p.autoService.tireBays} range={L.serviceBays} onChange={(v) => patch((d) => d.autoService && (d.autoService.tireBays = v))} />
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={!!p.garden} onChange={(e) => patch((d) => (d.garden = e.target.checked ? { side: d.autoService?.side === 'LEFT' ? 'RIGHT' : 'LEFT' } : null))} />
        {t(p.garden ? (p.garden.side === 'LEFT' ? '园艺中心（门店左侧的露天卖场）' : '园艺中心（门店右侧的露天卖场）') : '园艺中心（门店另一侧的露天卖场）')}
      </label>
      <label className="check">
        <input type="checkbox" checked={!!p.pharmacy} onChange={(e) => patch((d) => (d.pharmacy = e.target.checked ? { counters: 2 } : null))} />
        {t('店内药房')}
      </label>
      {p.pharmacy && <NumberField label="药房柜台" value={p.pharmacy.counters} range={[1, 4]} onChange={(v) => patch((d) => d.pharmacy && (d.pharmacy.counters = v))} />}
      <NumberField label="后仓加深" value={p.backroom?.extraDepthM ?? 0} range={L.extraDepth} onChange={(v) => patch((d) => (d.backroom = { ...(d.backroom ?? DEFAULT_BACKROOM), extraDepthM: v }))} />
      <NumberField label="货架层数" value={p.backroom?.rackLevels ?? 3} range={L.rackLevels} onChange={(v) => patch((d) => (d.backroom = { ...(d.backroom ?? DEFAULT_BACKROOM), rackLevels: v }))} />
      <NumberField label="卸货门" value={p.backroom?.docks ?? 3} range={L.docks} onChange={(v) => patch((d) => (d.backroom = { ...(d.backroom ?? DEFAULT_BACKROOM), docks: v }))} />
      <NumberField label="叉车" value={p.backroom?.forklifts ?? 1} range={L.forklifts} onChange={(v) => patch((d) => (d.backroom = { ...(d.backroom ?? DEFAULT_BACKROOM), forklifts: v }))} />
      <NumberField label="搬运车" value={p.backroom?.palletJacks ?? 2} range={L.palletJacks} onChange={(v) => patch((d) => (d.backroom = { ...(d.backroom ?? DEFAULT_BACKROOM), palletJacks: v }))} />
      <YardFields value={p.yard ?? DEFAULT_YARD} onChange={(v) => patch((d) => (d.yard = { ...(d.yard ?? DEFAULT_YARD), ...v }))} />
      <label>
        <span>{t('营业时间')}</span>
        <span className="inline">
          <HourSelect value={(p.hours?.openMin ?? 420) / 60} range={L.openHour} onChange={(h) => patch((d) => (d.hours = { openMin: h * 60, closeMin: d.hours?.closeMin ?? 1320 }))} />
          <span className="muted">{t('至')}</span>
          <HourSelect value={(p.hours?.closeMin ?? 1320) / 60} range={L.closeHour} onChange={(h) => patch((d) => (d.hours = { openMin: d.hours?.openMin ?? 420, closeMin: h * 60 }))} />
        </span>
      </label>
      <NumberField label="停车排数" value={p.parking?.rows ?? 0} range={L.parkingRows} onChange={(v) => patch((d) => (d.parking = { rows: v, pickupBays: d.parking?.pickupBays ?? 0 }))} />
      <NumberField label="取货车位" value={p.parking?.pickupBays ?? 0} range={L.pickupBays} onChange={(v) => patch((d) => (d.parking = { rows: d.parking?.rows ?? 0, pickupBays: v }))} />
      <NumberField label="人员倍数" value={p.staffScale ?? 1} range={L.staffScale} step={0.1} onChange={(v) => patch((d) => (d.staffScale = Math.round(v * 10) / 10))} />
      <p className="hint">{t('停车排数和取货车位填 0 表示按门店宽度自动确定。日订单量和各岗位人数按门店规模自动匹配，「人员倍数」在此基础上再放大或缩小。')}</p>
      <div className="row">
        <button className="primary" onClick={() => apply(p)}>
          {t('生成并应用')}
        </button>
      </div>
      {msg && <p className="hint">{msg}</p>}
      <p className="hint">{t('生成会替换当前布局（可以撤销）。需求量和默认排班按门店规模自动匹配；周边道路会随停车场大小重新排布。')}</p>
    </details>
  );
}
