import { firstMatch, volumeLiters, type Item, type Order, type OrderLine, type OversizedPiece, type TempZone, type ToteAssignment, type ToteLine } from '@storewright/domain';
import { fitsInside, type SizeClass, type SizeRule } from '@storewright/store-config';
import { getItem, type PlanningContext } from './context';

const ZONE_ORDER: Record<TempZone, number> = { AMBIENT: 0, CHILLED: 1, FROZEN: 2, HOT: 3 };

/** 按门店的大件规则对订单行分类（决策 GM-01） */
export function classifyLine(ctx: PlanningContext, order: Order, line: OrderLine): { sizeClass: SizeClass; ruleId?: string } {
  const item = getItem(ctx, line.itemId);
  const facts = {
    unitWeightKg: item.weightKg,
    lineWeightKg: item.weightKg * line.qty,
    fitsTote: fitsInside(item.dims, ctx.model.toteDims),
    fulfillmentType: order.fulfillmentType,
    categoryId: item.categoryId,
    tempZone: item.tempZone,
  };
  const { result, ruleId } = firstMatch(ctx.model.config.rules.sizeRules as SizeRule[], facts, 'STANDARD');
  return ruleId === undefined ? { sizeClass: result } : { sizeClass: result, ruleId };
}

export interface ToteAssignmentResult {
  totes: ToteAssignment[];
  oversized: OversizedPiece[];
}

interface OpenTote {
  lines: Map<string, ToteLine>;
  volumeL: number;
  weightKg: number;
}

/** 拣货截止时间：自取为时段起点，配送提前 deliveryReadyLeadMin */
export function dueAtFor(ctx: PlanningContext, order: Order): number {
  const lead = order.type === 'DELIVERY' ? ctx.model.config.rules.handoff.deliveryReadyLeadMin * 60 : 0;
  return order.slotStart - lead;
}

function splitOversized(ctx: PlanningContext, order: Order): { standard: OrderLine[]; oversized: OversizedPiece[] } {
  const standard: OrderLine[] = [];
  const oversized: OversizedPiece[] = [];
  for (const line of order.lines) {
    const { sizeClass } = classifyLine(ctx, order, line);
    if (sizeClass === 'STANDARD') {
      standard.push(line);
      continue;
    }
    const item = getItem(ctx, line.itemId);
    for (let i = 1; i <= line.qty; i++) {
      oversized.push({ id: `${line.lineId}-P${i}`, orderId: order.id, lineId: line.lineId, itemId: line.itemId, index: i, count: line.qty, teamLift: sizeClass === 'TEAM_LIFT', weightKg: item.weightKg });
    }
  }
  return { standard, oversized };
}

function groupKey(order: Order, item: Item): string {
  // 化学品与食品分开装框；非食品行业的商品没有这个要求（HAZMAT 始终单独装）
  const chemical = (item.handling.includes('CHEMICAL') && !item.nonFood) || item.handling.includes('HAZMAT');
  return `${item.tempZone}|${order.fulfillmentType}|${chemical ? 'C' : 'F'}`;
}

function finalize(order: Order, ctx: PlanningContext, groups: Array<{ key: string; totes: OpenTote[] }>): ToteAssignment[] {
  groups.sort((a, b) => {
    const [za, fa, ca] = a.key.split('|') as [TempZone, string, string];
    const [zb, fb, cb] = b.key.split('|') as [TempZone, string, string];
    return ZONE_ORDER[za] - ZONE_ORDER[zb] || fa.localeCompare(fb) || ca.localeCompare(cb);
  });
  const total = groups.reduce((n, g) => n + g.totes.length, 0);
  const out: ToteAssignment[] = [];
  let index = 0;
  const dueAt = dueAtFor(ctx, order);
  for (const g of groups) {
    const [zone, , chem] = g.key.split('|') as [TempZone, string, string];
    for (const t of g.totes) {
      index++;
      out.push({
        id: `${order.id}-T${index}`,
        orderId: order.id,
        tempZone: zone,
        fulfillmentType: order.fulfillmentType,
        chemical: chem === 'C',
        index,
        count: total,
        lines: [...t.lines.values()],
        volumeL: round2(t.volumeL),
        weightKg: round2(t.weightKg),
        slotStart: order.slotStart,
        dueAt,
      });
    }
  }
  return out;
}

/**
 * 分箱（工程约束 EC-1）：在每个履约段内单遍完成，不做框间交换。
 *
 * - 按「温区 × 履约类型 × 是否化学品」分段；化学品单独装框；
 * - 段内商品按压放等级从低到高（重物在下、易碎在上）、单件体积从大到小排序；
 * - 逐件放入第一个装得下的框（体积 ≤ 容积 × 装填系数，且重量 ≤ 上限），否则开新框；
 * - 单件本身就超过装填系数但物理上放得下时，允许独占一个空框；
 * - 一个框只属于一个订单。
 */
export function assignTotes(ctx: PlanningContext, order: Order, options: { fillFactor?: number } = {}): ToteAssignmentResult {
  const { standard, oversized } = splitOversized(ctx, order);
  const tote = ctx.model.config.equipment.tote;
  const capL = ctx.model.toteCapacityL * (options.fillFactor ?? tote.fillFactor);
  const maxKg = tote.maxWeightKg;

  const byGroup = new Map<string, OrderLine[]>();
  for (const line of standard) {
    const key = groupKey(order, getItem(ctx, line.itemId));
    const list = byGroup.get(key) ?? [];
    list.push(line);
    byGroup.set(key, list);
  }

  const groups: Array<{ key: string; totes: OpenTote[] }> = [];
  for (const [key, lines] of byGroup) {
    const sorted = [...lines].sort((a, b) => {
      const ia = getItem(ctx, a.itemId);
      const ib = getItem(ctx, b.itemId);
      return ia.crushClass - ib.crushClass || volumeLiters(ib.dims) - volumeLiters(ia.dims) || a.lineId.localeCompare(b.lineId);
    });
    const totes: OpenTote[] = [];
    for (const line of sorted) {
      const item = getItem(ctx, line.itemId);
      const v = volumeLiters(item.dims);
      for (let u = 0; u < line.qty; u++) {
        let target = totes.find((t) => t.volumeL + v <= capL && t.weightKg + item.weightKg <= maxKg);
        if (!target) {
          target = { lines: new Map(), volumeL: 0, weightKg: 0 };
          totes.push(target);
        }
        const existing = target.lines.get(line.lineId);
        if (existing) existing.qty++;
        else target.lines.set(line.lineId, { lineId: line.lineId, itemId: line.itemId, qty: 1 });
        target.volumeL += v;
        target.weightKg += item.weightKg;
      }
    }
    groups.push({ key, totes });
  }
  return { totes: finalize(order, ctx, groups), oversized };
}

/**
 * 基线分箱：代表「凭目测装框」的通用做法。
 * - 按温区分框，按订单行的原始顺序逐件放入，装到目测上限（默认物理容积的 85%）就换新框；
 * - 不检查重量、不单独装化学品、不按压放等级排序（重物可能压在易碎品上）；
 * - 只有物理上放不进框的商品才作为大件处理。
 */
export function assignTotesByEye(ctx: PlanningContext, order: Order, eyeFill = 0.85): ToteAssignmentResult {
  const standard: OrderLine[] = [];
  const oversized: OversizedPiece[] = [];
  for (const line of order.lines) {
    const item = getItem(ctx, line.itemId);
    if (!fitsInside(item.dims, ctx.model.toteDims)) {
      for (let i = 1; i <= line.qty; i++) {
        oversized.push({ id: `${line.lineId}-P${i}`, orderId: order.id, lineId: line.lineId, itemId: line.itemId, index: i, count: line.qty, teamLift: item.weightKg > 22.68, weightKg: item.weightKg });
      }
    } else standard.push(line);
  }
  const capL = ctx.model.toteCapacityL * eyeFill;
  const byZone = new Map<string, OrderLine[]>();
  for (const line of standard) {
    const item = getItem(ctx, line.itemId);
    const key = `${item.tempZone}|${order.fulfillmentType}|F`;
    const list = byZone.get(key) ?? [];
    list.push(line);
    byZone.set(key, list);
  }
  const groups: Array<{ key: string; totes: OpenTote[] }> = [];
  for (const [key, lines] of byZone) {
    const totes: OpenTote[] = [];
    let current: OpenTote | undefined;
    for (const line of lines) {
      const item = getItem(ctx, line.itemId);
      const v = volumeLiters(item.dims);
      for (let u = 0; u < line.qty; u++) {
        if (!current || (current.volumeL > 0 && current.volumeL + v > capL)) {
          current = { lines: new Map(), volumeL: 0, weightKg: 0 };
          totes.push(current);
        }
        const existing = current.lines.get(line.lineId);
        if (existing) existing.qty++;
        else current.lines.set(line.lineId, { lineId: line.lineId, itemId: line.itemId, qty: 1 });
        current.volumeL += v;
        current.weightKg += item.weightKg;
      }
    }
    groups.push({ key, totes });
  }
  return { totes: finalize(order, ctx, groups), oversized };
}

/**
 * 压坏风险：框内按装入顺序，易碎品（压放等级 3）之后又装入了重物（单件 ≥ 1.5 kg 且压放等级 ≤ 1）。
 */
export function hasCrushRisk(ctx: PlanningContext, tote: ToteAssignment): boolean {
  let fragileSeen = false;
  for (const l of tote.lines) {
    const item = getItem(ctx, l.itemId);
    if (item.crushClass === 3) fragileSeen = true;
    else if (fragileSeen && item.crushClass <= 1 && item.weightKg >= 1.5) return true;
  }
  return false;
}

/** 化学品与食品混装 */
export function mixesChemicalWithFood(ctx: PlanningContext, tote: ToteAssignment): boolean {
  let chem = false;
  let food = false;
  for (const l of tote.lines) {
    const item = getItem(ctx, l.itemId);
    if (item.handling.includes('CHEMICAL') || item.handling.includes('HAZMAT')) chem = true;
    else if (item.fulfillmentType === 'GROCERY' && !item.nonFood) food = true;
  }
  return chem && food;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
