import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from './en';

const ROOT = join(__dirname, '..');
const HAN = /[一-鿿]/;
/** 语言切换按钮上的本族语名称，不翻译 */
const NATIVE = new Set(['中文']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !p.includes('/i18n/')) out.push(p);
  }
  return out;
}

describe('员工端英文', () => {
  it('源码里每一段中文都有英文译文，JSX 里没有未经 t() 的中文', () => {
    const missing: string[] = [];
    for (const p of files(ROOT)) {
      const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
        const s = m[1] as string;
        if (HAN.test(s) && !NATIVE.has(s) && EN[s] === undefined) missing.push(`${p.split('/').slice(-2).join('/')}: ${s}`);
      }
      for (const m of code.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g)) {
        const s = (m[1] as string).trim();
        if (!NATIVE.has(s)) missing.push(`${p.split('/').slice(-2).join('/')}: JSX ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('译文的占位符与原文一致', () => {
    for (const [zh, en] of Object.entries(EN)) {
      const a = (zh.match(/\{\d\}/g) ?? []).sort().join();
      const b = (en.match(/\{\d\}/g) ?? []).sort().join();
      expect(b, zh).toBe(a);
    }
  });
});

describe('控制台的实时事件', () => {
  it('每一种事件都有中文名称（不显示内部的英文事件名）', () => {
    const events = readFileSync(join(ROOT, '../../../packages/ops/src/events.ts'), 'utf8');
    const types = [...events.matchAll(/^ {2}([A-Z][A-Za-z]+): \{/gm)].map((m) => m[1] as string);
    const consoleCode = readFileSync(join(ROOT, 'screens/ConsoleScreen.tsx'), 'utf8');
    const block = consoleCode.slice(consoleCode.indexOf('const EVENT_TEXT'), consoleCode.indexOf('};', consoleCode.indexOf('const EVENT_TEXT')));
    const named = new Set([...block.matchAll(/^ {2}([A-Z][A-Za-z]+): '/gm)].map((m) => m[1] as string));
    expect(types.length).toBeGreaterThan(80);
    expect(types.filter((x) => !named.has(x))).toEqual([]);
  });
});
