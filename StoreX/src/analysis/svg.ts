/**
 * 报告用的 SVG 图（不依赖任何库）：折线、横向分组柱、正负柱、龙卷风图。
 * 颜色按角色定义成 CSS 变量，跟着系统的浅色 / 深色切换；系列颜色固定跟着方案走：
 * StoreX = 蓝、上一代 = 橙、不建货格仓 = 青（同一个方案在所有图里同一个颜色）。
 */

export const SERIES = {
  storex: 'var(--s1)',
  gen1: 'var(--s2)',
  noMfc: 'var(--s3)',
  s4: 'var(--s4)',
} as const;

const STYLE = `
  .viz{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#6250d6;--good:#2a78d6;--bad:#e34948;--neutral:#f0efec}
  @media (prefers-color-scheme: dark){.viz{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#9085e9;--good:#3987e5;--bad:#e66767;--neutral:#383835}}
  text{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;fill:var(--ink2);font-size:12px}
  .t{fill:var(--ink);font-size:15px;font-weight:600}
  .st{fill:var(--ink2);font-size:12px}
  .ax{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
  .v{fill:var(--ink);font-size:11px;font-variant-numeric:tabular-nums}
  .lab{fill:var(--ink);font-size:12px}
  .grid{stroke:var(--grid);stroke-width:1}
  .base{stroke:var(--axis);stroke-width:1}
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 估算文字宽度（中文按 1 个字号宽，其他按 0.58） */
export function textWidth(s: string, size = 12): number {
  let w = 0;
  for (const ch of s) w += /[⺀-￿]/.test(ch) ? size : size * 0.58;
  return w;
}

function frame(w: number, h: number, title: string, subtitle: string, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" class="viz"><style>${STYLE}</style><rect width="${w}" height="${h}" rx="8" fill="var(--bg)"/><text x="20" y="28" class="t">${esc(title)}</text><text x="20" y="48" class="st">${esc(subtitle)}</text>${body}</svg>\n`;
}

/** 好看的刻度：0、1、2、5 × 10^n */
function ticks(min: number, max: number, n = 5): number[] {
  if (max <= min) max = min + 1;
  const span = max - min;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) ?? 10 * mag;
  // 刻度范围要盖住最小值和最大值
  const out: number[] = [];
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  for (let k = first; k <= last; k++) out.push(Number((k * step).toPrecision(12)));
  return out;
}

const num = (x: number, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, '−');

export interface LineSeries {
  name: string;
  color: string;
  values: number[];
  /** 95% 置信区间半宽（画误差线） */
  err?: number[];
}

export function lineChart(o: { title: string; subtitle: string; x: string[]; series: LineSeries[]; digits?: number; highlight?: number; yMin?: number; label?: string }): string {
  const W = 720;
  const H = 380;
  const left = 64;
  const right = o.series.length > 1 ? 140 : 32;
  const top = o.series.length > 1 ? 92 : 72;
  const bottom = 48;
  const all = o.series.flatMap((s) => s.values.map((v, i) => [v - (s.err?.[i] ?? 0), v + (s.err?.[i] ?? 0)]).flat()).filter(Number.isFinite);
  const lo = Math.min(o.yMin ?? 0, ...all);
  const hi = Math.max(...all);
  const ts = ticks(lo, hi * 1.05);
  const y0 = ts[0] as number;
  const y1 = ts[ts.length - 1] as number;
  const px = (i: number) => left + (o.x.length === 1 ? (W - left - right) / 2 : (i * (W - left - right)) / (o.x.length - 1));
  const py = (v: number) => top + (1 - (v - y0) / (y1 - y0)) * (H - top - bottom);
  let body = '';
  for (const t of ts) body += `<line x1="${left}" x2="${W - right}" y1="${py(t)}" y2="${py(t)}" class="${t === y0 ? 'base' : 'grid'}"/><text x="${left - 8}" y="${py(t) + 4}" text-anchor="end" class="ax">${num(t, Math.abs(y1 - y0) < 5 ? 1 : 0)}</text>`;
  o.x.forEach((x, i) => {
    body += `<text x="${px(i)}" y="${H - bottom + 20}" text-anchor="middle" class="ax">${esc(x)}</text>`;
  });
  if (o.highlight !== undefined) {
    const x = px(o.highlight);
    body += `<line x1="${x}" x2="${x}" y1="${top - 6}" y2="${H - bottom}" stroke="var(--axis)" stroke-dasharray="3 3"/><text x="${x}" y="${top - 10}" text-anchor="middle" class="lab">选用</text>`;
  }
  // 图例（两个以上系列）
  if (o.series.length > 1) {
    let lx = 20;
    for (const s of o.series) {
      body += `<rect x="${lx}" y="62" width="14" height="4" rx="2" fill="${s.color}"/><text x="${lx + 20}" y="68" class="lab">${esc(s.name)}</text>`;
      lx += 34 + textWidth(s.name);
    }
  }
  const d = o.digits ?? 1;
  for (const s of o.series) {
    const pts = s.values.map((v, i) => [px(i), py(v)] as const).filter(([, y]) => Number.isFinite(y));
    if (s.err) s.values.forEach((v, i) => {
      const e = s.err?.[i] ?? 0;
      if (e > 0) body += `<line x1="${px(i)}" x2="${px(i)}" y1="${py(v - e)}" y2="${py(v + e)}" stroke="${s.color}" stroke-width="1.5" opacity="0.55"/>`;
    });
    body += `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    for (const [x, y] of pts) body += `<circle cx="${x}" cy="${y}" r="4" fill="${s.color}" stroke="var(--bg)" stroke-width="2"/>`;
    // 直接标注：单系列标每个点的值
    if (o.series.length === 1) s.values.forEach((v, i) => (body += `<text x="${px(i)}" y="${py(v) - 10}" text-anchor="middle" class="v">${num(v, d)}</text>`));
  }
  // 多系列：在线尾标名字和值，太挤时上下错开（至少 15 像素）
  if (o.series.length > 1) {
    const last = o.x.length - 1;
    const labels = o.series.map((s) => ({ s, y: py(s.values[last] as number) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      const prev = labels[i - 1] as { y: number };
      const cur = labels[i] as { y: number };
      if (cur.y - prev.y < 15) cur.y = prev.y + 15;
    }
    const overflow = (labels[labels.length - 1]?.y ?? 0) - (H - bottom);
    if (overflow > 0) for (const l of labels) l.y -= overflow;
    for (const l of labels) body += `<text x="${px(last) + 10}" y="${l.y + 4}" class="lab">${esc(l.s.name)} ${num(l.s.values[last] as number, d)}</text>`;
  }
  return frame(W, H, o.title, o.subtitle, body, o.label ?? o.title);
}

export interface BarSeries {
  name: string;
  color: string;
  values: number[];
}

/** 横向分组柱：每个类别一组，每个系列一根 */
export function barChart(o: { title: string; subtitle: string; categories: string[]; series: BarSeries[]; digits?: number; unit?: string; label?: string }): string {
  const W = 720;
  const labelW = Math.min(240, Math.max(...o.categories.map((c) => textWidth(c))) + 16);
  const left = 20 + labelW;
  const right = 90;
  const bar = 14;
  const gap = 2;
  const group = o.series.length * (bar + gap) + 14;
  const top = o.series.length > 1 ? 88 : 68;
  const H = top + o.categories.length * group + 24;
  const max = Math.max(...o.series.flatMap((s) => s.values));
  const ts = ticks(0, max * 1.02, 4);
  const xmax = ts[ts.length - 1] as number;
  const px = (v: number) => left + (v / xmax) * (W - left - right);
  let body = '';
  for (const t of ts) body += `<line x1="${px(t)}" x2="${px(t)}" y1="${top - 6}" y2="${H - 22}" class="${t === 0 ? 'base' : 'grid'}"/><text x="${px(t)}" y="${H - 8}" text-anchor="middle" class="ax">${num(t)}</text>`;
  if (o.series.length > 1) {
    let lx = 20;
    for (const s of o.series) {
      body += `<rect x="${lx}" y="60" width="12" height="12" rx="3" fill="${s.color}"/><text x="${lx + 18}" y="70" class="lab">${esc(s.name)}</text>`;
      lx += 32 + textWidth(s.name);
    }
  }
  const d = o.digits ?? 0;
  o.categories.forEach((c, i) => {
    const gy = top + i * group;
    body += `<text x="${left - 10}" y="${gy + (o.series.length * (bar + gap)) / 2 + 4}" text-anchor="end" class="lab">${esc(c)}</text>`;
    o.series.forEach((s, k) => {
      const v = s.values[i] as number;
      const y = gy + k * (bar + gap);
      const w = Math.max(0, px(v) - left);
      // 数据端圆角，基线端平直
      body += w > 4 ? `<path d="M${left},${y} h${w - 4} a4,4 0 0 1 4,4 v${bar - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${s.color}"/>` : `<rect x="${left}" y="${y}" width="${w}" height="${bar}" fill="${s.color}"/>`;
      body += `<text x="${left + w + 6}" y="${y + bar - 3}" class="v">${num(v, d)}${o.unit ?? ''}</text>`;
    });
  });
  return frame(W, H, o.title, o.subtitle, body, o.label ?? o.title);
}

/** 正负柱：每个指标的变化百分比，变好用蓝、变差用红（另附文字「改善 / 变差」，不只靠颜色） */
export function changeChart(o: { title: string; subtitle: string; items: { label: string; pct: number; good: boolean | null }[]; label?: string }): string {
  const W = 720;
  const labelW = Math.min(300, Math.max(...o.items.map((c) => textWidth(c.label))) + 16);
  const left = 20 + labelW;
  const right = 120;
  const row = 22;
  const top = 72;
  const H = top + o.items.length * row + 30;
  const lim = Math.max(10, ...o.items.map((x) => Math.min(150, Math.abs(x.pct))));
  const ts = ticks(-lim, lim, 6);
  const a = ts[0] as number;
  const b = ts[ts.length - 1] as number;
  const px = (v: number) => left + ((Math.max(a, Math.min(b, v)) - a) / (b - a)) * (W - left - right);
  let body = '';
  for (const t of ts) body += `<line x1="${px(t)}" x2="${px(t)}" y1="${top - 6}" y2="${H - 26}" class="${t === 0 ? 'base' : 'grid'}"/><text x="${px(t)}" y="${H - 10}" text-anchor="middle" class="ax">${t > 0 ? '+' : ''}${num(t)}%</text>`;
  o.items.forEach((it, i) => {
    const y = top + i * row;
    const x0 = px(0);
    const x1 = px(it.pct);
    const color = it.good === null ? 'var(--muted)' : it.good ? 'var(--good)' : 'var(--bad)';
    body += `<text x="${left - 10}" y="${y + 12}" text-anchor="end" class="lab">${esc(it.label)}</text>`;
    body += `<rect x="${Math.min(x0, x1)}" y="${y + 2}" width="${Math.max(1, Math.abs(x1 - x0))}" height="13" rx="3" fill="${color}"/>`;
    const tag = it.good === null ? '' : it.good ? ' 改善' : ' 变差';
    const clipped = Math.abs(it.pct) > b ? '（超出刻度）' : '';
    body += `<text x="${it.pct >= 0 ? x1 + 6 : x0 + 6}" y="${y + 13}" class="v">${it.pct > 0 ? '+' : ''}${num(it.pct)}%${tag}${clipped}</text>`;
  });
  return frame(W, H, o.title, o.subtitle, body, o.label ?? o.title);
}

/** 龙卷风图：每个假设取低 / 高值时的结果，围绕基准值 */
export function tornadoChart(o: { title: string; subtitle: string; base: number; items: { label: string; low: { label: string; value: number }; high: { label: string; value: number } }[]; scale?: number; unit?: string; label?: string }): string {
  const W = 820;
  const labelW = Math.min(280, Math.max(...o.items.map((c) => textWidth(c.label))) + 16);
  const left = 20 + labelW;
  const right = 130;
  const row = 40;
  const top = 92;
  const H = top + o.items.length * row + 30;
  const k = o.scale ?? 1;
  const vals = o.items.flatMap((x) => [x.low.value, x.high.value]).map((v) => v / k);
  const ts = ticks(Math.min(0, ...vals), Math.max(...vals), 6);
  const a = ts[0] as number;
  const b = ts[ts.length - 1] as number;
  const px = (v: number) => left + ((v - a) / (b - a)) * (W - left - right);
  let body = '';
  for (const t of ts) body += `<line x1="${px(t)}" x2="${px(t)}" y1="${top - 6}" y2="${H - 26}" class="${t === 0 ? 'base' : 'grid'}"/><text x="${px(t)}" y="${H - 10}" text-anchor="middle" class="ax">${num(t, 1)}${o.unit ?? ''}</text>`;
  const bx = px(o.base / k);
  body += `<line x1="${bx}" x2="${bx}" y1="${top - 14}" y2="${H - 26}" stroke="var(--ink)" stroke-width="1.5"/><text x="${bx}" y="${top - 18}" text-anchor="middle" class="lab">基准 ${num(o.base / k, 1)}${o.unit ?? ''}</text>`;
  body += `<rect x="20" y="58" width="12" height="12" rx="3" fill="var(--s2)"/><text x="38" y="68" class="lab">取低值</text><rect x="100" y="58" width="12" height="12" rx="3" fill="var(--s1)"/><text x="118" y="68" class="lab">取高值</text>`;
  o.items.forEach((it, i) => {
    const y = top + i * row;
    body += `<text x="${left - 10}" y="${y + 14}" text-anchor="end" class="lab">${esc(it.label)}</text>`;
    const sides = [
      [it.low, it.high, 'var(--s2)'],
      [it.high, it.low, 'var(--s1)'],
    ] as const;
    for (const [side, other, color] of sides) {
      const x = px(side.value / k);
      body += `<rect x="${Math.min(x, bx)}" y="${y + 3}" width="${Math.max(1, Math.abs(x - bx))}" height="14" rx="3" fill="${color}" stroke="var(--bg)" stroke-width="1"/>`;
      // 文字放在柱子外端；和基准相同的一侧放到另一侧的对面，免得重叠
      let dir = Math.sign(side.value - o.base);
      if (dir === 0) dir = -Math.sign(other.value - o.base) || -1;
      const tx = dir < 0 ? Math.min(x, bx) - 4 : Math.max(x, bx) + 4;
      body += `<text x="${tx}" y="${y + 27}" text-anchor="${dir < 0 ? 'end' : 'start'}" class="ax">${esc(side.label)}：${num(side.value / k, 1)}${o.unit ?? ''}</text>`;
    }
  });
  return frame(W, H, o.title, o.subtitle, body, o.label ?? o.title);
}

/**
 * 门店平面图（报告用）：和网页模拟器同样的配色，格子按行合并成矩形。
 */
export function floorPlan(l: import('../world/layout').Layout, title: string, subtitle: string): string {
  const s = 8;
  const top = 64;
  const W = l.width * s + 40;
  const H = l.height * s + top + 20;
  const ox = 20;
  const style = `
    .fp-out{fill:#e7e5de}.fp-floor{fill:#fcfcfb}.fp-back{fill:#f2efe6}.fp-wall{fill:#52514e}.fp-shelf{fill:#cfcdc4}.fp-chill{fill:#bfd7f2}.fp-frozen{fill:#9fc0ea}.fp-bakery{fill:#ead8bd}.fp-fix{fill:#b5b3a9}.fp-mfc{fill:#f3e3b5}.fp-locker{fill:#ddd6f5}.fp-lane{fill:#d6d4cc}.fp-zone{fill:rgba(42,120,214,0.07);stroke:rgba(42,120,214,0.35);stroke-dasharray:3 3}
    .fp-lab{fill:#4a4945;font-size:10px}
    @media (prefers-color-scheme: dark){.fp-out{fill:#141413}.fp-floor{fill:#1f1f1d}.fp-back{fill:#252421}.fp-wall{fill:#898781}.fp-shelf{fill:#45443f}.fp-chill{fill:#26425f}.fp-frozen{fill:#2c5180}.fp-bakery{fill:#4c3f2c}.fp-fix{fill:#3a3935}.fp-mfc{fill:#3d3522}.fp-locker{fill:#352f4f}.fp-lane{fill:#2a2a27}.fp-zone{fill:rgba(57,135,229,0.1);stroke:rgba(57,135,229,0.45)}.fp-lab{fill:#c3c2b7}}`;
  let body = `<g transform="translate(${ox},${top})"><rect width="${l.width * s}" height="${l.height * s}" class="fp-out"/>`;
  // 地面（按行合并）
  const runs = (want: (c: number) => boolean, cls: string) => {
    let out = '';
    for (let y = 0; y < l.height; y++) {
      let x = 0;
      while (x < l.width) {
        if (!want(l.cells[y * l.width + x] as number)) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < l.width && want(l.cells[y * l.width + x] as number)) x++;
        out += `<rect x="${x0 * s}" y="${y * s}" width="${(x - x0) * s}" height="${s}" class="${cls}"/>`;
      }
    }
    return out;
  };
  body += runs((c) => c === 1 || c === 5 || c === 3 || c === 4, 'fp-floor');
  for (const r of l.rects) {
    const cls = r.kind === 'backroom' ? 'fp-back' : r.kind === 'lane' ? 'fp-lane' : r.kind === 'lockers' ? 'fp-locker' : r.kind === 'mfc' ? 'fp-mfc' : r.kind === 'zone' || r.kind === 'checkout' ? 'fp-zone' : '';
    if (cls) body += `<rect x="${r.x * s}" y="${r.y * s}" width="${r.w * s}" height="${r.h * s}" class="${cls}"/>`;
  }
  for (const r of l.rects) {
    if (r.kind !== 'shelf' && r.kind !== 'fixture') continue;
    const cat = r.category;
    const cls = r.kind === 'fixture' ? 'fp-fix' : cat === 'frozen' ? 'fp-frozen' : cat === 'dairy' || cat === 'meat' || cat === 'produce' ? 'fp-chill' : cat === 'bakery' ? 'fp-bakery' : 'fp-shelf';
    body += `<rect x="${r.x * s + 0.5}" y="${r.y * s + 0.5}" width="${r.w * s - 1}" height="${r.h * s - 1}" rx="1" class="${cls}"/>`;
  }
  body += runs((c) => c === 2, 'fp-wall');
  // 文字：放得下横写，又高又窄竖写，小设施写在上方
  for (const r of l.rects) {
    if (!r.label) continue;
    const rw = r.w * s;
    const rh = r.h * s;
    const cx = (r.x + r.w / 2) * s;
    const cy = (r.y + r.h / 2) * s;
    const tw = textWidth(r.label, 10);
    if (r.kind === 'backroom') body += `<text x="${r.x * s + 6}" y="${r.y * s + 12}" class="fp-lab">${esc(r.label)}</text>`;
    else if (tw <= rw - 4) body += `<text x="${cx}" y="${r.kind === 'zone' && rh > 36 ? r.y * s + 13 : cy + 3.5}" text-anchor="middle" class="fp-lab">${esc(r.label)}</text>`;
    else if (rh > rw && tw <= rh - 4) body += `<text transform="translate(${cx + 3.5},${cy}) rotate(-90)" text-anchor="middle" class="fp-lab">${esc(r.label)}</text>`;
    else body += `<text x="${cx}" y="${r.y * s - 4}" text-anchor="middle" class="fp-lab">${esc(r.label)}</text>`;
  }
  body += '</g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" class="viz"><style>${STYLE}${style}</style><rect width="${W}" height="${H}" rx="8" fill="var(--bg)"/><text x="20" y="28" class="t">${esc(title)}</text><text x="20" y="48" class="st">${esc(subtitle)}</text>${body}</svg>\n`;
}
