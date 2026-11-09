import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 文档里的数字从结果数据生成。文档里这样标出来的数字：
 *
 *   <!--n:gens.g3.mean.costPerCase|2-->2.02<!--/n-->
 *
 * 按 docs/results/data.json 检查或更新：
 *   npx tsx src/cli/docnums.ts            # 检查：数字和数据对不上的列出来（退出码 1）
 *   npx tsx src/cli/docnums.ts --write    # 按数据更新文档
 *
 * 写法：「路径|小数位|单位」。路径是 data.json 里的字段，用点分开，数组按元素的 key 或 gen 选；
 * 单位可以是 k（千）、w（万）、m（百万）；「pct:路径甲:路径乙」是乙比甲变了百分之几。
 * 负数用 −（和文档其余地方一样），千位加逗号。重新跑报告（npm run reports）以后跑一次 --write，数字就和数据一致；
 * 测试（tests/docs.test.ts）检查文档里标出来的数字都和数据一致。
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DOC_FILES = ['README.md', 'README.en.md', 'docs/01-planning-report.md', 'docs/02-generation-comparison.md', 'docs/03-business-analysis.md', 'docs/04-system-design.md'];
const MARK = /<!--n:([^>]*?)-->(.*?)<!--\/n-->/g;

type Json = unknown;
function at(data: Json, path: string): number | undefined {
  let cur: Json = data;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = /^\d+$/.test(seg) ? Number(seg) : -1;
      cur = i >= 0 ? cur[i] : cur.find((x) => x && typeof x === 'object' && ((x as Record<string, unknown>).key === seg || (x as Record<string, unknown>).gen === seg));
    } else if (typeof cur === 'object') cur = (cur as Record<string, Json>)[seg];
    else return undefined;
  }
  return typeof cur === 'number' ? cur : undefined;
}

const SCALE: Record<string, number> = { k: 1e3, w: 1e4, m: 1e6 };
export function format(v: number, digits: number): string {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 && Number(s.replace(/,/g, '')) !== 0 ? `−${s}` : s;
}

/** 一个标记应该写成什么（数据里没有这个字段时返回 undefined） */
export function valueOf(data: Json, expr: string): string | undefined {
  const [path = '', d = '0', unit = ''] = expr.split('|');
  let v: number | undefined;
  if (path.startsWith('pct:')) {
    const [, a, b] = path.split(':');
    const x = at(data, a ?? '');
    const y = at(data, b ?? '');
    v = x !== undefined && y !== undefined && x !== 0 ? ((y - x) / Math.abs(x)) * 100 : undefined;
  } else v = at(data, path);
  if (v === undefined) return undefined;
  return format(v / (SCALE[unit] ?? 1), Number(d));
}

export interface Mismatch {
  file: string;
  expr: string;
  have: string;
  want: string | undefined;
}

/** 检查（write = false）或更新（write = true）文档里标出来的数字 */
export function syncDocs(write: boolean, files = DOC_FILES): { marks: number; mismatches: Mismatch[] } {
  const data = JSON.parse(readFileSync(`${ROOT}docs/results/data.json`, 'utf8')) as Json;
  let marks = 0;
  const mismatches: Mismatch[] = [];
  for (const file of files) {
    const text = readFileSync(`${ROOT}${file}`, 'utf8');
    const out = text.replace(MARK, (all, expr: string, have: string) => {
      marks++;
      const want = valueOf(data, expr);
      if (want === undefined || want !== have) mismatches.push({ file, expr, have, want });
      return want === undefined ? all : `<!--n:${expr}-->${want}<!--/n-->`;
    });
    if (write && out !== text) writeFileSync(`${ROOT}${file}`, out);
  }
  return { marks, mismatches };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes('--write');
  const { marks, mismatches } = syncDocs(write);
  for (const m of mismatches) process.stdout.write(`${m.file}：${m.expr} 写的是 ${m.have}，数据是 ${m.want ?? '（没有这个字段）'}\n`);
  process.stdout.write(`${marks} 个标出来的数字，${mismatches.length} 个和数据不一致${write ? '，已经按数据更新' : ''}\n`);
  if (!write && mismatches.length) process.exitCode = 1;
}
