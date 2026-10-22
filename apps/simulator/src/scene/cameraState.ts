/** 当前镜头的地面取景范围、目标点和屏幕方向（小地图、编辑微调、天气粒子读取） */
export const cameraState = {
  footprint: [] as Array<{ x: number; z: number }>,
  target: { x: 0, z: 0 },
  azimuth: 0,
  /** 屏幕向右、向上在地面上对应的方向（单位向量，x/z），编辑时方向键按屏幕方向微调 */
  right: { x: 1, z: 0 },
  up: { x: 0, z: -1 },
};
