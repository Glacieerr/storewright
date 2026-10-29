import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyLang, ensureLang, t, translate, trRecord } from './index';

const ROOT = join(__dirname, '..');
const ENGINE = join(__dirname, '../../../../packages');
const HAN = /[一-鿿]/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !p.includes('/i18n/')) out.push(p);
  }
  return out;
}

/** 源码里出现的中文字符串（去掉注释；模板字符串的 ${…} 换成 {0}、{1}…） */
function chineseLiterals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) if (HAN.test(m[1] as string)) out.push((m[1] as string).replace(/\\'/g, "'"));
  for (const m of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    const v = m[1] as string;
    if (!HAN.test(v) || v.includes('${esc(') || v.includes('<')) continue;
    let i = 0;
    out.push(v.replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, () => `{${i++}}`));
  }
  return out;
}

/** 只在代码里比较、从不显示的中文（作业名比较、错误信息等） */
const CODE_ONLY = new Set([
  '车辆几何体合并失败',
  '仿真没有返回轨迹',
  'Language / 语言',
  // 合成的中文召回通知：只用来评测召回通知的解析（中英文都要能读），从不显示
  '可能受沙门氏菌污染',
  '含有未标注的花生过敏原',
  '可能混入金属异物',
  '可能受李斯特菌污染',
  '，条码 {0}',
  '召回通知：召回「{0}」{1}，批次 {2} 开头，保质期 {3} 至 {4}。原因：{5}。',
]);

describe('界面英文', () => {
  beforeAll(() => ensureLang('en'));
  afterEach(() => applyLang('zh', false));

  it('中文界面原样显示，{0} 占位按参数替换', () => {
    applyLang('zh', false);
    expect(t('已选中 {0} 条通道', 3)).toBe('已选中 3 条通道');
    expect(translate('叉车卸货')).toBe('叉车卸货');
  });

  it('英文界面：精确匹配、数字模板、正则模板与标签表', () => {
    applyLang('en', false);
    expect(t('实时数据')).toBe('Live data');
    expect(t('已选中 {0} 条通道', 3)).toBe('3 aisles selected');
    expect(translate('装车 12 箱')).toBe('Loading 12 cases');
    expect(translate('货架重叠：Aisle 1 与 Aisle 2 的中线只相距 2.8 米（至少需要 3.0 米）')).toBe('Shelves overlap: Aisle 1 and Aisle 2 are only 2.8 m apart (at least 3.0 m needed)');
    expect(translate('门店左侧已经有一个附属设施')).toBe('The left side of the store already has a facility');
    const zones = trRecord({ AMBIENT: '常温' });
    expect(zones.AMBIENT).toBe('Ambient');
    expect(Object.keys(zones)).toEqual(['AMBIENT']);
    expect(translate('未收录的文字')).toBe('未收录的文字');
  });

  it('模拟器和引擎里出现的每一段中文都有英文译文', () => {
    applyLang('en', false);
    const sources = [...files(ROOT), ...files(ENGINE).filter((p) => p.includes('/src/'))];
    const missing = new Set<string>();
    for (const p of sources) {
      for (const s of chineseLiterals(readFileSync(p, 'utf8'))) {
        if (CODE_ONLY.has(s)) continue;
        const out = translate(s);
        if (HAN.test(out)) missing.add(`${p.split('/').slice(-2).join('/')}: ${s}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
