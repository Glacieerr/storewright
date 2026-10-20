import { StoreConfigSchema, type StoreConfig } from './schema';
import { StoreModel } from './model';

export * from './schema';
export * from './model';
export * from './templates';

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

  const model = new StoreModel(config);
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
