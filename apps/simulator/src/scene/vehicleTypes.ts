/** 车型、车长与颜色分布（不依赖 three.js，背景车流和停车记录也用） */

export type VehicleType = 'sedan' | 'hatch' | 'suv' | 'pickup' | 'van' | 'truck' | 'semi' | 'rv';
export const VEHICLE_TYPES: VehicleType[] = ['sedan', 'hatch', 'suv', 'pickup', 'van', 'truck', 'semi', 'rv'];

/** 半挂车的尺寸（米）：牵引销到牵引车车头、到 53 英尺挂车车尾、到挂车串联轴中心；车身中心在牵引销前方 center 处的反方向 */
export const SEMI = { kingpinToFront: 6.4, kingpinToRear: 15.25, kingpinToAxle: 12.2, center: 4.4 } as const;

/** 车长（米，按常见车型的公开尺寸）；半挂车是牵引车 + 53 英尺挂车的总长 */
export const VEHICLE_LENGTH: Record<VehicleType, number> = { sedan: 4.85, hatch: 4.3, suv: 4.62, pickup: 5.88, van: 5.93, truck: 7.6, semi: 21.65, rv: 11.2 };

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

/** 道路上的车流还会有一些厢式货车；主路（过境道路）上还有长途半挂车和房车 */
export function trafficType(u: number, truckShare: number, highway = false): VehicleType {
  let v = u;
  if (highway) {
    if (v < 0.025) return 'semi';
    if (v < 0.033) return 'rv';
    v = (v - 0.033) / 0.967;
  }
  if (v < truckShare) return 'truck';
  return carType((v - truckShare) / (1 - truckShare));
}

/** 房车的车身颜色：白色、米色、浅灰为主 */
export function rvColor(u: number): string {
  return (['#f3f1ea', '#ece4d2', '#e4e6e3', '#f5f5f2', '#d9d2c0'] as const)[Math.min(4, Math.floor(u * 5))] as string;
}
