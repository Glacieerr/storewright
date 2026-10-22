/**
 * 后仓库存的标识：内部箱号与 GS1 Digital Link（决策 I-02）。
 *
 * - 内部箱号由本地数据库主导：`C-YYMMDD-NNNNNN`（收货日期 + 当天序号）；
 * - 箱标签的二维码是 GS1 Digital Link：`{base}/01/{GTIN-14}/21/{序列号}`，序列号是去掉连字符的箱号；
 * - 扫描到 Digital Link 时可以反解出 GTIN 和箱号。
 */

export const DIGITAL_LINK_BASE = 'https://id.storewright.example';

/** 补齐为 14 位 GTIN（UPC-A 12 位、EAN-13 13 位前面补 0） */
export function gtin14(gtin: string): string {
  const digits = gtin.replace(/\D/g, '');
  return digits.padStart(14, '0').slice(-14);
}

/** 内部箱号：收货日期（UTC）+ 当天序号 */
export function caseId(receivedAt: number, seq: number): string {
  const d = new Date(receivedAt);
  const ymd = `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `C-${ymd}-${String(seq).padStart(6, '0')}`;
}

export function caseDigitalLink(gtin: string, id: string, base = DIGITAL_LINK_BASE): string {
  return `${base.replace(/\/$/, '')}/01/${gtin14(gtin)}/21/${id.replace(/-/g, '')}`;
}

/** 解析 GS1 Digital Link；序列号符合内部箱号格式时同时给出箱号 */
export function parseDigitalLink(s: string): { gtin14: string; serial: string; caseId?: string } | undefined {
  const m = /\/01\/(\d{14})\/21\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(s.trim());
  if (!m) return undefined;
  const serial = (m[2] as string).toUpperCase();
  const out: { gtin14: string; serial: string; caseId?: string } = { gtin14: m[1] as string, serial };
  const c = /^C(\d{6})(\d{6})$/.exec(serial);
  if (c) out.caseId = `C-${c[1]}-${c[2]}`;
  return out;
}

/** UPC-A 校验位是否正确（12 位） */
export function isValidUpcA(code: string): boolean {
  if (!/^\d{12}$/.test(code)) return false;
  const d = code.split('').map(Number);
  let odd = 0;
  let even = 0;
  for (let i = 0; i < 11; i++) {
    if (i % 2 === 0) odd += d[i] as number;
    else even += d[i] as number;
  }
  return (10 - ((odd * 3 + even) % 10)) % 10 === d[11];
}
