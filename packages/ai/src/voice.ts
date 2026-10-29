/**
 * 语音命令（决策记录 0024 · 第四批 G2）：拣货时不用腾手——「下一个」「找不到」「数量 3」「记一下：冷冻 3 号门把手松了」。
 * 语音转文字可插拔：本地的小型语音识别模型（约 40–150 MB）需要下载；浏览器自带的语音识别会把声音传到云端，不用。
 * 没有识别器时可以打字代替（演示）。命令词用规则（中文、英文、西班牙语），其他的话当作问题交给门店助手。
 */

export type VoiceCommand = { kind: 'NEXT' } | { kind: 'NOT_FOUND' } | { kind: 'QTY'; qty: number } | { kind: 'NOTE'; text: string } | { kind: 'ASK'; text: string } | { kind: 'UNKNOWN'; text: string };

const ZH_DIGIT: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12 };

/** 「十二」「二十」「三」这样的中文数字（到 99） */
export function zhNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return undefined;
  const i = s.search(/十/);
  if (i < 0) return s.length === 1 ? ZH_DIGIT[s] : undefined;
  const tens = i === 0 ? 1 : (ZH_DIGIT[s.slice(0, i)] ?? NaN);
  const ones = i === s.length - 1 ? 0 : (ZH_DIGIT[s.slice(i + 1)] ?? NaN);
  const n = tens * 10 + ones;
  return Number.isFinite(n) ? n : undefined;
}

export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.trim();
  const lower = text.toLowerCase().replace(/[。.!！]+$/, '');
  // 记一下：……
  const note = /^(?:记一下|记下|备注|记录一下|note|take a note|nota|anota)\s*[:：,，]?\s*(.+)$/i.exec(text);
  if (note) return { kind: 'NOTE', text: (note[1] as string).trim() };
  // 数量
  const zhQty = /(?:数量|拣了|拿了|放了|共)\s*([零一二两三四五六七八九十\d]+)\s*(?:个|件|瓶|包|盒)?/.exec(text) ?? /^([零一二两三四五六七八九十\d]+)\s*(?:个|件|瓶|包|盒)$/.exec(text);
  if (zhQty) {
    const n = zhNumber(zhQty[1] as string);
    if (n !== undefined && n > 0) return { kind: 'QTY', qty: n };
  }
  const enQty = /(?:quantity|qty|picked|cantidad|cogí|tomé)\s*(\d+|[a-z]+)/i.exec(lower) ?? /^(\d+|[a-z]+)\s*(?:of them|units|pieces|piezas|unidades)$/i.exec(lower);
  if (enQty) {
    const v = enQty[1] as string;
    const n = /^\d+$/.test(v) ? Number(v) : WORD_NUM[v];
    if (n && n > 0) return { kind: 'QTY', qty: n };
  }
  // 找不到
  if (/(找不到|没找到|没有货|缺货|货架上没有|not found|can'?t find|cannot find|missing|out of stock|no (lo|la) encuentro|no está|no hay|agotado)/i.test(lower)) return { kind: 'NOT_FOUND' };
  // 下一个
  if (/^(下一个|下一件|拣到了|拿到了|好了|完成|next|next one|done|got it|picked|siguiente|listo|ya está)$/i.test(lower)) return { kind: 'NEXT' };
  // 问题交给门店助手
  if (/[?？]$|吗$|(什么|哪里|在哪|多少|怎么|为什么|几点|how|what|where|why|when|which|dónde|cuánto|qué|cómo|por qué)/i.test(lower)) return { kind: 'ASK', text };
  return { kind: 'UNKNOWN', text };
}
