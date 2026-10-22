import type { StoreNote } from '@storewright/ops';
import { SOP } from './sop';

/**
 * 知识检索：操作规范 + 门店经验库。
 * 本地、无依赖的关键词检索：英文按单词，中文按单字和相邻两个字（二元组）切分，按 TF-IDF 打分。
 * 门店规模的知识量很小（几十到几百条），这样足够，也不需要向量模型。
 */

export interface KnowledgeHit {
  kind: 'SOP' | 'NOTE';
  id: string;
  title: string;
  text: string;
  score: number;
}

const HAN = /[一-鿿]/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2) out.push(w);
  // 中文：连续汉字的二元组 + 单字
  let run = '';
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    // 单字也计入（「酒」「满」这类关键字常常单独出现），常见字的权重会被 IDF 压低
    for (const c of run) out.push(c);
    run = '';
  };
  for (const c of lower) {
    if (HAN.test(c)) run += c;
    else flush();
  }
  flush();
  return out;
}

interface Doc {
  kind: 'SOP' | 'NOTE';
  id: string;
  title: string;
  text: string;
  tokens: string[];
}

export function searchKnowledge(query: string, notes: readonly StoreNote[], lang: 'zh' | 'en', limit = 3, itemName?: (id: string) => string | undefined): KnowledgeHit[] {
  const docs: Doc[] = [
    ...SOP.map((e) => {
      const loc = e[lang];
      // 两种语言的文字和标签都参与检索：中文问题也能找到，反之亦然
      return { kind: 'SOP' as const, id: e.id, title: loc.title, text: loc.text, tokens: tokenize(`${e.zh.title} ${e.zh.text} ${e.en.title} ${e.en.text} ${e.tags.join(' ')} ${e.tags.join(' ')}`) };
    }),
    ...notes.map((n) => {
      const extra = n.itemId ? (itemName?.(n.itemId) ?? n.itemId) : '';
      return { kind: 'NOTE' as const, id: n.id, title: n.tags.join(' · ') || (lang === 'zh' ? '门店经验' : 'Store note'), text: n.text, tokens: tokenize(`${n.text} ${n.tags.join(' ')} ${extra} ${n.locationId ?? ''}`) };
    }),
  ];
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const n = docs.length;
  const hits = docs
    .map((d) => {
      const tf = new Map<string, number>();
      for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        score += (1 + Math.log(f)) * Math.log(1 + n / (df.get(t) ?? 1));
      }
      return { kind: d.kind, id: d.id, title: d.title, text: d.text, score: Math.round(score * 100) / 100 };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}
