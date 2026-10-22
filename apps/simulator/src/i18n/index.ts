
/**
 * 界面语言：中文（默认按浏览器语言）与英文。
 *
 * 中文原文就是键：t('实时数据') 在英文界面下查 EN 字典。带变量的文字用 {0}、{1} 占位：
 * t('已复制 {0} 条通道', n)。仿真引擎和配置校验产生的中文（作业名、校验提示等）在显示时再翻译：
 * 先查原文，再把其中的数字换成 {0}、{1}… 查一次，最后试正则模板（含名称的句子）。查不到时原样显示。
 */

export type Lang = 'zh' | 'en';

const KEY = 'storewright.lang';

function initialLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'zh') return q;
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'zh') return saved;
    return /^zh/i.test(window.navigator.language) ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

let lang: Lang = typeof window === 'undefined' ? 'zh' : initialLang();

// 英文字典按需加载：中文界面不下载
let EN: Record<string, string> = {};
let EN_PATTERNS: Array<[RegExp, string]> = [];
let enLoaded = false;

/** 确保某种语言的字典已加载（英文字典单独打包） */
export async function ensureLang(l: Lang): Promise<void> {
  if (l !== 'en' || enLoaded) return;
  const m = await import('./en');
  EN = m.EN;
  EN_PATTERNS = m.EN_PATTERNS;
  enLoaded = true;
}

export function getLang(): Lang {
  return lang;
}

/** 切换语言（界面重新渲染由状态仓库负责）；Worker 里直接设置 */
export function applyLang(l: Lang, persist = true): void {
  lang = l;
  if (!persist) return;
  try {
    window.localStorage.setItem(KEY, l);
  } catch {
    // 本机存储不可用时只在本次生效
  }
  syncDocument();
}

/** 页面语言属性与标题 */
export function syncDocument(): void {
  try {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = lang === 'zh' ? 'Storewright 模拟器' : 'Storewright Simulator';
  } catch {
    // Worker 等没有页面的环境里跳过
  }
}

function fill(s: string, args: ReadonlyArray<string | number>): string {
  if (!args.length) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}

const NUM = /-?\d+(?:\.\d+)?/g;

/** 英文译文；查不到返回 undefined */
function lookup(s: string): string | undefined {
  const exact = EN[s];
  if (exact !== undefined) return exact;
  // 把数字换成占位符再查（例如「装车 12 箱」→「装车 {0} 箱」）
  const nums: string[] = [];
  const tpl = s.replace(NUM, (m) => `{${nums.push(m) - 1}}`);
  if (nums.length) {
    const hit = EN[tpl];
    if (hit !== undefined) return fill(hit, nums);
  }
  for (const [re, out] of EN_PATTERNS) {
    const m = s.match(re);
    if (m) return out.replace(/\$(\d)/g, (_, i: string) => translate(m[Number(i)] ?? ''));
  }
  return undefined;
}

/** 翻译一段可能来自数据的文字（没有占位参数） */
export function translate(s: string): string {
  if (lang === 'zh' || !s) return s;
  return lookup(s) ?? s;
}

/** 界面文字：原文为中文，{0}、{1} 为参数 */
export function t(s: string, ...args: Array<string | number>): string {
  if (lang === 'zh') return fill(s, args);
  return fill(lookup(s) ?? s, args);
}

/** 标签表（如温区、岗位名称）：读取时按当前语言翻译 */
export function trRecord<K extends string>(rec: Record<K, string>): Record<K, string> {
  return new Proxy(rec, {
    get(target, key) {
      const v = (target as Record<string | symbol, unknown>)[key];
      return typeof v === 'string' ? translate(v) : v;
    },
  });
}

/** 数字按语言格式化：英文用千分位 */
export function fmtNum(v: number, digits = 0): string {
  return lang === 'en' ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : v.toFixed(digits);
}
