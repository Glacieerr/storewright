import type { RootState } from '@react-three/fiber';

/** 场景画面的访问入口（截图、方案缩略图）；开了后期处理时 render 走同一条流水线 */
export const sceneAccess: { get?: () => RootState; render?: () => void } = {};

/**
 * 截取当前画面：重新渲染一帧后读出画布（不需要 preserveDrawingBuffer）。
 * maxW 限制宽度（缩略图），type 为图片格式。
 */
export function captureScene(maxW = 0, type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.85): string | undefined {
  const st = sceneAccess.get?.();
  if (!st) return undefined;
  if (sceneAccess.render) sceneAccess.render();
  else st.gl.render(st.scene, st.camera);
  const src = st.gl.domElement;
  if (!maxW || src.width <= maxW) return src.toDataURL(type, quality);
  const c = document.createElement('canvas');
  c.width = maxW;
  c.height = Math.round((src.height / src.width) * maxW);
  c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL(type, quality);
}

