import { DIORAMA_SCALE } from './region';

/**
 * 比例：三维场景里两种比例并存，统一在这里写清楚，别处按这里换算。
 *
 * - 区域的距离（道路、铁路、海岸、河、城区之间）：沙盘比例，1 公里画成 DIORAMA_SCALE = 100 米，也就是压缩成 1/10；
 * - 设施（港口、机场、物流园、门店、停车场）、建筑和车辆：真实尺寸（1 : 1），这样岸桥、月台门、车位都对得上真实的尺寸；
 * - 时间：真实时间（仿真的时刻表照原样）。所以路上的车在画面里按真实车速的 1/10 走（距离缩了 10 倍、时间没缩），
 *   进了设施、停车场按真实车速走；车道宽、车身长不缩，路上的车按镜头远近放大一点才看得清。
 * - 对外接口（孪生服务、虚幻引擎）用的都是沙盘坐标（米）；要真实距离就除以 DIORAMA_SCALE 得公里。
 */
export const SCALE = {
  /** 区域的距离：沙盘米 / 真实米 */
  region: DIORAMA_SCALE / 1000,
  /** 设施、建筑、车辆 */
  facility: 1,
} as const;

/** 真实公里 → 沙盘米 */
export const kmToScene = (km: number): number => km * DIORAMA_SCALE;
/** 沙盘米 → 真实公里 */
export const sceneToKm = (m: number): number => m / DIORAMA_SCALE;
/** 路上的真实车速（公里 / 小时）→ 画面里的速度（沙盘米 / 秒） */
export const roadSpeedScene = (kmh: number): number => (kmh / 3.6) * SCALE.region;
/** 画面里路上的速度（沙盘米 / 秒）→ 真实车速（公里 / 小时） */
export const roadSpeedReal = (sceneMps: number): number => (sceneMps / SCALE.region) * 3.6;

/** 给界面和文档用的一句话 */
export const SCALE_NOTE = `比例：道路和区域的距离按沙盘缩成 1/10（1 公里画成 ${DIORAMA_SCALE} 米），港口、机场、物流园、门店、停车场、建筑和车辆按真实尺寸；时间是真实时间，所以路上的车在画面里按真实车速的 1/10 走，进了设施和停车场按真实车速走。`;
