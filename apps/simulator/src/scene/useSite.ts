import { useApp } from '../state/store';
import type { StoreGeometry } from './layout';
import { generateSite, type SiteLayout, type SiteSettings } from './site';
import { generateStays, type Stay } from './shoppers';
import { OVERFLOW_RESERVE } from './lot';

let cache: { key: string; site: SiteLayout } | undefined;

/** 按停车场外轮廓和周边设置（风格、种子、地块、施工）缓存周边环境；布局小改动不会让车流重置 */
export function siteFor(geo: StoreGeometry, settings: SiteSettings): SiteLayout {
  const f0 = geo.floors[0];
  const key = [geo.lot.minX, geo.lot.maxX, geo.lot.edgeZ, f0?.maxZ ?? 0, settings.style, settings.seed, settings.layout ?? 'auto', settings.roadWorks ? 1 : 0].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).join('|');
  if (cache?.key !== key) {
    const store = { minX: f0?.minX ?? 0, maxX: f0?.maxX ?? 0, minZ: f0?.minZ ?? 0, maxZ: f0?.maxZ ?? 0 };
    cache = { key, site: generateSite({ lot: geo.lot, store, settings: { ...settings, traffic: 0 } }) };
  }
  return cache.site;
}

export function useSiteLayout(): SiteLayout {
  const geo = useApp((s) => s.simGeo);
  const site = useApp((s) => s.site);
  return siteFor(geo, site);
}

// 「多变」天气按全天平均估计（偶有阵雨）
const WEATHER_FOOTFALL: Record<string, number> = { rain: 0.8, snow: 0.6, fog: 0.9, dynamic: 0.92 };

let stayCache: { geo: StoreGeometry; seed: number; busyness: number; hours: string; stays: Stay[][] } | undefined;

/** 停车场里购物顾客和员工的停车时段（车辆和进店的顾客共用同一份） */
export function useStays(): Stay[][] {
  const geo = useApp((s) => s.simGeo);
  const seed = useApp((s) => s.site.seed);
  // 雨雪天到店购物的人更少（线上订单反而增加，见仿真）
  const busyness = useApp((s) => s.demandFactor * (WEATHER_FOOTFALL[s.site.weather ?? 'clear'] ?? 1));
  const hours = useApp((s) => s.simModel.config.hours);
  const hk = `${hours.openMin}-${hours.closeMin}`;
  if (stayCache?.geo !== geo || stayCache.seed !== seed || stayCache.busyness !== busyness || stayCache.hours !== hk) {
    const excluded = new Set(geo.facilities.flatMap((f) => f.waitingSpots));
    stayCache = { geo, seed, busyness, hours: hk, stays: generateStays({ lot: geo.lot, seed, reserve: OVERFLOW_RESERVE, busyness, excluded, hours }) };
  }
  return stayCache.stays;
}
