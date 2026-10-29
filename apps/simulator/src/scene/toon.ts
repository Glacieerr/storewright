import * as THREE from 'three';

/**
 * 卡通渲染用的明暗渐变贴图：两段式（亮面 / 暗面），交界处有一小段柔和过渡，
 * 亮面和暗面内部各带一点渐变，避免像纸片一样平。坐标 = dot(N, L) * 0.5 + 0.5。
 */
let gradient: THREE.DataTexture | undefined;
export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    const W = 64;
    const data = new Uint8Array(W * 4);
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < W; i++) {
      const c = i / (W - 1);
      const shadow = 0.3 + 0.07 * Math.min(1, c / 0.46);
      const lit = 0.86 + 0.14 * Math.max(0, (c - 0.54) / 0.46);
      const v = shadow + (lit - shadow) * smooth(0.45, 0.53, c);
      const b = Math.round(Math.min(1, v) * 255);
      data.set([b, b, b, 255], i * 4);
    }
    gradient = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
    gradient.minFilter = THREE.LinearFilter;
    gradient.magFilter = THREE.LinearFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** 拣货热度配色：从冷到暖的单色阶 */
export function heatColor(v: number, out: THREE.Color): THREE.Color {
  const k = Math.min(1, Math.max(0, v));
  return out.setHSL(0.6 - 0.6 * k, 0.55 + 0.25 * k, 0.78 - 0.28 * k);
}
