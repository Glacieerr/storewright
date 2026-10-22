import { caseDigitalLink, isValidUpcA } from '@storewright/domain';
import { qrSvgPath } from './qr';
import { esc, zplField } from './tote';

/**
 * 后仓箱标签（工作流设计 5.3 节，样本见 docs/samples/labels.md）：4" × 3"，单色。
 * 二维码是 GS1 Digital Link（GTIN-14 + 内部箱号）；UPC-A 条码；箱规；收货日期。
 * 仓库分区不打印在标签上，只保存在数据库里。
 */
export interface CaseLabelData {
  caseId: string;
  gtin: string;
  name: string;
  packQty: number;
  receivedAt: number;
}

export const CASE_LABEL_WIDTH = 812;
export const CASE_LABEL_HEIGHT = 609;

const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => p.replace(/./g, (b) => (b === '0' ? '1' : '0')));

/** UPC-A 的 95 个模块（1 = 黑条） */
export function upcModules(upc: string): string {
  if (!isValidUpcA(upc)) throw new Error(`bad UPC-A ${upc}`);
  const d = upc.split('').map(Number);
  return `101${d.slice(0, 6).map((x) => L[x]).join('')}01010${d.slice(6).map((x) => R[x]).join('')}101`;
}

/** GTIN-14 → UPC-A（去掉前面的 0）；不是 UPC-A 时返回 undefined */
export function upcFromGtin(gtin: string): string | undefined {
  const digits = gtin.replace(/\D/g, '');
  const upc = digits.length > 12 && /^0+$/.test(digits.slice(0, digits.length - 12)) ? digits.slice(-12) : digits;
  return isValidUpcA(upc) ? upc : undefined;
}

function upcSvg(upc: string, x: number, y: number, mw: number, h: number): string {
  const bits = upcModules(upc);
  const guard = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    out += `<rect x="${(x + i * mw).toFixed(2)}" y="${y}" width="${mw}" height="${guard.has(i) ? h + 14 : h}" fill="#000"/>`;
  }
  const ty = y + h + 30;
  out += `<text x="${x - 14}" y="${ty}" font-family="${MONO}" font-size="26" text-anchor="end">${upc[0]}</text>`;
  out += `<text x="${x + 24 * mw}" y="${ty}" font-family="${MONO}" font-size="26" text-anchor="middle" letter-spacing="4">${upc.slice(1, 6)}</text>`;
  out += `<text x="${x + 71 * mw}" y="${ty}" font-family="${MONO}" font-size="26" text-anchor="middle" letter-spacing="4">${upc.slice(6, 11)}</text>`;
  out += `<text x="${x + 95 * mw + 14}" y="${ty}" font-family="${MONO}" font-size="26">${upc[11]}</text>`;
  return out;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function caseLabelSvg(d: CaseLabelData): string {
  const W = CASE_LABEL_WIDTH;
  const H = CASE_LABEL_HEIGHT;
  const upc = upcFromGtin(d.gtin);
  let s = '';
  s += `<text x="28" y="66" font-family="${FONT}" font-size="22" font-weight="600">CASE</text>`;
  s += `<text x="100" y="70" font-family="${MONO}" font-weight="800" font-size="44">${esc(d.caseId)}</text>`;
  s += `<text x="28" y="122" font-family="${FONT}" font-weight="700" font-size="34">${esc(d.name.length > 30 ? `${d.name.slice(0, 29)}…` : d.name)}</text>`;
  s += `<text x="28" y="176" font-family="${FONT}" font-size="22" font-weight="600">CASE PACK</text>`;
  s += `<text x="28" y="226" font-family="${FONT}" font-weight="900" font-size="54">${d.packQty} EA</text>`;
  s += `<text x="270" y="176" font-family="${FONT}" font-size="22" font-weight="600">RECEIVED</text>`;
  s += `<text x="270" y="222" font-family="${MONO}" font-weight="700" font-size="36">${ymd(d.receivedAt)}</text>`;
  s += qrSvgPath(caseDigitalLink(d.gtin, d.caseId), 548, 28, 240);
  s += `<text x="668" y="292" font-family="${FONT}" font-size="18" text-anchor="middle">GS1 Digital Link</text>`;
  if (upc) {
    s += `<text x="28" y="300" font-family="${FONT}" font-size="22" font-weight="600">UPC</text>`;
    s += upcSvg(upc, 96, 320, 4, 170);
  } else {
    s += `<text x="28" y="300" font-family="${FONT}" font-size="22" font-weight="600">GTIN</text>`;
    s += `<text x="28" y="360" font-family="${MONO}" font-weight="700" font-size="40">${esc(d.gtin)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Case ${esc(d.caseId)}"><title>Case ${esc(d.caseId)}</title><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="#fff" stroke="#9aa0a6" stroke-width="2"/>${s}</svg>`;
}

/** ZPL（203 dpi，4" × 3"）：二维码 + UPC-A（打印机自动计算校验位）+ 文字 */
export function caseLabelZpl(d: CaseLabelData): string {
  const upc = upcFromGtin(d.gtin);
  return [
    '^XA',
    '^CI28',
    `^PW${CASE_LABEL_WIDTH}`,
    `^LL${CASE_LABEL_HEIGHT}`,
    '^FO28,44^A0N,22,22^FDCASE^FS',
    `^FO100,36^A0N,44,44${zplField(d.caseId)}`,
    `^FO28,96^A0N,34,34${zplField(d.name.slice(0, 30))}`,
    '^FO28,152^A0N,22,22^FDCASE PACK^FS',
    `^FO28,180^A0N,54,54^FD${d.packQty} EA^FS`,
    '^FO270,152^A0N,22,22^FDRECEIVED^FS',
    `^FO270,184^A0N,36,36^FD${ymd(d.receivedAt)}^FS`,
    `^FO560,28^BQN,2,5^FDMA,${caseDigitalLink(d.gtin, d.caseId)}^FS`,
    upc ? `^FO96,320^BY4^BUN,170,Y,N,Y^FD${upc.slice(0, 11)}^FS` : `^FO28,330^A0N,40,40${zplField(d.gtin)}`,
    '^XZ',
  ].join('\n');
}

/** 后仓库位标签 / 货架货位标签：二维码内容就是编码，扫描确认位置（决策 P-06、X-03） */
export function locationLabelSvg(code: string, caption: string): string {
  const W = 812;
  const H = 203;
  let s = qrSvgPath(code, 12, 12, 180);
  s += `<text x="210" y="112" font-family="${FONT}" font-weight="900" font-size="${code.length > 12 ? 56 : 72}">${esc(code)}</text>`;
  s += `<rect x="210" y="132" width="${W - 232}" height="50" rx="8" fill="#000"/>`;
  s += `<text x="230" y="168" font-family="${FONT}" font-weight="800" font-size="30" fill="#fff" letter-spacing="1">${esc(caption)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(code)}"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="#fff" stroke="#9aa0a6" stroke-width="2"/>${s}</svg>`;
}

export function locationLabelZpl(code: string, caption: string): string {
  return ['^XA', '^CI28', '^PW812', '^LL203', `^FO16,16^BQN,2,5^FDMA,${code}^FS`, `^FO210,40^A0N,64,64${zplField(code)}`, '^FO210,132^GB580,50,50^FS', `^FO230,142^A0N,30,30^FR${zplField(caption)}`, '^XZ'].join('\n');
}
