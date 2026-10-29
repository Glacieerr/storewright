import * as THREE from 'three';
import { createRng, type Rng } from '@storewright/domain';

/**
 * 程序生成的贴图（画布绘制，不下载任何素材）：石块、沥青、人行道方砖、木板、广场石板。
 * 都是可平铺的灰度/浅色底图，颜色由材质的 color 决定（季节、湿滑、积雪时只改材质颜色）。
 * 同一种贴图只生成一次。
 */

const cache = new Map<string, THREE.CanvasTexture>();

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas 2d unavailable');
  return [c, g];
}

function finish(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function grey(v: number): string {
  const k = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${k},${k},${k})`;
}

/** 平铺用的颗粒噪声：在整张图上撒点（边缘环绕） */
function speckle(g: CanvasRenderingContext2D, size: number, rng: Rng, count: number, r0: number, r1: number, v0: number, v1: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = rng.uniform(0, size);
    const y = rng.uniform(0, size);
    const r = rng.uniform(r0, r1);
    g.globalAlpha = alpha;
    g.fillStyle = grey(rng.uniform(v0, v1));
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        if (x + ox < -r || x + ox > size + r || y + oy < -r || y + oy > size + r) continue;
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        g.fill();
      }
  }
  g.globalAlpha = 1;
}

/** 沥青：深浅斑块 + 细碎骨料 + 几道细裂缝。一张图对应 8×8 米 */
export function asphaltTexture(): THREE.CanvasTexture {
  const hit = cache.get('asphalt');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(11);
  g.fillStyle = grey(0.86);
  g.fillRect(0, 0, S, S);
  speckle(g, S, rng, 90, 18, 60, 0.8, 0.92, 0.18);
  speckle(g, S, rng, 5200, 0.6, 1.6, 0.6, 1.0, 0.35);
  g.strokeStyle = grey(0.62);
  g.lineWidth = 1.2;
  g.globalAlpha = 0.45;
  for (let k = 0; k < 6; k++) {
    let x = rng.uniform(0, S);
    let y = rng.uniform(0, S);
    g.beginPath();
    g.moveTo(x, y);
    for (let j = 0; j < 8; j++) {
      x += rng.uniform(-14, 14);
      y += rng.uniform(-14, 14);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const t = finish(c);
  cache.set('asphalt', t);
  return t;
}

/** 人行道方砖：0.6 米见方，错缝；一张图对应 2.4×2.4 米 */
export function paverTexture(): THREE.CanvasTexture {
  const hit = cache.get('paver');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(23);
  const n = 4;
  const cell = S / n;
  g.fillStyle = grey(0.72);
  g.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      g.fillStyle = grey(rng.uniform(0.9, 0.99));
      g.fillRect(i * cell + 3, j * cell + 3, cell - 6, cell - 6);
    }
  speckle(g, S, rng, 1800, 0.5, 1.4, 0.75, 1.0, 0.25);
  const t = finish(c);
  cache.set('paver', t);
  return t;
}

/** 石块墙：错缝的长方形石块，块与块之间有灰缝，每块深浅略有不同；一张图对应 4×4 米 */
export function stoneTexture(): THREE.CanvasTexture {
  const hit = cache.get('stone');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(37);
  g.fillStyle = grey(0.58);
  g.fillRect(0, 0, S, S);
  const rows = 8;
  const rh = S / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 === 0 ? 0 : -rng.uniform(20, 60);
    while (x < S) {
      const w = rng.uniform(60, 120);
      const v = rng.uniform(0.82, 0.98);
      g.fillStyle = grey(v);
      const draw = (ox: number) => {
        g.beginPath();
        g.roundRect(x + ox + 3, r * rh + 3, w - 6, rh - 6, 6);
        g.fill();
      };
      draw(0);
      if (x + w > S) draw(-S);
      if (x < 0) draw(S);
      // 石块上的明暗：上沿亮、下沿暗
      g.fillStyle = grey(Math.min(1, v + 0.06));
      g.fillRect(x + 6, r * rh + 4, w - 12, 4);
      g.fillStyle = grey(v - 0.1);
      g.fillRect(x + 6, (r + 1) * rh - 8, w - 12, 3);
      x += w;
    }
  }
  speckle(g, S, rng, 2400, 0.5, 1.8, 0.6, 1.0, 0.22);
  const t = finish(c);
  cache.set('stone', t);
  return t;
}

/** 木板：沿 U 方向的长木板，纹理和板缝；一张图对应 2×2 米（8 块板） */
export function plankTexture(): THREE.CanvasTexture {
  const hit = cache.get('plank');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(53);
  const n = 8;
  const bh = S / n;
  g.fillStyle = grey(0.35);
  g.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++) {
    const base = rng.uniform(0.78, 0.95);
    let x = -rng.uniform(0, 200);
    while (x < S) {
      const w = rng.uniform(180, 320);
      g.fillStyle = grey(base + rng.uniform(-0.04, 0.04));
      g.fillRect(x + 2, j * bh + 3, w - 4, bh - 6);
      if (x < 0) g.fillRect(x + S + 2, j * bh + 3, w - 4, bh - 6);
      // 木纹
      g.strokeStyle = grey(base - 0.12);
      g.globalAlpha = 0.35;
      for (let k = 0; k < 4; k++) {
        const y = j * bh + rng.uniform(8, bh - 8);
        g.beginPath();
        g.moveTo(x + 4, y);
        g.bezierCurveTo(x + w * 0.3, y + rng.uniform(-4, 4), x + w * 0.7, y + rng.uniform(-4, 4), x + w - 4, y);
        g.stroke();
      }
      g.globalAlpha = 1;
      x += w;
    }
  }
  const t = finish(c);
  cache.set('plank', t);
  return t;
}

/** 广场石板：大小不一的方石板拼铺；一张图对应 3×3 米 */
export function flagstoneTexture(): THREE.CanvasTexture {
  const hit = cache.get('flag');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(71);
  g.fillStyle = grey(0.66);
  g.fillRect(0, 0, S, S);
  const n = 6;
  const cell = S / n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const big = (i + j) % 3 === 0 && i < n - 1;
      g.fillStyle = grey(rng.uniform(0.84, 0.98));
      g.beginPath();
      g.roundRect(i * cell + 3, j * cell + 3, (big ? 2 : 1) * cell - 6, cell - 6, 5);
      g.fill();
      if (big) i++;
    }
  speckle(g, S, rng, 2000, 0.5, 1.5, 0.7, 1.0, 0.22);
  const t = finish(c);
  cache.set('flag', t);
  return t;
}

/** 外墙金属板：竖向板缝 1.2 米一道，横向 2.4 米一道；一张图对应 4.8×4.8 米 */
export function panelTexture(): THREE.CanvasTexture {
  const hit = cache.get('panel');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(83);
  g.fillStyle = grey(0.97);
  g.fillRect(0, 0, S, S);
  speckle(g, S, rng, 40, 30, 80, 0.93, 1.0, 0.12);
  const n = 4;
  const cell = S / n;
  g.fillStyle = grey(0.8);
  for (let i = 0; i < n; i++) g.fillRect(i * cell, 0, 3, S);
  g.fillStyle = grey(0.86);
  g.fillRect(0, S / 2 - 1, S, 3);
  g.fillRect(0, 0, S, 2);
  g.fillStyle = grey(1);
  for (let i = 0; i < n; i++) g.fillRect(i * cell + 3, 0, 2, S);
  const t = finish(c);
  cache.set('panel', t);
  return t;
}

/** 屋面卷材：浅灰底、2 米宽的搭接缝和零星的修补；一张图对应 8×8 米 */
export function roofTexture(): THREE.CanvasTexture {
  const hit = cache.get('roof');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(97);
  g.fillStyle = grey(0.93);
  g.fillRect(0, 0, S, S);
  speckle(g, S, rng, 60, 20, 70, 0.86, 0.98, 0.18);
  g.fillStyle = grey(0.82);
  for (let i = 0; i < 4; i++) g.fillRect(0, i * 128, S, 3);
  speckle(g, S, rng, 1600, 0.5, 1.4, 0.8, 1.0, 0.2);
  const t = finish(c);
  cache.set('roof', t);
  return t;
}

/** 店内地砖：0.6 米见方的塑胶地砖，深浅交替、细缝；一张图对应 2.4×2.4 米 */
export function floorTileTexture(): THREE.CanvasTexture {
  const hit = cache.get('floortile');
  if (hit) return hit;
  const S = 512;
  const [c, g] = canvas(S);
  const rng = createRng(101);
  const n = 4;
  const cell = S / n;
  g.fillStyle = grey(0.84);
  g.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      g.fillStyle = grey((i + j) % 2 === 0 ? rng.uniform(0.97, 1.0) : rng.uniform(0.93, 0.96));
      g.fillRect(i * cell + 1.5, j * cell + 1.5, cell - 3, cell - 3);
    }
  speckle(g, S, rng, 900, 0.5, 1.3, 0.85, 1.0, 0.18);
  const t = finish(c);
  cache.set('floortile', t);
  return t;
}
