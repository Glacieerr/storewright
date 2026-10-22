import { formatCustomerName, type OrderType, type TempZone } from '@storewright/domain';
import { qrSvgPath } from './qr';

/**
 * 取货框标签（工作流设计 5.1 节，样本见 docs/samples/labels.md）：4" × 2"，203 dpi，单色热敏。
 * 温区不靠颜色区分：黑底反白条带 + 图标 + 名称 + 大字母代码。二维码只含不透明标签 ID。
 */
export interface ToteLabelData {
  labelId: string;
  version: number;
  /** 内部物理框编号（可选） */
  toteNo?: string;
  /** 件的类型：取货框（默认）或大件（先扫后打，一件一签） */
  kind?: 'TOTE' | 'PIECE';
  firstName: string;
  lastName: string;
  /** 姓名长度上限（决策 L-02） */
  nameMaxLength: number;
  orderShortCode: string;
  index: number;
  count: number;
  /** 时段起点（毫秒），按门店时区显示 */
  slotStart: number;
  timeZone?: string;
  type: OrderType;
  tempZone: TempZone;
  ageRestricted: boolean;
  chemical: boolean;
}

export const LABEL_WIDTH = 812;
export const LABEL_HEIGHT = 406;

const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace";
const ZONE_LETTER: Record<TempZone, string> = { AMBIENT: 'A', CHILLED: 'C', FROZEN: 'F', HOT: 'H' };

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 标签 ID 的人工输入形式：`SW1:L7Q4K2M9X` → `L7Q4-K2M9-X` */
export function humanLabelId(labelId: string): string {
  const body = labelId.replace(/^SW1:/, '');
  return `${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

/** 时段起点 HH:MM（24 小时制） */
export function slotClock(ms: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
}

/** 底部的特殊标记 */
export function labelBadges(d: Pick<ToteLabelData, 'ageRestricted' | 'chemical' | 'tempZone'>): string[] {
  const out: string[] = [];
  if (d.ageRestricted) out.push('21+ ID CHECK');
  if (d.chemical) out.push('CHEMICAL');
  if (d.tempZone === 'HOT') out.push('HOT');
  return out;
}

function zoneIcon(zone: TempZone, cx: number, cy: number, s: number): string {
  const w = 'stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  switch (zone) {
    case 'AMBIENT':
      return `<g ${w}><path d="M${cx - s} ${cy - s * 0.5}L${cx} ${cy - s}L${cx + s} ${cy - s * 0.5}L${cx + s} ${cy + s * 0.6}L${cx} ${cy + s * 1.1}L${cx - s} ${cy + s * 0.6}Z"/><path d="M${cx - s} ${cy - s * 0.5}L${cx} ${cy}L${cx + s} ${cy - s * 0.5}M${cx} ${cy}V${cy + s * 1.1}"/></g>`;
    case 'CHILLED':
      return `<g ${w}><path d="M${cx} ${cy - s * 1.1}C${cx + s * 0.9} ${cy - s * 0.1} ${cx + s * 0.9} ${cy + s} ${cx} ${cy + s}C${cx - s * 0.9} ${cy + s} ${cx - s * 0.9} ${cy - s * 0.1} ${cx} ${cy - s * 1.1}Z"/></g>`;
    case 'FROZEN': {
      let d = '';
      for (let k = 0; k < 3; k++) {
        const a = (Math.PI / 3) * k;
        const dx = Math.cos(a) * s;
        const dy = Math.sin(a) * s;
        d += `M${(cx - dx).toFixed(1)} ${(cy - dy).toFixed(1)}L${(cx + dx).toFixed(1)} ${(cy + dy).toFixed(1)}`;
      }
      return `<path d="${d}" ${w}/>`;
    }
    case 'HOT':
      return `<g ${w}><path d="M${cx} ${cy + s}C${cx - s} ${cy + s} ${cx - s} ${cy} ${cx - s * 0.4} ${cy - s * 0.4}C${cx - s * 0.2} ${cy} ${cx} ${cy} ${cx} ${cy - s}C${cx + s * 0.4} ${cy - s * 0.5} ${cx + s} ${cy} ${cx + s * 0.8} ${cy + s * 0.5}C${cx + s * 0.6} ${cy + s} ${cx + s * 0.3} ${cy + s} ${cx} ${cy + s}Z"/></g>`;
  }
}

function badge(x: number, y: number, text: string, size: number, inverse: boolean): { svg: string; w: number } {
  const w = Math.round(text.length * size * 0.66 + 24);
  const h = size + 16;
  const tx = x + w / 2;
  const ty = y + h / 2 + size * 0.36;
  if (inverse) return { svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#000"/><text x="${tx}" y="${ty}" font-family="${FONT}" font-weight="800" font-size="${size}" fill="#fff" text-anchor="middle">${esc(text)}</text>`, w };
  return { svg: `<rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}" rx="8" fill="#fff" stroke="#000" stroke-width="4"/><text x="${tx}" y="${ty}" font-family="${FONT}" font-weight="800" font-size="${size}" fill="#000" text-anchor="middle">${esc(text)}</text>`, w };
}

/** SVG 预览 */
export function toteLabelSvg(d: ToteLabelData): string {
  const W = LABEL_WIDTH;
  const H = LABEL_HEIGHT;
  const name = formatCustomerName(d.firstName, d.lastName, d.nameMaxLength);
  const x0 = 290;
  const xr = 788;
  let s = qrSvgPath(d.labelId, 22, 22, 240);
  if (d.toteNo) s += `<text x="142" y="300" font-family="${MONO}" font-weight="700" font-size="34" text-anchor="middle">${esc(d.toteNo)}</text>`;
  s += `<text x="142" y="336" font-family="${MONO}" font-size="22" text-anchor="middle">${esc(humanLabelId(d.labelId))} · v${d.version}</text>`;
  s += `<text x="${x0}" y="74" font-family="${FONT}" font-weight="800" font-size="48">${esc(name)}</text>`;
  s += `<text x="${x0}" y="134" font-family="${FONT}" font-size="22" font-weight="600">ORDER</text>`;
  s += `<text x="${x0 + 88}" y="136" font-family="${MONO}" font-weight="800" font-size="40">${esc(d.orderShortCode)}</text>`;
  s += `<text x="${xr}" y="136" font-family="${FONT}" font-weight="800" font-size="44" text-anchor="end">${d.kind === 'PIECE' ? 'PIECE' : 'TOTE'} ${d.index}/${d.count}</text>`;
  s += `<text x="${x0}" y="182" font-family="${FONT}" font-size="22" font-weight="600">SLOT</text>`;
  s += `<text x="${x0}" y="240" font-family="${FONT}" font-weight="800" font-size="62">${esc(slotClock(d.slotStart, d.timeZone))}</text>`;
  const tb = badge(0, 0, d.type, 32, true);
  s += badge(xr - tb.w, 186, d.type, 32, true).svg;
  s += `<rect x="${x0}" y="262" width="${xr - x0}" height="76" rx="10" fill="#000"/>`;
  s += zoneIcon(d.tempZone, x0 + 42, 300, 22);
  s += `<text x="${x0 + 84}" y="316" font-family="${FONT}" font-weight="800" font-size="44" fill="#fff" letter-spacing="2">${d.tempZone}</text>`;
  s += `<text x="${xr - 18}" y="324" font-family="${FONT}" font-weight="900" font-size="64" fill="#fff" text-anchor="end">${ZONE_LETTER[d.tempZone]}</text>`;
  let bx = x0;
  for (const b of labelBadges(d)) {
    const bb = badge(bx, 348, b, 26, false);
    s += bb.svg;
    bx += bb.w + 10;
  }
  const title = `${d.kind === 'PIECE' ? 'Piece' : 'Tote'} label ${d.orderShortCode} ${d.index}/${d.count}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="#fff" stroke="#9aa0a6" stroke-width="2"/>${s}</svg>`;
}

/** ZPL 字段内容转义：^ ~ _ 用 ^FH 的十六进制写法 */
export function zplField(text: string): string {
  return `^FH_^FD${text.replace(/_/g, '_5F').replace(/\^/g, '_5E').replace(/~/g, '_7E')}^FS`;
}

/** ZPL 打印模板（Zebra 热敏打印机，203 dpi，4" × 2"） */
export function toteLabelZpl(d: ToteLabelData): string {
  const name = formatCustomerName(d.firstName, d.lastName, d.nameMaxLength);
  const lines = [
    '^XA',
    '^CI28',
    `^PW${LABEL_WIDTH}`,
    `^LL${LABEL_HEIGHT}`,
    // 二维码：模型 2，放大 6 倍，纠错等级 M，自动编码
    `^FO30,22^BQN,2,6^FDMA,${d.labelId}^FS`,
    d.toteNo ? `^FO30,280^A0N,34,34${zplField(d.toteNo)}` : '',
    `^FO30,320^A0N,22,22${zplField(`${humanLabelId(d.labelId)} v${d.version}`)}`,
    `^FO290,30^A0N,48,48${zplField(name)}`,
    `^FO290,100^A0N,22,22^FDORDER^FS`,
    `^FO378,96^A0N,40,40${zplField(d.orderShortCode)}`,
    `^FO560,94^FB228,1,0,R^A0N,44,44^FD${d.kind === 'PIECE' ? 'PIECE' : 'TOTE'} ${d.index}/${d.count}^FS`,
    `^FO290,160^A0N,22,22^FDSLOT^FS`,
    `^FO290,186^A0N,62,62${zplField(slotClock(d.slotStart, d.timeZone))}`,
    `^FO560,190^GB228,48,48^FS`,
    `^FO560,198^FB228,1,0,C^A0N,32,32^FR^FD${d.type}^FS`,
    `^FO290,262^GB498,76,76^FS`,
    `^FO310,280^A0N,44,44^FR^FD${d.tempZone}^FS`,
    `^FO700,268^FB70,1,0,R^A0N,64,64^FR^FD${ZONE_LETTER[d.tempZone]}^FS`,
  ];
  let bx = 290;
  for (const b of labelBadges(d)) {
    const w = Math.round(b.length * 26 * 0.66 + 24);
    lines.push(`^FO${bx},350^GB${w},40,4^FS`, `^FO${bx},358^FB${w},1,0,C^A0N,26,26${zplField(b)}`);
    bx += w + 10;
  }
  lines.push('^XZ');
  return lines.filter(Boolean).join('\n');
}
