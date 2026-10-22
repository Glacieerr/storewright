import qrcode from 'qrcode-generator';

/**
 * 二维码：只编码不透明 ID（决策 L-01），纠错等级 M。
 * 返回模块矩阵，SVG、ZPL 预览和测试都从这里取。
 */
export function qrMatrix(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = qrcode(0, ecc);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** 二维码的 SVG 路径（含 2 个模块的静区），左上角 (x, y)，边长 size */
export function qrSvgPath(text: string, x: number, y: number, size: number, quiet = 2): string {
  const m = qrMatrix(text);
  const n = m.length;
  const cell = size / (n + quiet * 2);
  let d = '';
  for (let r = 0; r < n; r++) {
    const row = m[r] as boolean[];
    for (let c = 0; c < n; c++) {
      if (!row[c]) continue;
      const px = x + (c + quiet) * cell;
      const py = y + (r + quiet) * cell;
      d += `M${px.toFixed(2)} ${py.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    }
  }
  return `<path d="${d}" fill="#000"/>`;
}

/** 栅格化成 RGBA 像素（白底黑块），用于解码校验 */
export function qrPixels(text: string, scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const m = qrMatrix(text);
  const n = m.length;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!m[r]?.[c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (c + quiet) * scale + dx;
          const py = (r + quiet) * scale + dy;
          const i = (py * size + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}
