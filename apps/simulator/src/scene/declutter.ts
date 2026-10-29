import { useEffect, type RefObject } from 'react';

/**
 * 场景标签去重叠（决策记录 0015）：三维场景里的标签是贴在画面上的 HTML，镜头远的时候会互相压住（冷藏库压冷冻库、
 * 通道号挤在一起）。每 250 毫秒按屏幕位置检查一次：重要的标签先放，和已经放好的标签重叠的暂时隐藏（加 declutter-hidden，
 * visibility: hidden，不改变布局，所以下一次还能量到它的位置）。员工和车辆的实时标签不参与（它们一直在动）。
 */
const SELECTOR = '.scene-label.area-label, .scene-label.run-label, .scene-label.floor-label, .scene-label.twin-label';

/** 越大越先放 */
function priority(el: HTMLElement): number {
  const c = el.classList;
  // 数字孪生的设备牌（决策记录 0016）：告警的最先放，温度牌比区域名重要（设备牌里已经带着区域名）
  if (c.contains('twin-label')) return c.contains('s-alarm') ? 8 : c.contains('kind-TEMP') ? 5 : 3;
  if (c.contains('pickup-label') || c.contains('floor-label')) return 5;
  if (c.contains('handle-label')) return 6;
  if (c.contains('alert')) return 4;
  if (c.contains('area-label')) {
    if (c.contains('backroom-label')) return 1;
    if ([...c].some((k) => k === 'kind-COOLER' || k === 'kind-FREEZER' || k === 'deli-label' || k === 'pharmacy-label' || k === 'garden-label' || k === 'service-label')) return 2;
    return 3;
  }
  return 0;
}

export function declutter(root: HTMLElement): number {
  const items = [...root.querySelectorAll<HTMLElement>(SELECTOR)]
    .map((el, i) => ({ el, i, pri: priority(el), r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && x.r.height > 0);
  items.sort((a, b) => b.pri - a.pri || a.i - b.i);
  const placed: DOMRect[] = [];
  let hidden = 0;
  for (const x of items) {
    const pad = 2;
    const hit = placed.some((p) => x.r.left < p.right + pad && p.left < x.r.right + pad && x.r.top < p.bottom + pad && p.top < x.r.bottom + pad);
    x.el.classList.toggle('declutter-hidden', hit);
    if (hit) hidden++;
    else placed.push(x.r);
  }
  return hidden;
}

export function useLabelDeclutter(container: RefObject<HTMLElement | null>, everyMs = 250): void {
  useEffect(() => {
    const id = window.setInterval(() => {
      if (container.current) declutter(container.current);
    }, everyMs);
    return () => window.clearInterval(id);
  }, [container, everyMs]);
}
