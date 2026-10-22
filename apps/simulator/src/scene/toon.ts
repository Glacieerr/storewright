import * as THREE from 'three';

/** 卡通渲染用的 3 段明暗渐变贴图 */
let gradient: THREE.DataTexture | undefined;
export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
    gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** 拣货热度配色：从冷到暖的单色阶 */
export function heatColor(v: number, out: THREE.Color): THREE.Color {
  const k = Math.min(1, Math.max(0, v));
  return out.setHSL(0.6 - 0.6 * k, 0.55 + 0.25 * k, 0.78 - 0.28 * k);
}
