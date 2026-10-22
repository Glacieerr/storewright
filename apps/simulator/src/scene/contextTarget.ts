import type { Selection } from '../state/store';

/** 右键菜单的对象：场景中的员工、车辆、货架、暂存区、设施，或地面上的一点 */
export type MenuTarget = Selection | { type: 'ground'; x: number; z: number };

/**
 * 右键按下时由被点中的物体登记目标；松开时如果鼠标几乎没动（不是右键拖动平移），再打开菜单。
 * 不同系统上 contextmenu 事件在按下或松开时触发，两种顺序都能处理。
 */
export const pendingMenu: { target?: MenuTarget } = {};

export function armMenu(target: MenuTarget, e: { stopPropagation(): void; nativeEvent: Event }): void {
  e.stopPropagation();
  e.nativeEvent.preventDefault();
  pendingMenu.target = target;
}
