import { footprintKm } from '../region/frames';
import { buildGraph, currentRegion, STORE } from '../region/network';
import { COAST, FRAMES, NODES, RAIL, RAIL_DC_INDEX, RUNWAY, type Km } from '../region/region';
import { BOUNDS, DIR_LABEL, dirOf, LOCAL } from '../region/regionGen';

/**
 * 区域地图（报告用 SVG）：海岸、河、城区、高速、绕城快速路、高架、干道、铁路和车站、港口、机场、物流园和那家综合店。
 */
const STYLE = `
  .viz{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--land:#eef0e8;--city:#e3e5da;--sea:#cfe2f3;--river:#9cc3e4;--hw:#e8a33d;--ring:#d98f3e;--via:#8a5cc7;--art:#b8b5aa;--rail:#5a5a5a;--flag:#e34948;--node:#1baf7a}
  @media (prefers-color-scheme: dark){.viz{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--land:#22231f;--city:#2b2c27;--sea:#1d2f44;--river:#2d4e70;--hw:#c98500;--ring:#b46d2a;--via:#a684dc;--art:#4a4945;--rail:#9b9b95;--flag:#e66767;--node:#199e70}}
  text{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;fill:var(--ink2);font-size:11px}
  .t{fill:var(--ink);font-size:15px;font-weight:600}
  .lab{fill:var(--ink);font-size:12px;font-weight:600}
  .s{fill:var(--ink2);font-size:10px}
`;

export interface MapOptions {
  /** 内联到网页时用：给 SVG 一个 id，样式的选择器都加上它的前缀（不影响页面上别的 SVG），裁剪区的 id 也换掉 */
  scope?: string;
  title?: string;
  subtitle?: string;
  aria?: string;
  /** 不画综合店和默认的图例（网络规划自己画门店、图例在网页上） */
  bare?: boolean;
  /** 在设施之上再画的内容：拿到公里 → 像素的换算和地图的范围 */
  overlay?: (P: (p: Km) => readonly [number, number], box: { x: number; y: number; w: number; h: number }) => string;
}

/** 网络规划的底图：道路换成浅灰，颜色留给仓和线路 */
function muted(id: string): string {
  const light = `--hw:#b9b5a8;--ring:#aca89c;--via:#c2b9d8;--art:#d2cfc5`;
  const dark = `--hw:#5c5a55;--ring:#55534e;--via:#5d5670;--art:#3a3936`;
  return `\n  #${id}{${light}}\n  @media (prefers-color-scheme: dark){:root:not([data-theme='light']) #${id}{${dark}}}\n  :root[data-theme='dark'] #${id}{${dark}}\n`;
}

/** 把样式的选择器限定在一个 id 下 */
function scoped(style: string, id: string): string {
  return style.replace(/\.viz\{/g, `#${id}{`).replace(/(^|\n)\s*text\{/g, `$1  #${id} text{`).replace(/(^|\n)\s*\.(t|lab|s)\{/g, `$1  #${id} .$2{`);
}

export function regionMap(o: MapOptions = {}): string {
  const plan = currentRegion();
  const clip = o.scope ? `${o.scope}-clip` : 'rm-clip';
  // 网络规划的底图：设施画成中性的灰色，颜色留给仓和门店
  const node = o.bare ? 'var(--ink2)' : 'var(--node)';
  const W = 900;
  const H = 680;
  // 公里 → 像素（整个区域）
  const { x0, x1, y0, y1 } = BOUNDS;
  const sx = Math.min((W - 40) / (x1 - x0), (H - 100) / (y1 - y0));
  const ox = 20 + (W - 40 - (x1 - x0) * sx) / 2;
  const oy = 64;
  const P = (p: Km) => [ox + (p.x - x0) * sx, oy + (y1 - p.y) * sx] as const;
  const pts = (list: readonly Km[]) => list.map((p) => P(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const g = buildGraph();
  const [rx, ry] = P({ x: x0, y: y1 });
  const rw = (x1 - x0) * sx;
  const rh = (y1 - y0) * sx;
  let body = `<defs><clipPath id="${clip}"><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"/></clipPath></defs><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="var(--sea)"/><g clip-path="url(#${clip})">`;
  // 陆地：海岸线朝陆地一侧
  const sd = plan.seaDir;
  const f0 = COAST[0] as Km;
  const f1 = COAST[COAST.length - 1] as Km;
  body += `<polygon points="${pts([...COAST, { x: f1.x - sd.x * 160, y: f1.y - sd.y * 160 }, { x: f0.x - sd.x * 160, y: f0.y - sd.y * 160 }])}" fill="var(--land)"/>`;
  for (const isl of plan.islands ?? []) body += `<polygon points="${pts(isl)}" fill="var(--land)"/>`;
  body += `<polygon points="${pts(plan.city.boundary)}" fill="var(--city)"/>`;
  if (plan.river) body += `<polyline points="${pts(plan.river.pts)}" fill="none" stroke="var(--river)" stroke-width="${Math.max(2.4, plan.river.width * sx)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // 支流、海里的岛（随机区域才有）
  for (const b of plan.river?.branches ?? []) body += `<polyline points="${pts(b)}" fill="none" stroke="var(--river)" stroke-width="${Math.max(1.8, (plan.river?.branchWidth ?? 0.22) * sx)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // 设施占地
  for (const [f, rc] of [
    [FRAMES.port, LOCAL.port.rect],
    [FRAMES.airport, LOCAL.airport.rect],
    [FRAMES.park, LOCAL.park.rect],
  ] as const)
    body += `<polygon points="${pts(footprintKm(f, rc))}" fill="${node}" fill-opacity="0.16" stroke="${node}" stroke-opacity="0.5"/>`;
  // 道路：高速、绕城快速路、高架、干道
  const viaduct = plan.viaduct;
  for (const e of g.edges) {
    const isVia = !!viaduct && e.cls === 'ring' && ((e.a === viaduct.a && e.b === viaduct.b) || (e.a === viaduct.b && e.b === viaduct.a));
    const cls = e.cls;
    const color = isVia ? 'var(--via)' : cls === 'highway' ? 'var(--hw)' : cls === 'ring' ? 'var(--ring)' : 'var(--art)';
    const w = cls === 'highway' ? 3 : cls === 'ring' ? 3.2 : cls === 'arterial' ? 1.6 : 1;
    body += `<polyline points="${pts(e.pts)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // 铁路：虚线；车站：方块
  body += `<polyline points="${pts(RAIL)}" fill="none" stroke="var(--rail)" stroke-width="2.4" stroke-dasharray="7 4"/>`;
  // 跑道
  body += `<polyline points="${pts([RUNWAY.a, RUNWAY.b])}" fill="none" stroke="var(--ink2)" stroke-width="5"/>`;
  body += '</g>';
  const station = (k: Km, label: string, dx: number, dy: number) => {
    const [x, y] = P(k);
    body += `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="var(--bg)" stroke="var(--rail)" stroke-width="2"/><text x="${x + dx}" y="${y + dy}" class="s">${label}</text>`;
  };
  station(RAIL[0] as Km, '港口铁路站', 8, 12);
  station(RAIL[RAIL_DC_INDEX] as Km, '物流园铁路货运站', 8, -8);
  if (plan.railPassenger) {
    let acc = 0;
    let at = RAIL[0] as Km;
    for (let i = 1; i < RAIL.length; i++) {
      const a = RAIL[i - 1] as Km;
      const b = RAIL[i] as Km;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + d >= plan.railPassenger.s) {
        const t = (plan.railPassenger.s - acc) / (d || 1);
        at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        break;
      }
      acc += d;
    }
    station(at, plan.railPassenger.name, 8, -8);
  }
  // 设施
  const facility = (key: string, label: string, dx = 8, dy = -8) => {
    const [x, y] = P(NODES[key] as Km);
    body += `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="3" ${o.bare ? 'fill="var(--bg)" stroke="var(--ink2)" stroke-width="1.5"' : 'fill="var(--node)" stroke="var(--bg)" stroke-width="2"'}/><text x="${x + dx}" y="${y + dy}" class="${o.bare ? 's' : 'lab'}">${label}</text>`;
  };
  facility('PORT', '集装箱港口', 10, 18);
  facility('AIR', '机场货运区', 10, -10);
  if (o.bare) {
    // 网络规划的底图：物流园由上面一层画，高速口只写方向（标签短，给仓和门店的标签留地方）
    facility('NORTH', `${DIR_LABEL[dirOf(plan.offmap.NORTH)]}高速口（国内）`, 10, 4);
    facility('EAST', `${DIR_LABEL[dirOf(plan.offmap.EAST)]}高速口（跨境）`, 10, 16);
  } else {
    facility('DC', '物流园（配送中心）', 12, 20);
    facility('NORTH', `往${DIR_LABEL[dirOf(plan.offmap.NORTH)]}：国内供应商、内陆产区`, 10, 4);
    facility('EAST', `往${DIR_LABEL[dirOf(plan.offmap.EAST)]}：跨境公路（洲际）`, 10, 16);
  }
  if (o.overlay) body += o.overlay(P, { x: rx, y: ry, w: rw, h: rh });
  // 门店：区域里只有一家综合店
  const [sx0, sy0] = P(STORE.km);
  if (!o.bare) body += `<circle cx="${sx0}" cy="${sy0}" r="8" fill="var(--flag)" stroke="var(--bg)" stroke-width="2"/><text x="${sx0 + 12}" y="${sy0 + 4}" class="lab">${STORE.name}</text>`;
  // 铁路出区域：洲际班列
  const [ex, ey] = P(RAIL[RAIL.length - 1] as Km);
  if (!o.bare) body += `<text x="${Math.min(W - 24, Math.max(24, ex))}" y="${Math.min(H - 30, Math.max(74, ey - 22))}" text-anchor="${ex > W / 2 ? 'end' : 'start'}" class="s">洲际铁路班列（往${DIR_LABEL[dirOf(RAIL[RAIL.length - 1] as Km)]}）</text>`;
  // 图例
  // 图例放在右上角，底下垫一块半透明的底
  const legend = !o.bare;
  const lgx = rx + rw - 236;
  if (legend) body += `<rect x="${lgx - 8}" y="${ry + 8}" width="236" height="140" rx="6" fill="var(--bg)" fill-opacity="0.82"/>`;
  const lg = (y: number, html: string, label: string) => (legend ? (body += `<g transform="translate(${lgx},${y})">${html}<text x="34" y="4">${label}</text></g>`) : body);
  const ly = ry + 160;
  lg(ly - 126, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--hw)" stroke-width="3"/>', '高速');
  lg(ly - 108, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--ring)" stroke-width="3"/>', '绕城快速路');
  lg(ly - 90, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--via)" stroke-width="3"/>', '高架快速路');
  lg(ly - 72, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--art)" stroke-width="1.6"/>', '城市干道');
  lg(ly - 54, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--rail)" stroke-width="2.4" stroke-dasharray="7 4"/>', '铁路（港口 → 物流园 → 洲际线）');
  lg(ly - 36, '<line x1="0" y1="0" x2="26" y2="0" stroke="var(--river)" stroke-width="4"/>', '河');
  lg(ly - 18, '<circle cx="13" cy="0" r="6" fill="var(--flag)"/>', '综合店（区域里唯一的门店）');
  // 比例尺
  const bx = rx + rw - 14 - 10 * sx;
  const by = ry + rh - 16;
  body += `<line x1="${bx}" y1="${by}" x2="${bx + 10 * sx}" y2="${by}" stroke="var(--ink2)" stroke-width="2"/><text x="${bx}" y="${by - 6}" class="s">10 公里</text>`;
  const sub = plan.spec.mode === 'default' ? '默认区域' : `${plan.spec.mode === 'random' ? '随机生成' : '自定义'}的区域 · 编号 ${plan.spec.seed}`;
  const title = o.title ?? `区域：综合店和物流设施（${sub}）`;
  const subtitle = o.subtitle ?? '1 家综合店、1 个物流园（配送中心 + 铁路货运站 + 中央面包房）、集装箱港口、机场货运区、国内（含内陆产区）和跨境的长途公路；虚构的区域';
  const head = o.scope ? `id="${o.scope}" ` : '';
  return `<svg ${head}xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${o.aria ?? '区域地图：综合店和物流设施'}" class="viz"><style>${o.scope ? scoped(STYLE, o.scope) + (o.bare ? muted(o.scope) : '') : STYLE}</style><rect width="${W}" height="${H}" rx="8" fill="var(--bg)"/><text x="20" y="30" class="t">${title}</text><text x="20" y="48" class="s">${subtitle}</text>${body}</svg>\n`;
}
