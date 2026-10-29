import type { TempZone } from '@storewright/domain';
import type { Role } from '@storewright/sim-engine';
import { trRecord } from '../i18n';

/** 场景配色：柔和、低饱和，温区与界面中的颜色一致（界面同时配文字，不只靠颜色） */
export const ZONE_COLOR: Record<TempZone, string> = {
  AMBIENT: '#e7cf9f',
  CHILLED: '#86bce6',
  FROZEN: '#a9e3ee',
  HOT: '#f2a35e',
};

export const ZONE_LABEL: Record<TempZone, string> = trRecord({
  AMBIENT: '常温',
  CHILLED: '冷藏',
  FROZEN: '冷冻',
  HOT: '热食',
});

export const ROLE_COLOR: Record<Role, string> = {
  pick: '#3fa36b',
  stage: '#8a6bd6',
  handoff: '#ee8a35',
  exception: '#d85656',
};

export const ROLE_LABEL: Record<Role, string> = trRecord({
  pick: '拣货',
  stage: '暂存',
  handoff: '交付',
  exception: '后仓补取',
});

export const SCENE = {
  background: '#e9eef2',
  floor: '#f6f3ec',
  floorUpper: '#cfdbe6',
  wall: '#d9d3c7',
  parking: '#c9cfd4',
  parkingLine: '#f4f6f7',
  road: '#b9c0c6',
  rack: '#b7b0a2',
  tote: '#5b7c99',
  door: '#ee8a35',
  skin: '#f1c9a5',
  cart: '#7d8a96',
  select: '#ff5a36',
};

/** 季节的地面与草坪颜色（卡通风格：比写实更饱和、更明快）；三维场景和小地图共用 */
export const GROUND_PALETTE: Record<string, { ground: string; grass: string }> = {
  spring: { ground: '#a9d47e', grass: '#9fd072' },
  summer: { ground: '#93c46a', grass: '#86bd5c' },
  autumn: { ground: '#b8c878', grass: '#a9c46a' },
  winter: { ground: '#c9c4a6', grass: '#bdbb98' },
};
/** 城市街区的硬质铺地 */
export const URBAN_GROUND = '#cfd2c4';

