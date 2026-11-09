import { Assistant } from '../assistant/index';
import { ABSTAIN, classifyBy, LR_OPTS, TEMP } from '../assistant/intent';
import { nearestRank } from './nearest';

/**
 * 基准里的对照系统（都在本机跑、确定、不联网）。除了意图分类器和「没把握先问」，别的部分（规范化、认参数、规则、工具、规则表、
 * 回答的拼法）都一样，所以几个系统之间的差别就是分类器和弃答带来的差别。可选的大模型模式（llm）和外部系统的预测（external）另算。
 * Offline baseline systems: the same pipeline with the intent ranker / abstention swapped.
 */
export type OfflineSystem = 'builtin' | 'lr' | 'nb' | 'nearest' | 'keyword';
export type SystemKey = OfflineSystem | 'llm' | 'external';
export const OFFLINE_SYSTEMS: readonly OfflineSystem[] = ['builtin', 'lr', 'nb', 'nearest', 'keyword'];

export interface SystemDef {
  key: OfflineSystem;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  config: Record<string, unknown>;
  make(): Assistant;
}

export const SYSTEMS: readonly SystemDef[] = [
  {
    key: 'builtin',
    label: '内置（规则 + 逻辑回归 + 没把握先问）',
    labelEn: 'Built-in (rules + logistic regression + ask when unsure)',
    description: '值班助手本来的样子：手写规则先判，判不了交给逻辑回归（温度校准），把握不够时先问一句、给两种理解。',
    descriptionEn:
      'The assistant as shipped: hand-written rules first, then a calibrated logistic-regression classifier; when unsure it asks back with the two likeliest readings.',
    config: { classifier: 'logistic regression', temperature: TEMP.lr, abstain: ABSTAIN, training: LR_OPTS },
    make: () => new Assistant(),
  },
  {
    key: 'lr',
    label: '规则 + 逻辑回归（不先问）',
    labelEn: 'Rules + logistic regression (no abstention)',
    description: '和内置一样，只是关掉「没把握先问」：看弃答本身带来多少。',
    descriptionEn: 'Same as built-in with abstention turned off, to isolate what asking back contributes.',
    config: { classifier: 'logistic regression', temperature: TEMP.lr, abstain: false },
    make: () => new Assistant({ abstain: false }),
  },
  {
    key: 'nb',
    label: '规则 + 朴素贝叶斯 + 没把握先问',
    labelEn: 'Rules + naive Bayes + ask when unsure',
    description: '分类器换成朴素贝叶斯（同一份训练语料、温度校准），弃答门槛不变。',
    descriptionEn: 'The classifier swapped for naive Bayes (same training data, temperature-calibrated); same abstention thresholds.',
    config: { classifier: 'naive Bayes', temperature: TEMP.nb, abstain: ABSTAIN },
    make: () => new Assistant({ ranker: (m) => classifyBy('nb', m) }),
  },
  {
    key: 'nearest',
    label: '规则 + TF-IDF 最近邻',
    labelEn: 'Rules + TF-IDF nearest neighbour',
    description: '分类器换成训练语料上的 TF-IDF 最近邻（余弦相似度），不先问。',
    descriptionEn: 'The classifier swapped for TF-IDF nearest neighbour (cosine) over the training rows; no abstention.',
    config: { classifier: 'TF-IDF 1-nearest-neighbour (cosine)', features: 'same as logistic regression', abstain: false },
    make: () => new Assistant({ ranker: (m) => nearestRank(m), abstain: false }),
  },
  {
    key: 'keyword',
    label: '只有关键词规则',
    labelEn: 'Keyword rules only',
    description: '不用任何分类器：只有手写规则和认参数决定意图；规则判不了时当作完全没把握（交给共用的兜底：查资料库，或说明能做什么）。',
    descriptionEn:
      'No classifier at all: only the hand-written rules and entity routing decide; when no rule fires the model is treated as clueless (the shared fallback searches the knowledge base or explains what it can do).',
    config: { classifier: 'none', abstain: false },
    make: () => new Assistant({ ranker: () => [{ intent: 'help', p: 0 }], abstain: false }),
  },
];

export const systemDef = (k: OfflineSystem): SystemDef => SYSTEMS.find((s) => s.key === k) as SystemDef;
