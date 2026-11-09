/**
 * 仿真的地点 → 门、停靠位（纯数据，不依赖 three.js）：网页的三维（区域车辆、物流园的场地、门店收货场）和孪生服务按同一份对应，
 * 两边排出来的物流园、门店收货场的作业计划一样，值班助手的回答也一样。
 *
 * - 配送中心（DC）：调度台给每趟车指定的门（D01… 常温门、C01… 冷链门）→ 停靠位 DC#0…、DCC#0…（D04 = DC#3、C02 = DCC#1）；
 * - 门店：调度台排的收货口下标（0 起）→ 停靠位「店的键」（0 号口）、「店的键#2」…（和门店收货场登记的门编号一样）。
 */

/** 调度台的门（D04、C02）→ 配送中心的停靠位（DC#3、DCC#1）；没有门返回 undefined */
export function doorPlace(door: string | undefined): string | undefined {
  if (!door) return undefined;
  const n = Number(door.slice(1)) - 1;
  return door.startsWith('C') ? `DCC#${n}` : `DC#${n}`;
}

/** 调度台一趟作业里用到的几项：哪辆仿真车、配送中心的门、各个门店的收货口下标 */
export interface DoorOp {
  vehicle: number;
  door?: string;
  docks?: Readonly<Record<string, number>>;
}

/**
 * 按调度台的作业排出「仿真车 vid 到地点 key 停哪个位」：配送中心按指定的门，门店按收货口（0 号口不写编号，用地点本身）。
 * 物流园的计划（planPark 的 doorOf）、门店收货场（storeTruckVisits 的 resolve）都用它。
 */
export function placeResolver(ops: readonly DoorOp[]): (vehicle: number, key: string) => string | undefined {
  const byVehicle = new Map(ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o] as const));
  return (vehicle, key) => {
    const o = byVehicle.get(vehicle);
    if (key === 'DC') return doorPlace(o?.door);
    const k = o?.docks?.[key];
    return k ? `${key}#${k + 1}` : undefined;
  };
}
