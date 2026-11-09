import { DOORS, RECEIVING_DOORS } from '../sim/board';
import { STORE } from '../region/network';
import { defaultFacilities, type Facilities } from './config';

/**
 * 当前的设施配置（三维的设施作业、调度台、闭环孪生都读它）：门店的规模和收货口、配送中心开放的月台门直接改在共享的对象上
 * （STORE、DOORS 原地改，引用它们的地方不用换）；其余的由各设施的作业模块在排计划时读。
 */
let CURRENT: Facilities = defaultFacilities();
export const currentFacilities = (): Facilities => CURRENT;

export function setFacilities(f: Facilities): void {
  CURRENT = JSON.parse(JSON.stringify(f));
  STORE.size = f.store.size;
  STORE.docks = Math.max(1, Math.min(8, Math.round(f.store.docks)));
  const pad = (n: number) => String(n).padStart(2, '0');
  const dry = Math.max(4, Math.min(26, Math.round(f.dc.dryDoors)));
  const cold = Math.max(2, Math.min(12, Math.round(f.dc.coldDoors)));
  DOORS.dry.splice(0, DOORS.dry.length, ...Array.from({ length: dry }, (_, i) => `D${pad(i + 1)}`));
  DOORS.cold.splice(0, DOORS.cold.length, ...Array.from({ length: cold }, (_, i) => `C${pad(i + 1)}`));
  // 每组前三分之一是收货门（默认干货 8 樘、冷链 4 樘）
  RECEIVING_DOORS.dry = Math.max(2, Math.round((dry * 8) / 26));
  RECEIVING_DOORS.cold = Math.max(1, Math.round((cold * 4) / 12));
}
