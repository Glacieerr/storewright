import { VEHICLE_POSITIONS, type Order, type Trip, type VehiclePosition } from '@storewright/domain';

export interface TripCandidate {
  order: Order;
  totes: number;
  weightKg: number;
}

export interface TripOptions {
  maxOrders: number;
  /** 车辆可装框数（司机在司机端申报的车型决定） */
  vehicleTotes: number;
  vehicleMaxKg: number;
}

/** 车内位置分配顺序：框最多的订单放尾箱，其次后排，最少的放副驾 */
const PLACEMENT_ORDER: VehiclePosition[] = ['TRUNK', 'REAR_LEFT', 'REAR_RIGHT', 'FRONT_PASSENGER'];

/**
 * 组合配送行程（决策 D-01、D-07）：在订单暂存之后进行，不作为拣货输入（工程约束 EC-6）。
 * 按目的地相对门店的方位角扫描，依次装入行程，直到达到每趟最多单数或车辆容量。
 * 行程状态只到「已交给司机」为止（工程约束 EC-10）。
 */
export function composeTrips(candidates: readonly TripCandidate[], options: TripOptions, idPrefix = 'TR'): Trip[] {
  const maxOrders = Math.min(options.maxOrders, VEHICLE_POSITIONS.length);
  const sorted = [...candidates].sort((a, b) => {
    const pa = a.order.destinationKm ?? { x: 0, y: 0 };
    const pb = b.order.destinationKm ?? { x: 0, y: 0 };
    return Math.atan2(pa.y, pa.x) - Math.atan2(pb.y, pb.x) || a.order.id.localeCompare(b.order.id);
  });
  const trips: Trip[] = [];
  let current: TripCandidate[] = [];
  const flush = () => {
    if (!current.length) return;
    const ranked = [...current].sort((a, b) => b.totes - a.totes || a.order.id.localeCompare(b.order.id));
    const placements: Record<string, VehiclePosition> = {};
    ranked.forEach((c, i) => {
      placements[c.order.id] = PLACEMENT_ORDER[i] as VehiclePosition;
    });
    trips.push({
      id: `${idPrefix}${trips.length + 1}`,
      orderIds: current.map((c) => c.order.id),
      placements,
      totes: current.reduce((a, c) => a + c.totes, 0),
      weightKg: Math.round(current.reduce((a, c) => a + c.weightKg, 0) * 10) / 10,
    });
    current = [];
  };
  for (const c of sorted) {
    const totes = current.reduce((a, x) => a + x.totes, 0) + c.totes;
    const kg = current.reduce((a, x) => a + x.weightKg, 0) + c.weightKg;
    if (current.length >= maxOrders || (current.length > 0 && (totes > options.vehicleTotes || kg > options.vehicleMaxKg))) flush();
    current.push(c);
  }
  flush();
  return trips;
}
