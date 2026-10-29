import { isValidLabelId, parseDigitalLink, type TempZone } from '@storewright/domain';
import { locationIndex } from './apply';
import type { OpsState, StoreStatic } from './types';

/**
 * 扫描结果解析：同一个扫码框可以扫标签、暂存格位、商品条码或订单短号，按内容判断类型。
 * - 标签：`SW1:` + 9 位（含校验位），只含不透明 ID（决策 L-01）
 * - 暂存格位：门店配置中的格位编码（例如 AMB-03-02-16）
 * - 商品：8–14 位数字（UPC / EAN / GTIN）
 * - 订单短号：4 位短码
 * - 后仓箱子：箱标签上的 GS1 Digital Link，或手输内部箱号 C-YYMMDD-NNNNNN
 * - 后仓库位、货架货位：库位编码、货位编码
 * - 回收专区：每个温区一个标签 RECOVERY-AMB / CHL / FRZ / HOT（决策记录 0026：移到回收专区时扫一下）
 */

/** 回收专区的标签编码（每个温区一个，和暂存格位标签一起打印） */
export const RECOVERY_CODES: Readonly<Record<TempZone, string>> = { AMBIENT: 'RECOVERY-AMB', CHILLED: 'RECOVERY-CHL', FROZEN: 'RECOVERY-FRZ', HOT: 'RECOVERY-HOT' };
export type ScanResult =
  | { kind: 'label'; labelId: string; toteId: string; orderId: string; voided: boolean }
  | { kind: 'unknown-label'; labelId: string }
  | { kind: 'slot'; code: string }
  | { kind: 'item'; gtin: string }
  | { kind: 'order'; orderId: string }
  | { kind: 'case'; caseId: string; itemId: string }
  | { kind: 'unknown-case'; caseId: string }
  | { kind: 'bin'; code: string }
  | { kind: 'location'; locationId: string; itemIds: string[] }
  | { kind: 'recovery'; code: string; tempZone: TempZone }
  | { kind: 'unknown'; raw: string };

export function resolveScan(s: OpsState, st: StoreStatic, raw: string): ScanResult {
  const code = raw.trim().toUpperCase();
  if (code.startsWith('SW1:')) {
    const l = s.labels[code];
    const t = l ? s.totes[l.toteId] : undefined;
    if (!l || !t || !isValidLabelId(code)) return { kind: 'unknown-label', labelId: code };
    return { kind: 'label', labelId: code, toteId: t.id, orderId: t.orderId, voided: l.voided };
  }
  const link = code.includes('/01/') ? parseDigitalLink(raw) : undefined;
  const caseId = link?.caseId ?? (/^C-\d{6}-\d{6}$/.test(code) ? code : undefined);
  if (caseId) {
    const c = s.cases[caseId];
    return c ? { kind: 'case', caseId, itemId: c.itemId } : { kind: 'unknown-case', caseId };
  }
  const rz = (Object.keys(RECOVERY_CODES) as TempZone[]).find((z) => RECOVERY_CODES[z] === code);
  if (rz) return { kind: 'recovery', code, tempZone: rz };
  if (st.slots.some((x) => x.code === code)) return { kind: 'slot', code };
  if (st.bins.some((b) => b.code === code)) return { kind: 'bin', code };
  const loc = locationIndex(st).get(code);
  if (loc?.length) return { kind: 'location', locationId: code, itemIds: loc.map((p) => p.itemId) };
  if (/^\d{8,14}$/.test(code)) return { kind: 'item', gtin: code };
  if (/^[A-Z2-9]{4}$/.test(code)) {
    const o = Object.values(s.orders).find((x) => x.shortCode === code && x.status !== 'COMPLETED' && x.status !== 'CANCELLED');
    if (o) return { kind: 'order', orderId: o.id };
  }
  return { kind: 'unknown', raw: raw.trim() };
}
