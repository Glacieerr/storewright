import { hashString } from './rng';

/**
 * 标签上的顾客姓名（决策 L-02）：显示「名 姓」；超过长度上限时显示「名 姓首字母.」；
 * 仍然超长时截断名字。
 */
export function formatCustomerName(firstName: string, lastName: string, maxLength: number): string {
  const first = firstName.trim();
  const last = lastName.trim();
  const full = last ? `${first} ${last}` : first;
  if (full.length <= maxLength) return full;
  const initial = last ? ` ${last[0]?.toUpperCase()}.` : '';
  const short = `${first}${initial}`;
  if (short.length <= maxLength) return short;
  const room = Math.max(1, maxLength - initial.length - 1);
  return `${first.slice(0, room)}…${initial}`;
}

/** 去掉易混淆字符（0/O、1/I/L）后的字母表 */
const SHORT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 由 ID 确定性生成的短码，例如订单短号 "A7K2" */
export function shortCode(id: string, length = 4): string {
  let h = hashString(id);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SHORT_ALPHABET[h % SHORT_ALPHABET.length];
    h = Math.floor(h / SHORT_ALPHABET.length) ^ hashString(`${id}:${i}`);
    h >>>= 0;
  }
  return out;
}

/**
 * 标签二维码中的不透明 ID（决策 L-01）：不含任何个人信息。
 * 格式 `SW1:` + 9 位短码，最后一位为校验字符。
 */
export function opaqueLabelId(entityId: string, version: number): string {
  const body = shortCode(`${entityId}#v${version}`, 8);
  return `SW1:${body}${checkChar(body)}`;
}

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (SHORT_ALPHABET.indexOf(body[i] ?? 'A') + 1) * (i + 1);
  return SHORT_ALPHABET[sum % SHORT_ALPHABET.length] ?? 'A';
}

export function isValidLabelId(labelId: string): boolean {
  const m = /^SW1:([A-Z2-9]{8})([A-Z2-9])$/.exec(labelId);
  if (!m) return false;
  const [, body, check] = m;
  return body !== undefined && checkChar(body) === check;
}
