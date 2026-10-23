import { StoreConfigSchema, type StoreConfig } from './schema';
import { StoreModel } from './model';
import { runSpan, shelfRect, stagingArea } from './editing';
import { AREA_KINDS, backroomFrame, rectsOverlap } from './areas';

/*
 * 门店配置的完整校验（结构 + 语义）。单独成一个入口（@storewright/store-config/validate）：
 * 结构校验用到 zod，浏览器里的门店中枢只在访客提交自己的门店时才需要，可以按需加载（决策记录 0015）。
 */

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * 解析并校验门店配置：先做结构校验（zod），再做语义校验
 * （ID 唯一、类别存在、楼层存在、所有货位都能从暂存点走到）。
 */
export function validateStoreConfig(input: unknown): { ok: true; config: StoreConfig; model: StoreModel } | { ok: false; issues: ConfigIssue[] } {
  const parsed = StoreConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const config = parsed.data;
  const issues: ConfigIssue[] = [];
  const floorIds = new Set(config.layout.floors.map((f) => f.id));
  const categoryIds = new Set(config.catalog.categories.map((c) => c.id));

  const dupes = (ids: string[], path: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push({ path, message: `重复的 ID：${id}` });
      seen.add(id);
    }
  };
  dupes(config.layout.runs.map((r) => r.id), 'layout.runs');
  dupes(config.catalog.categories.map((c) => c.id), 'catalog.categories');
  dupes(config.staging.racks.map((r) => r.id), 'staging.racks');

  config.layout.runs.forEach((run, i) => {
    if (!floorIds.has(run.floorId)) issues.push({ path: `layout.runs.${i}.floorId`, message: `楼层不存在：${run.floorId}` });
    for (const c of run.categoryIds) {
      if (!categoryIds.has(c)) issues.push({ path: `layout.runs.${i}.categoryIds`, message: `类别不存在：${c}` });
    }
  });
  if (issues.length) return { ok: false, issues };

  // 货架重叠：同一楼层平行的通道，中线间距小于两侧货架所需宽度
  const SHELF_EXTENT = 1.5; // 通道半宽 0.6 m + 货架进深 0.9 m
  const runs = config.layout.runs;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i] as (typeof runs)[number];
      const b = runs[j] as (typeof runs)[number];
      if (a.floorId !== b.floorId) continue;
      const av = Math.abs(a.end.x - a.start.x) < 1e-6;
      const bv = Math.abs(b.end.x - b.start.x) < 1e-6;
      const ah = Math.abs(a.end.y - a.start.y) < 1e-6;
      const bh = Math.abs(b.end.y - b.start.y) < 1e-6;
      const span = (p: number, q: number, r: number, s: number) => Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s));
      let gap: number | undefined;
      if (av && bv && span(a.start.y, a.end.y, b.start.y, b.end.y) > 1) gap = Math.abs(a.start.x - b.start.x);
      if (ah && bh && span(a.start.x, a.end.x, b.start.x, b.end.x) > 1) gap = Math.abs(a.start.y - b.start.y);
      if (gap === undefined) continue;
      const need = (a.sides === 2 ? SHELF_EXTENT : 0) + (b.sides === 2 ? SHELF_EXTENT : 0) || SHELF_EXTENT;
      if (gap < need - 1e-6) issues.push({ path: 'layout.runs', message: `货架重叠：${a.label ?? a.id} 与 ${b.label ?? b.id} 的中线只相距 ${gap.toFixed(1)} 米（至少需要 ${need.toFixed(1)} 米）` });
    }
  }

  // 横竖通道交叉：交点同时落在两条通道的货架段里（端点处的丁字路口不算）
  for (const a of runs) {
    const sa = runSpan(a);
    if (sa.axis !== 'V') continue;
    for (const b of runs) {
      if (b.floorId !== a.floorId) continue;
      const sb = runSpan(b);
      if (sb.axis !== 'H') continue;
      const ma = Math.min(a.endMarginM, (sa.b - sa.a) / 4);
      const mb = Math.min(b.endMarginM, (sb.b - sb.a) / 4);
      if (sb.c > sa.a + ma + 0.05 && sb.c < sa.b - ma - 0.05 && sa.c > sb.a + mb + 0.05 && sa.c < sb.b - mb - 0.05) {
        issues.push({ path: 'layout.runs', message: `货架交叉：${a.label ?? a.id} 与 ${b.label ?? b.id}` });
      }
    }
  }

  // 通道超出楼层范围
  const floorById = new Map(config.layout.floors.map((f) => [f.id, f]));
  for (const r of runs) {
    const f = floorById.get(r.floorId);
    if (!f) continue;
    const out = [r.start, r.end].some((p) => p.x < -0.5 || p.y < -0.5 || p.x > f.widthM + 0.5 || p.y > f.depthM + 0.5);
    if (out) issues.push({ path: 'layout.runs', message: `${r.label ?? r.id} 超出了 ${f.name} 的范围（${f.widthM.toFixed(0)} × ${f.depthM.toFixed(0)} 米）` });
  }

  // 线上订单暂存区不能压在货架上
  const st = stagingArea(config);
  if (st) {
    for (const r of runs) {
      if (r.floorId !== config.layout.points.staging.floorId) continue;
      const rc = shelfRect(r);
      if (rc && rc.x0 < st.x1 - 0.05 && rc.x1 > st.x0 + 0.05 && rc.y0 < st.y1 - 0.05 && rc.y1 > st.y0 + 0.05) {
        issues.push({ path: 'layout.points.staging', message: `线上订单暂存区与 ${r.label ?? r.id} 的货架重叠` });
      }
    }
  }

  // 区域与卸货门（决策记录 0013）：只校验明确给出的部分
  if (config.areas) {
    const areas = config.areas.map((a) => ({ ...a, x0: Math.min(a.x0, a.x1), x1: Math.max(a.x0, a.x1), z0: Math.min(a.z0, a.z1), z1: Math.max(a.z0, a.z1) }));
    dupes(areas.map((a) => a.id), 'areas');
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i] as (typeof areas)[number];
      const f = floorById.get(a.floorId);
      if (!f) {
        issues.push({ path: `areas.${i}.floorId`, message: `楼层不存在：${a.floorId}` });
        continue;
      }
      if (a.x1 - a.x0 < 1 || a.z1 - a.z0 < 1) issues.push({ path: `areas.${i}`, message: `区域 ${a.id} 太小（至少 1 × 1 米）` });
      // 收货和后仓存储在建筑里；暂存区可以伸到建筑外侧（暂存仓）
      if (AREA_KINDS[a.kind].group !== 'STAGING' && (a.x0 < -0.5 || a.z0 < -0.5 || a.x1 > f.widthM + 0.5 || a.z1 > f.depthM + 0.5)) issues.push({ path: `areas.${i}`, message: `${a.id} 超出了 ${f.name} 的范围（${f.widthM.toFixed(0)} × ${f.depthM.toFixed(0)} 米）` });
      for (let j = i + 1; j < areas.length; j++) {
        const b = areas[j] as (typeof areas)[number];
        if (b.floorId === a.floorId && rectsOverlap(a, b)) issues.push({ path: `areas.${i}`, message: `区域重叠：${a.id} 与 ${b.id}` });
      }
      for (const r of runs) {
        if (r.floorId !== a.floorId) continue;
        const rc = shelfRect(r);
        if (rc && rectsOverlap(a, { x0: rc.x0, x1: rc.x1, z0: rc.y0, z1: rc.y1 })) issues.push({ path: `areas.${i}`, message: `区域 ${a.id} 压在 ${r.label ?? r.id} 的货架上` });
      }
    }
    if (!areas.some((a) => a.kind === 'RACKS')) issues.push({ path: 'areas', message: '后仓至少需要一个托盘货架区' });
    if (!areas.some((a) => a.kind === 'UNLOAD')) issues.push({ path: 'areas', message: '收货至少需要一个卸货区' });
    const stagingIds = new Set(areas.filter((a) => AREA_KINDS[a.kind].group === 'STAGING').map((a) => a.id));
    for (const r of config.staging.racks) if (r.areaId && !stagingIds.has(r.areaId)) issues.push({ path: 'staging.racks', message: `暂存货架 ${r.id} 所在的区域不存在：${r.areaId}` });
  }
  if (config.docks) {
    const frame = backroomFrame(config);
    dupes(config.docks.map((d) => d.id), 'docks');
    if (!config.docks.length) issues.push({ path: 'docks', message: '至少需要一个卸货门' });
    const sorted = [...config.docks].sort((a, b) => a.x - b.x);
    sorted.forEach((d, i) => {
      if (d.x < 1.5 || d.x > frame.width - 1.5) issues.push({ path: 'docks', message: `卸货门 ${d.id} 不在后墙范围内` });
      const next = sorted[i + 1];
      if (next && next.x - d.x < 4) issues.push({ path: 'docks', message: `卸货门 ${d.id} 与 ${next.id} 相距不到 4 米` });
    });
  }
  if (config.parking?.pickupBays) dupes(config.parking.pickupBays.map((b) => b.id), 'parking.pickupBays');

  // 附属设施：每侧最多一个，至少一个工位，营业时间有效
  const sides = new Set<string>();
  let pharmacies = 0;
  config.facilities.forEach((f, i) => {
    if (f.kind === 'PHARMACY') {
      if (++pharmacies > 1) issues.push({ path: `facilities.${i}`, message: '一家门店只能有一个药房' });
    } else {
      if (sides.has(f.side)) issues.push({ path: `facilities.${i}.side`, message: `门店${f.side === 'LEFT' ? '左' : '右'}侧已经有一个附属设施` });
      sides.add(f.side);
    }
    if (f.kind === 'AUTO_SERVICE' && f.oilBays + f.tireBays === 0) issues.push({ path: `facilities.${i}`, message: `${f.name} 至少需要一个工位` });
    if (f.kind !== 'GARDEN_CENTER' && f.hours.openMin >= f.hours.closeMin) issues.push({ path: `facilities.${i}.hours`, message: `${f.name} 的营业时间无效` });
  });

  const model = new StoreModel(config);
  // 电梯 / 扶梯的两端必须落在通道或走廊上，否则无法到达
  for (const c of config.layout.connectors) {
    const ends = model.connectorNodes.get(c.id);
    if (!ends) continue;
    for (const [k, node] of ends.entries()) {
      const other = ends[1 - k];
      const walkable = (model.adjacency[node] ?? []).some((e) => e.to !== other);
      if (!walkable) issues.push({ path: `layout.connectors`, message: `${c.kind === 'ESCALATOR' ? '扶梯' : '电梯'} ${c.id} 的${k === 0 ? '下' : '上'}端不在任何通道或走廊上` });
    }
  }
  const unreachable = model.unreachableLocations();
  if (unreachable.length) {
    issues.push({ path: 'layout', message: `有 ${unreachable.length} 个货位无法从暂存点走到，例如 ${unreachable.slice(0, 3).join(', ')}` });
  }
  const slotCodes = new Set<string>();
  for (const s of model.stagingSlots) {
    if (slotCodes.has(s.code)) issues.push({ path: 'staging', message: `暂存格位编码重复：${s.code}（检查编码规则）` });
    slotCodes.add(s.code);
  }
  return issues.length ? { ok: false, issues } : { ok: true, config, model };
}
