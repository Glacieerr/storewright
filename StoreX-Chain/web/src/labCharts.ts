import { t as tr } from './i18n';
/**
 * 「对比与报告」页预测和演练用的折线图：内嵌 SVG（跟着页面的浅色 / 深色），竖线跟着指针找最近的 x，
 * 提示框列出这一点上所有系列的值（键盘左右键也能移动）；两条以上的线有图例和线尾标注；每张图下面有数据表。
 * 颜色按角色：参考线（实际、没有扰动）用中性灰，其余按固定顺序蓝、橙、青（页面的 --c1/--c2/--c3）。
 */
export interface LineSeries {
  name: string;
  color: string;
  values: (number | null)[];
  markers?: boolean;
}
export interface LineChartSpec {
  title: string;
  subtitle?: string;
  /** 每个点的 x 标签（提示框和数据表用） */
  x: string[];
  /** 横轴上标哪些点（返回刻度文字；不给就均匀标 6 个左右） */
  tick?: (i: number) => string | undefined;
  series: LineSeries[];
  fmt: (v: number) => string;
  yMin?: number;
  yMax?: number;
  /** 阴影标出的一段（x 的下标，左闭右开） */
  band?: { from: number; to: number; label: string };
  aria: string;
}

const SVG = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const text = (parent: Element, x: number, y: number, s: string, cls: string, anchor = 'start') => {
  const t = el('text', { x, y, class: cls, 'text-anchor': anchor }, parent);
  t.textContent = s;
  return t;
};
function ticks(min: number, max: number, n = 4): number[] {
  if (max <= min) max = min + 1;
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => (max - min) / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let k = Math.floor(min / step + 1e-9); k <= Math.ceil(max / step - 1e-9); k++) out.push(Number((k * step).toPrecision(12)));
  return out;
}

/** 在 host 里画一张折线图；返回清理函数 */
export function mountLineChart(host: HTMLElement, spec: LineChartSpec): () => void {
  host.classList.add('lc');
  host.replaceChildren();
  const h4 = document.createElement('h4');
  h4.textContent = spec.title;
  host.appendChild(h4);
  if (spec.subtitle) {
    const p = document.createElement('p');
    p.className = 'lc-sub';
    p.textContent = spec.subtitle;
    host.appendChild(p);
  }
  if (spec.series.length > 1) {
    const lg = document.createElement('div');
    lg.className = 'lc-legend';
    for (const s of spec.series) {
      const it = document.createElement('span');
      const key = document.createElement('i');
      key.style.background = s.color;
      it.append(key, document.createTextNode(s.name));
      lg.appendChild(it);
    }
    host.appendChild(lg);
  }
  const plot = document.createElement('div');
  plot.className = 'lc-plot';
  host.appendChild(plot);
  const tip = document.createElement('div');
  tip.className = 'lc-tip';
  tip.hidden = true;
  // 数据表（不用悬停也能看到每个值）
  const det = document.createElement('details');
  det.className = 'lc-table';
  const sum = document.createElement('summary');
  sum.textContent = tr('数据表');
  const tbl = document.createElement('table');
  const head = tbl.createTHead().insertRow();
  for (const h of ['', ...spec.series.map((s) => s.name)]) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = tbl.createTBody();
  spec.x.forEach((xl, i) => {
    const r = body.insertRow();
    r.insertCell().textContent = xl;
    for (const s of spec.series) {
      const v = s.values[i];
      r.insertCell().textContent = v === null || v === undefined || !Number.isFinite(v) ? '—' : spec.fmt(v);
    }
  });
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.appendChild(tbl);
  det.append(sum, wrap);
  host.appendChild(det);

  let idx = spec.x.length - 1;
  const render = () => {
    const W = Math.max(300, Math.round(plot.clientWidth || 640));
    const H = 240;
    const labelW = spec.series.length > 1 ? Math.min(120, Math.max(...spec.series.map((s) => s.name.length)) * 12 + 14) : 12;
    const m = { l: 46, r: labelW, t: 14, b: 28 };
    const vals = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    let lo = spec.yMin ?? Math.min(...vals);
    let hi = spec.yMax ?? Math.max(...vals);
    if (!(hi > lo)) hi = lo + 1;
    const ys = ticks(lo, hi);
    lo = Math.min(lo, ys[0] as number);
    hi = Math.max(hi, ys[ys.length - 1] as number);
    const n = spec.x.length;
    const X = (i: number) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    plot.replaceChildren();
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.aria, tabindex: 0 }, plot);
    if (spec.band) {
      const x0 = X(Math.max(0, spec.band.from - 0.5));
      const x1 = X(Math.min(n - 1, spec.band.to - 0.5));
      el('rect', { x: x0, y: m.t, width: Math.max(1, x1 - x0), height: H - m.t - m.b, class: 'lc-band' }, svg);
      text(svg, x0 + 4, m.t + 12, spec.band.label, 'lc-band-t');
    }
    for (const v of ys) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === ys[0] ? 'lc-base' : 'lc-grid' }, svg);
      text(svg, m.l - 6, Y(v) + 4, spec.fmt(v), 'lc-ax', 'end');
    }
    // 横轴刻度：窄屏时隔开画，不让文字挤在一起（中文按 11 像素一个字估宽度）
    const every = Math.max(1, Math.ceil(n / 6));
    const wOf = (s: string) => [...s].reduce((a, c) => a + (/[⺀-￿]/.test(c) ? 11 : 6.4), 0);
    let lastRight = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = spec.tick ? spec.tick(i) : i % every === 0 ? spec.x[i] : undefined;
      if (!t) continue;
      const half = wOf(t) / 2;
      if (X(i) - half < lastRight + 8) continue;
      lastRight = X(i) + half;
      text(svg, X(i), H - 8, t, 'lc-ax', 'middle');
    }
    const ends: { y: number; ty: number; name: string; x: number }[] = [];
    for (const s of spec.series) {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      el('path', { d, class: 'lc-line', stroke: s.color }, svg);
      if (s.markers) s.values.forEach((v, i) => v !== null && Number.isFinite(v) && el('circle', { cx: X(i), cy: Y(v), r: 4, class: 'lc-dot', fill: s.color }, svg));
      let last = s.values.length - 1;
      while (last >= 0 && (s.values[last] === null || !Number.isFinite(s.values[last] as number))) last--;
      if (last >= 0 && spec.series.length > 1) ends.push({ y: Y(s.values[last] as number), ty: Y(s.values[last] as number), name: s.name, x: X(last) });
    }
    // 线尾标注：按高低排开，最少隔 13 像素；离开线尾太远的画一条引线
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) (ends[i] as (typeof ends)[number]).ty = Math.max((ends[i] as (typeof ends)[number]).ty, (ends[i - 1] as (typeof ends)[number]).ty + 13);
    const over = (ends[ends.length - 1]?.ty ?? 0) - (H - m.b);
    if (over > 0) for (const e of ends) e.ty -= over;
    for (const e of ends) {
      if (Math.abs(e.ty - e.y) > 3) el('path', { d: `M${e.x + 3},${e.y}L${e.x + 8},${e.ty - 4}`, class: 'lc-lead' }, svg);
      text(svg, e.x + 10, e.ty, e.name, 'lc-end');
    }
    // 悬停：竖线 + 提示框
    const cross = el('line', { x1: 0, x2: 0, y1: m.t, y2: H - m.b, class: 'lc-cross', visibility: 'hidden' }, svg);
    const hot = el('g', {}, svg);
    const hit = el('rect', { x: m.l, y: m.t, width: Math.max(1, W - m.l - m.r), height: H - m.t - m.b, fill: 'transparent' }, svg);
    const show = (i: number, px?: number) => {
      idx = Math.max(0, Math.min(n - 1, i));
      const x = X(idx);
      cross.setAttribute('x1', String(x));
      cross.setAttribute('x2', String(x));
      cross.setAttribute('visibility', 'visible');
      hot.replaceChildren();
      tip.replaceChildren();
      const title = document.createElement('div');
      title.className = 'lc-tip-x';
      title.textContent = spec.x[idx] ?? '';
      tip.appendChild(title);
      for (const s of spec.series) {
        const v = s.values[idx];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        el('circle', { cx: x, cy: Y(v), r: 4, class: 'lc-dot', fill: s.color }, hot);
        const row = document.createElement('div');
        row.className = 'lc-tip-row';
        const key = document.createElement('i');
        key.style.background = s.color;
        const b = document.createElement('b');
        b.textContent = spec.fmt(v);
        const nm = document.createElement('span');
        nm.textContent = s.name;
        row.append(key, b, nm);
        tip.appendChild(row);
      }
      tip.hidden = false;
      const tw = tip.offsetWidth || 160;
      const left = (px ?? x) + 14 + tw > W ? (px ?? x) - 14 - tw : (px ?? x) + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${m.t}px`;
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      hot.replaceChildren();
      tip.hidden = true;
    };
    hit.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      show(Math.round(((px - m.l) / Math.max(1, W - m.l - m.r)) * (n - 1)), px);
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        show(idx + (ev.key === 'ArrowLeft' ? -1 : 1));
      } else if (ev.key === 'Escape') hide();
    });
    plot.appendChild(tip);
  };
  render();
  let raf = 0;
  let lastW = plot.clientWidth;
  const ro = new ResizeObserver(() => {
    if (plot.clientWidth === lastW) return;
    lastW = plot.clientWidth;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  ro.observe(plot);
  return () => ro.disconnect();
}
