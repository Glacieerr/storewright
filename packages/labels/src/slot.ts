import type { TempZone } from '@storewright/domain';
import { qrSvgPath } from './qr';
import { esc, zplField } from './tote';

/**
 * 暂存格位标签：贴在暂存架的格位上，二维码内容就是格位编码，暂存时扫描确认（决策 S-02、S-04）。
 * 4" × 1"，单色。
 */
export const SLOT_LABEL_WIDTH = 812;
export const SLOT_LABEL_HEIGHT = 203;

export function slotLabelSvg(code: string, tempZone: TempZone): string {
  const W = SLOT_LABEL_WIDTH;
  const H = SLOT_LABEL_HEIGHT;
  const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
  let s = qrSvgPath(code, 12, 12, 180);
  s += `<text x="210" y="112" font-family="${FONT}" font-weight="900" font-size="72">${esc(code)}</text>`;
  s += `<rect x="210" y="132" width="${W - 232}" height="50" rx="8" fill="#000"/>`;
  s += `<text x="230" y="168" font-family="${FONT}" font-weight="800" font-size="32" fill="#fff" letter-spacing="2">STAGING · ${tempZone}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Staging slot ${esc(code)}"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="#fff" stroke="#9aa0a6" stroke-width="2"/>${s}</svg>`;
}

export function slotLabelZpl(code: string, tempZone: TempZone): string {
  return [
    '^XA',
    '^CI28',
    `^PW${SLOT_LABEL_WIDTH}`,
    `^LL${SLOT_LABEL_HEIGHT}`,
    `^FO16,16^BQN,2,5^FDMA,${code}^FS`,
    `^FO210,40^A0N,72,72${zplField(code)}`,
    `^FO210,132^GB580,50,50^FS`,
    `^FO230,142^A0N,32,32^FR^FDSTAGING ${tempZone}^FS`,
    '^XZ',
  ].join('\n');
}
