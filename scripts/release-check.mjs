// 发布前的本地检查（npm run release:check）：版本号和 CHANGELOG 对得上，再把 CI 里的检查在本机按顺序跑一遍，最后列一张表。
// 只读：不改文件（构建产物除外），不提交、不打标签、不推送。用法：
//   npm run release:check                 全部（第二部分、第三部分、两个程序库）
//   npm run release:check -- --only chain 只查第三部分（chain | storex | libs）
// Pre-release check: versions vs CHANGELOG headings, then the CI checks in order, with a summary table.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
const want = (k) => !only || only === k;
const rows = [];

/** 版本号：package.json 的 version 要等于 CHANGELOG 里第一个带版本号的标题 */
function versionRow(name, dir) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const log = existsSync(join(root, dir, 'CHANGELOG.md')) ? readFileSync(join(root, dir, 'CHANGELOG.md'), 'utf8') : '';
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(log);
  const ok = !!m && m[1] === pkg.version;
  const dated = !!m && new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}`, 'm').test(log);
  rows.push({ step: `${name}: version ${pkg.version} = CHANGELOG ${m?.[1] ?? '—'}`, ok, note: ok ? (dated ? 'dated' : 'heading not dated yet (fill in the date before tagging)') : 'mismatch', ms: 0 });
}

function run(step, cmd, args) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' });
  const ok = r.status === 0;
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? '';
  rows.push({ step, ok, note: ok ? '' : tail.slice(0, 160), ms: Date.now() - t0 });
  process.stdout.write(`${ok ? '✓' : '✗'} ${step} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (want('chain')) {
  versionRow('StoreX Chain', 'StoreX-Chain');
  run('StoreX Chain: typecheck', npm, ['run', 'typecheck', '-w', 'storex-chain']);
  run('StoreX Chain: unit tests', npm, ['test', '-w', 'storex-chain']);
  run('StoreX Chain: ESLint (no errors)', npm, ['run', 'lint', '-w', 'storex-chain']);
  run('StoreX Chain: docs numbers', npm, ['run', 'docs:check', '-w', 'storex-chain']);
  run('StoreX Chain: validation (quick)', npm, ['run', 'validate', '-w', 'storex-chain', '--', '--quick']);
  run('StoreX Chain: production build', npm, ['run', 'build', '-w', 'storex-chain']);
}
if (want('storex')) {
  versionRow('StoreX', 'StoreX');
  run('StoreX: typecheck + tests', npm, ['run', 'check', '-w', 'storex']);
  run('StoreX: ESLint (no errors)', npm, ['run', 'lint', '-w', 'storex']);
  run('StoreX: production build', npm, ['run', 'build', '-w', 'storex']);
}
if (want('libs')) {
  for (const [name, dir, ws] of [
    ['@storewright/yard', 'packages/yard', '@storewright/yard'],
    ['@storewright/overlap-audit', 'packages/overlap-audit', '@storewright/overlap-audit'],
  ]) {
    if (!existsSync(join(root, dir, 'package.json'))) continue;
    versionRow(name, dir);
    run(`${name}: tests`, npm, ['test', '-w', ws]);
  }
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.['pack:libs']) run('libraries: npm pack', npm, ['run', 'pack:libs']);
}

const w = Math.max(...rows.map((r) => r.step.length));
process.stdout.write(`\n${'step'.padEnd(w)}  result  note\n`);
for (const r of rows) process.stdout.write(`${r.step.padEnd(w)}  ${r.ok ? 'pass  ' : 'FAIL  '}  ${r.note}\n`);
const bad = rows.filter((r) => !r.ok).length;
process.stdout.write(bad ? `\n${bad} check(s) failed — do not tag yet.\n` : '\nAll checks passed. Next: commit, push, wait for CI, then tag (RELEASING.md).\n');
process.exit(bad ? 1 : 0);
