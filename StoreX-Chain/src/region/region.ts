import { identityFrame, kmToWorld, type Frame } from './frames';
import type { RegionPlan } from './regionGen';

/**
 * 区域地理：一个虚构的滨海都市圈。坐标单位是公里（x 向东、y 向北，市中心在原点）。
 *
 * 整个区域由区域生成器生成（regionGen.ts）：海岸线、河流、城区和干道网、高架、绕城快速路、高速、铁路、门店的位置，
 * 港口、机场、物流园放在哪里、朝哪个方向。默认区域里港口在西南海岸、机场在东南、物流园在东北，
 * 北面的高速出口通往国内供应商和内陆产区，东面的出口通往跨境（洲际）公路，铁路也往东接洲际班列。
 *
 * 这里放的是「当前区域」的数据：各模块引用这些对象，换区域时原地改（applyRegionPlan），引用它们的地方不用换。
 * 仿真用真实的公里数和车速算时间；三维场景用「沙盘坐标」（米）：公里 × 100，建筑按真实尺寸画。
 */
export interface Km {
  x: number;
  y: number;
}

export type RoadClass = 'highway' | 'ring' | 'arterial' | 'local';

export interface RoadNode {
  id: string;
  km: Km;
}

export interface RoadEdge {
  a: string;
  b: string;
  cls: RoadClass;
  /** 真实里程（公里） */
  km: number;
  /** 沙盘上的折线（公里坐标，画图时乘 100），从 a 到 b */
  pts: Km[];
}

/** 沙盘比例：1 公里画成 100 米 */
export const DIORAMA_SCALE = 100;

/**
 * 港口、机场在它们自己的局部坐标里的位置（就是原来摆在湾区里的位置）：船和飞机的航线按这些点算，再换到区域里。
 * 自己货物那条班轮的泊位在码头东段（船身沿码头、船首朝局部 +x），港外锚地是港口拥堵时等泊位的地方；跑道沿局部 x（局部 z 1285、x 1080–3180，2.1 公里），从 +x 一侧进近、往 −x 降落和起飞。
 */
export const LOCAL_SEA_BERTH: Km = { x: -19.9, y: -14.57 };
/**
 * 班轮进出港的航线，和港口里别家的船走同一套航道（和码头法线成 20°，进港走航道右侧、出港走另一侧）：
 * 外海 → 引航站（引航员上下船）→ 航道 → 泊位正前方的掉头点（离码头前沿 174 米）→ 泊位。掉头点到泊位这一段是拖轮横推，船身一直沿着码头。
 */
export const LOCAL_LINER_IN: Km[] = [{ x: 0.796, y: -71.344 }, { x: -12.885, y: -33.756 }, { x: -17.605, y: -20.788 }, { x: -19.9, y: -16.09 }, LOCAL_SEA_BERTH];
export const LOCAL_LINER_OUT: Km[] = [LOCAL_SEA_BERTH, { x: -19.9, y: -16.09 }, { x: -18.638, y: -21.165 }, { x: -13.918, y: -34.132 }, { x: -0.238, y: -71.72 }];
export const LOCAL_ANCHORAGE: Km = { x: -27.5, y: -19.2 };
export const LOCAL_AIR_APPROACH: Km = { x: 40, y: -12.85 };
export const LOCAL_RUNWAY: { a: Km; b: Km } = { a: { x: 10.8, y: -12.85 }, b: { x: 31.8, y: -12.85 } };

/** 道路节点：绕城快速路的立交（R0…）和两头（BE0、BE1）、城区路口、各设施的入口、两个高速出口 */
export const NODES: Record<string, Km> = {};
export const BASE_EDGES: RoadEdge[] = [];
/** 铁路：港口铁路站 → 城市客运站 → 物流园货运站 → 出区域（公里坐标） */
export const RAIL: Km[] = [];
/** 铁路上港口站、物流园货运站在折线上的位置（第几个点） */
export let RAIL_PORT_INDEX = 0;
export let RAIL_DC_INDEX = 0;
/** 海岸线：沿海岸从一头到另一头 */
export const COAST: Km[] = [];
/** 内陆供应商：从高速出口再开多少公里（不在地图上） */
export const OFFMAP_KM: Record<string, number> = { NORTH: 0, EAST: 0 };

/** 港口、机场、物流园的坐标系（局部 → 区域） */
export const FRAMES: { port: Frame; airport: Frame; park: Frame } = {
  port: identityFrame({ x: -2100, z: 1240 }),
  airport: identityFrame({ x: 1950, z: 1080 }),
  park: identityFrame({ x: 1120, z: -1340 }),
};
/** 局部坐标的点换到区域里（公里） */
export const portKm = (k: Km): Km => kmToWorld(FRAMES.port, k);
export const airKm = (k: Km): Km => kmToWorld(FRAMES.airport, k);
export const parkKm = (k: Km): Km => kmToWorld(FRAMES.park, k);

/** 区域里的位置（换区域时跟着港口、机场的坐标系一起改） */
export const SEA_BERTH: Km = { ...LOCAL_SEA_BERTH };
export const ANCHORAGE: Km = { ...LOCAL_ANCHORAGE };
export const AIR_APPROACH: Km = { ...LOCAL_AIR_APPROACH };
export const RUNWAY: { a: Km; b: Km } = { a: { ...LOCAL_RUNWAY.a }, b: { ...LOCAL_RUNWAY.b } };

/** 当前区域的其他数据（河、城区、绕城快速路、高架、城市客运站……），由 applyRegionPlan 填 */
export const REGION: { plan: RegionPlan | undefined } = { plan: undefined };

function dist(p: Km, q: Km): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function polylineKm(pts: readonly Km[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1] as Km, pts[i] as Km);
  return s;
}

/** 道路的弯曲系数：真实里程 = 折线长度 × 系数（折线已经画出了大的弯，系数只补小弯） */
const CIRCUITY: Record<RoadClass, number> = { highway: 1.06, ring: 1.0, arterial: 1.12, local: 1.3 };

export function edge(a: string, b: string, cls: RoadClass, via: Km[] = []): RoadEdge {
  // 去掉重合的点（平滑、推回陆地以后可能有）
  const pts: Km[] = [];
  for (const p of [NODES[a] as Km, ...via, NODES[b] as Km]) if (!pts.length || dist(pts[pts.length - 1] as Km, p) > 0.01) pts.push(p);
  if (dist(pts[pts.length - 1] as Km, NODES[b] as Km) > 1e-9) pts[pts.length - 1] = NODES[b] as Km;
  return { a, b, cls, km: polylineKm(pts) * CIRCUITY[cls], pts };
}

/** 换区域：把生成器给的节点、道路、铁路、海岸线和设施的坐标系写进上面这些对象（原地改） */
export function applyRegionPlan(plan: RegionPlan): void {
  for (const k of Object.keys(NODES)) delete NODES[k];
  Object.assign(NODES, plan.nodes);
  BASE_EDGES.splice(0, BASE_EDGES.length, ...plan.edges.map((e) => edge(e.a, e.b, e.cls, e.via ?? [])));
  RAIL.splice(0, RAIL.length, ...plan.rail);
  RAIL_PORT_INDEX = plan.railPortIndex;
  RAIL_DC_INDEX = plan.railDcIndex;
  COAST.splice(0, COAST.length, ...plan.coast);
  FRAMES.port = plan.frames.port;
  FRAMES.airport = plan.frames.airport;
  FRAMES.park = plan.frames.park;
  Object.assign(SEA_BERTH, portKm(LOCAL_SEA_BERTH));
  Object.assign(ANCHORAGE, portKm(LOCAL_ANCHORAGE));
  Object.assign(AIR_APPROACH, airKm(LOCAL_AIR_APPROACH));
  RUNWAY.a = airKm(LOCAL_RUNWAY.a);
  RUNWAY.b = airKm(LOCAL_RUNWAY.b);
  REGION.plan = plan;
}
