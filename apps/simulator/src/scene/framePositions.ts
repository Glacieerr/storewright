import type { Vec3 } from './layout';

/** 每帧更新的员工、车辆位置（点选卡片、小地图、镜头跟随读取） */
export const framePositions = new Map<string, Vec3>();
