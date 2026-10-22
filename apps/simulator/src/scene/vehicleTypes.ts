/** 车型、车长与颜色分布（不依赖 three.js，背景车流和停车记录也用） */

export type VehicleType = 'sedan' | 'hatch' | 'suv' | 'pickup' | 'van' | 'truck' | 'semi';
export const VEHICLE_TYPES: VehicleType[] = ['sedan', 'hatch', 'suv', 'pickup', 'van', 'truck', 'semi'];

export const VEHICLE_LENGTH: Record<VehicleType, number> = { sedan: 4.7, hatch: 4.1, suv: 4.8, pickup: 5.5, van: 5.6, truck: 7.6, semi: 20 };

/**
 * 车身颜色按常见的乘用车颜色分布抽取（白、黑、灰、银占大多数），
 * 让停车场看起来像真实的停车场，而不是一盒彩色积木。
 */
const CAR_COLORS: Array<[string, number]> = [
  ['#f4f4f2', 0.24],
  ['#26282b', 0.2],
  ['#7b8188', 0.17],
  ['#bfc4c8', 0.11],
  ['#2f4f7f', 0.09],
  ['#a3262a', 0.08],
  ['#3f5a46', 0.03],
  ['#c9b48f', 0.03],
  ['#d4782f', 0.02],
  ['#5a3b5f', 0.01],
  ['#e0c341', 0.02],
];

export function carColor(u: number): string {
  let acc = 0;
  for (const [c, p] of CAR_COLORS) {
    acc += p;
    if (u < acc) return c;
  }
  return (CAR_COLORS[0] as [string, number])[0];
}

/** 私家车车型分布 */
export function carType(u: number): VehicleType {
  if (u < 0.36) return 'suv';
  if (u < 0.66) return 'sedan';
  if (u < 0.82) return 'hatch';
  if (u < 0.95) return 'pickup';
  return 'van';
}

/** 道路上的车流还会有一些厢式货车 */
export function trafficType(u: number, truckShare: number): VehicleType {
  if (u < truckShare) return 'truck';
  return carType((u - truckShare) / (1 - truckShare));
}
