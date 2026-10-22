import { createRng, hashString, type FulfillmentType, type Handling, type Item, type Rng } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';
import { CATEGORY_PROFILES, fallbackProfile, type Archetype } from './archetypes';

/** Walker 别名表：O(1) 按权重抽样 */
export class AliasSampler<T> {
  private readonly prob: Float64Array;
  private readonly alias: Int32Array;

  constructor(readonly items: readonly T[], weights: readonly number[]) {
    const n = items.length;
    if (n === 0) throw new Error('AliasSampler needs at least one item');
    this.prob = new Float64Array(n);
    this.alias = new Int32Array(n);
    const total = weights.reduce((a, b) => a + b, 0);
    const scaled = weights.map((w) => (w * n) / total);
    const small: number[] = [];
    const large: number[] = [];
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
    while (small.length && large.length) {
      const s = small.pop() as number;
      const l = large.pop() as number;
      this.prob[s] = scaled[s] as number;
      this.alias[s] = l;
      scaled[l] = (scaled[l] as number) + (scaled[s] as number) - 1;
      ((scaled[l] as number) < 1 ? small : large).push(l);
    }
    for (const i of [...small, ...large]) this.prob[i] = 1;
  }

  sample(rng: Rng): T {
    const i = Math.floor(rng.next() * this.items.length);
    const pick = rng.next() < (this.prob[i] as number) ? i : (this.alias[i] as number);
    return this.items[pick] as T;
  }
}

export interface Catalog {
  items: Item[];
  byId: Map<string, Item>;
  samplers: Partial<Record<FulfillmentType, AliasSampler<Item>>>;
}

const BRANDS = ['Northfield', 'Bright Acre', 'Copper Lane', 'Harbor & Pine', 'Meadowline', 'Blue Ridge', 'Daily Table', 'Summit', 'Greenway', 'Old Mill', 'Kestrel', 'Fairharbor'];

function upcFromNumber(n: number): string {
  const body = String(n % 1e11).padStart(11, '0');
  const digits = body.split('').map(Number);
  const odd = digits.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const even = digits.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0);
  return body + String((10 - ((odd * 3 + even) % 10)) % 10);
}

export const DEFAULT_SKU_COUNT = { small: 1200, medium: 3000, large: 6000, hardware: 2400, custom: 3000 } as const;

/**
 * 生成合成商品目录，并把每个商品放到服务其类别的货架通道上。
 * 同一个种子永远生成同一个目录。
 */
export function generateCatalog(model: StoreModel, options: { seed: number; skuCount?: number }): Catalog {
  const rng = createRng(options.seed);
  const skuCount = options.skuCount ?? DEFAULT_SKU_COUNT[model.config.template];
  const categories = model.config.catalog.categories.filter((c) => model.runIdsForCategory(c.id).length > 0);
  const profiles = categories.map((c) => CATEGORY_PROFILES[c.id] ?? fallbackProfile(c.tempZone));
  const totalSkuShare = profiles.reduce((a, p) => a + p.skuShare, 0);
  const totalDemand = profiles.reduce((a, p) => a + p.demandShare, 0);

  const items: Item[] = [];
  let serial = 0;
  const nonFood = model.config.industry === 'HARDWARE';
  categories.forEach((cat, ci) => {
    const profile = profiles[ci] as (typeof profiles)[number];
    const count = Math.max(3, Math.round((skuCount * profile.skuShare) / totalSkuShare));
    const runIds = model.runIdsForCategory(cat.id);
    const zipf = Array.from({ length: count }, (_, k) => 1 / Math.pow(k + 1, 0.9));
    const zipfSum = zipf.reduce((a, b) => a + b, 0);
    const archetypeWeights = profile.archetypes.map((a) => a.weight);

    for (let k = 0; k < count; k++) {
      const arch = profile.archetypes[rng.weightedIndex(archetypeWeights)] as Archetype;
      const brand = rng.pick(BRANDS);
      const flavor = arch.flavors ? rng.pick(arch.flavors) : undefined;
      const size = arch.sizes ? rng.pick(arch.sizes) : undefined;
      const vary = () => rng.uniform(0.92, 1.08);
      const dims = { l: round1(arch.dims[0] * vary()), w: round1(arch.dims[1] * vary()), h: round1(arch.dims[2] * vary()) };
      const handling = Array.from(new Set<Handling>([...(cat.handling as Handling[]), ...(arch.handling ?? [])]));
      const fragile = handling.includes('FRAGILE');
      const runId = rng.pick(runIds);
      const locs = model.locationsByRun.get(runId) ?? [];
      const primary = rng.pick(locs);
      const locationIds = [primary.id];
      if (rng.chance(0.08)) {
        const other = model.locationsByRun.get(rng.pick(runIds)) ?? [];
        const second = rng.pick(other);
        if (second.id !== primary.id) locationIds.push(second.id);
      }
      const id = `SKU-${String(++serial).padStart(5, '0')}`;
      const food = !nonFood && cat.fulfillmentType === 'GROCERY' && !handling.includes('CHEMICAL');
      items.push({
        id,
        gtin: upcFromNumber(hashString(id) * 7 + serial),
        name: [brand, arch.stem, flavor, size].filter(Boolean).join(' '),
        categoryId: cat.id,
        tempZone: cat.tempZone,
        handling,
        fulfillmentType: cat.fulfillmentType,
        dims,
        weightKg: round3(rng.uniform(arch.kg[0], arch.kg[1])),
        crushClass: fragile ? 3 : (cat.crushClass as Item['crushClass']),
        pricing: arch.pricing ?? 'EACH',
        unitPrice: Math.round(rng.uniform(arch.price[0], arch.price[1]) * 100) / 100,
        attributes: {
          brand,
          stem: arch.stem,
          ...(flavor ? { flavor } : {}),
          ...(size ? { size } : {}),
          ...(food ? { organic: rng.chance(0.12), glutenFree: rng.chance(0.08) } : {}),
        },
        locationIds,
        popularity: (profile.demandShare / totalDemand) * ((zipf[k] as number) / zipfSum),
        shelfAvailability: rng.uniform(profile.shelfAvailability[0], profile.shelfAvailability[1]),
        backroomAvailability: rng.uniform(profile.backroomAvailability[0], profile.backroomAvailability[1]),
        ...(nonFood ? { nonFood: true as const } : {}),
      });
    }
  });

  const byId = new Map(items.map((i) => [i.id, i]));
  const samplers: Catalog['samplers'] = {};
  for (const ft of ['GROCERY', 'GM'] as const) {
    const pool = items.filter((i) => i.fulfillmentType === ft);
    if (pool.length) samplers[ft] = new AliasSampler(pool, pool.map((i) => i.popularity));
  }
  return { items, byId, samplers };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
