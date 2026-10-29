// 生成 THIRD_PARTY_NOTICES.md：列出运行时用到的开源软件包（应用、浏览器内演示、服务端）和它们的许可证，
// 并附上这些许可证要求随软件分发时保留的许可文本和版权声明。开发工具（TypeScript、Vite、Vitest、Playwright 等）不随软件分发，不列入。
// 改了依赖以后重新运行：npm run notices
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json --long', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));

// 工作区里各应用和包的直接依赖：谁用到了哪个第三方包
const workspaces = ['apps/associate', 'apps/server', 'apps/simulator', 'apps/sim-cli', ...readdirSync(join(root, 'packages')).map((p) => `packages/${p}`)];
const usedBy = new Map();
for (const ws of workspaces) {
  const file = join(root, ws, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@storewright/')) continue;
    usedBy.set(dep, [...(usedBy.get(dep) ?? []), ws]);
  }
}

// 遍历生产依赖树（跳过本仓库自己的包和没有安装的可选依赖）
const pkgs = new Map();
function walk(node) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    if (name.startsWith('@storewright/')) {
      walk(dep);
      continue;
    }
    if (!dep.version || !dep.path || !existsSync(dep.path)) continue;
    const key = `${name}@${dep.version}`;
    if (pkgs.has(key)) continue;
    pkgs.set(key, { name, version: dep.version, dir: dep.path });
    walk(dep);
  }
}
walk(tree);

const licenseFiles = (dir) => readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
function licenseOf(p) {
  const pj = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
  let id = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? pj.licenses?.map((l) => l.type).join(' OR ');
  const files = licenseFiles(p.dir);
  const text = files.filter((f) => !/^notice/i.test(f)).map((f) => readFileSync(join(p.dir, f), 'utf8')).join('\n\n');
  const notice = files.filter((f) => /^notice/i.test(f)).map((f) => readFileSync(join(p.dir, f), 'utf8')).join('\n\n');
  // 没写 license 字段的，按许可文本判断
  if (!id && /Permission is hereby granted, free of charge/.test(text)) id = 'MIT';
  const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url;
  let homepage = (pj.homepage ?? repo ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, '');
  // package.json 里简写的 GitHub 仓库（user/repo）
  if (/^[\w.-]+\/[\w.-]+$/.test(homepage)) homepage = `https://github.com/${homepage}`;
  const copyright = [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.replace(/^[#\s]+/, '').trim())
        .filter((l) => l.length < 200 && /(^|\s)(copyright\b|\(c\)|©)/i.test(l) && !/permission|notice shall|above copyright|copyright notice|copyright holders|copyright owner/i.test(l)),
    ),
  ];
  const author = typeof pj.author === 'string' ? pj.author : pj.author?.name;
  const fallback = author ? [`Copyright (c) ${author}`] : files.length ? [] : [`(no license file in the package; package.json declares ${id ?? 'no license'})`];
  return { ...p, id: id ?? 'UNKNOWN', text, notice, homepage, copyright: copyright.length ? copyright : fallback };
}
const list = [...pkgs.values()].map(licenseOf).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const ISC = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

// 每种许可证：标准文本只附一次的（MIT、ISC、Apache-2.0、BlueOak-1.0.0），其余逐个附原文
const shared = { MIT: () => MIT, ISC: () => ISC };
const fullTextOnce = new Set(['Apache-2.0', 'BlueOak-1.0.0']);
const byId = new Map();
for (const p of list) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
const order = [...byId.keys()].sort((a, b) => byId.get(b).length - byId.get(a).length || a.localeCompare(b));

const fence = (s) => '```text\n' + s.trim() + '\n```';
const out = [];
out.push('# Third-party notices · 第三方组件声明');
out.push('');
out.push('Storewright uses the open-source packages below at run time: in the associate app and simulator (and so in the in-browser demo site), and in the server. Each keeps its own license. This file lists them and reproduces the license texts and copyright notices that those licenses ask to be kept when the software is distributed, for example as the demo site or a Docker image. Development tools that are not distributed (TypeScript, Vite, Vitest, Playwright and the like) are not listed. A package listed here is installed as a run-time dependency; a bundler may leave unused parts out of the built files.');
out.push('');
out.push('Storewright 在运行时用到下面这些开源软件包：员工作业端和模拟器（因此也包括浏览器内演示站点）以及服务端。它们各自保留自己的许可证。本文件列出这些软件包，并附上这些许可证要求在分发软件时保留的许可文本和版权声明（例如分发演示站点或 Docker 镜像时）。不随软件分发的开发工具（TypeScript、Vite、Vitest、Playwright 等）不列入。这里列出的是作为运行时依赖安装的软件包；打包工具可能会把没用到的部分排除在构建产物之外。');
out.push('');
out.push('Generated from the installed packages by `npm run notices` (`scripts/third-party-notices.mjs`); run it again after changing dependencies. · 由 `npm run notices`（`scripts/third-party-notices.mjs`）根据已安装的软件包生成；改了依赖以后请重新生成。');
out.push('');
out.push('## Summary · 汇总');
out.push('');
out.push('| License · 许可证 | Packages · 软件包数 |');
out.push('|---|---|');
for (const id of order) out.push(`| ${id} | ${byId.get(id).length} |`);
out.push(`| **Total · 合计** | **${list.length}** |`);
out.push('');
out.push('All of these are permissive licenses that are compatible with distributing Storewright under AGPL-3.0. · 以上都是宽松许可证，与以 AGPL-3.0 发布 Storewright 兼容。');
out.push('');
out.push('## Direct dependencies · 直接依赖');
out.push('');
out.push('| Package · 软件包 | Version · 版本 | License · 许可证 | Used by · 使用方 |');
out.push('|---|---|---|---|');
for (const [name, users] of [...usedBy.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const p = list.find((x) => x.name === name);
  if (p) out.push(`| ${name} | ${p.version} | ${p.id} | ${users.map((u) => `\`${u}\``).join(', ')} |`);
}
out.push('');
out.push('## Packages and license texts · 软件包与许可文本');
for (const id of order) {
  const group = byId.get(id);
  out.push('');
  out.push(`### ${id} (${group.length})`);
  out.push('');
  if (shared[id] || fullTextOnce.has(id)) {
    out.push('| Package · 软件包 | Copyright · 版权声明 | Source · 来源 |');
    out.push('|---|---|---|');
    for (const p of group) out.push(`| ${p.name}@${p.version} | ${(p.copyright.join('; ') || '—').replace(/\|/g, '\\|')} | ${p.homepage || '—'} |`);
    out.push('');
    if (shared[id]) {
      out.push(`License text shared by the packages above (each with its own copyright notice listed in the table): · 上表各软件包共用的许可文本（各自的版权声明见上表）：`);
      out.push('');
      out.push(fence(shared[id]()));
    } else {
      const sample = group.find((p) => p.text.trim().length > 500) ?? group.find((p) => p.text.trim());
      out.push('License text shared by the packages above: · 上表各软件包共用的许可文本：');
      out.push('');
      out.push(sample ? fence(sample.text) : `See https://spdx.org/licenses/${id}.html`);
    }
    for (const p of group.filter((x) => x.notice.trim())) {
      out.push('');
      out.push(`NOTICE of ${p.name}@${p.version}:`);
      out.push('');
      out.push(fence(p.notice));
    }
  } else {
    for (const p of group) {
      out.push(`#### ${p.name}@${p.version}`);
      out.push('');
      if (p.homepage) out.push(`Source · 来源: ${p.homepage}`);
      out.push('');
      out.push(p.text.trim() ? fence(p.text) : `License: ${id}. ${p.copyright.join('; ')}`);
      if (p.notice.trim()) {
        out.push('');
        out.push(fence(p.notice));
      }
      out.push('');
    }
  }
}
out.push('');
const file = join(root, 'THIRD_PARTY_NOTICES.md');
writeFileSync(file, out.join('\n').replace(/\n{3,}/g, '\n\n'));
const unknown = list.filter((p) => p.id === 'UNKNOWN');
console.log(`${relative(root, file)}: ${list.length} packages (${order.map((id) => `${id} ${byId.get(id).length}`).join(', ')})`);
if (unknown.length) console.log(`license not found: ${unknown.map((p) => `${p.name}@${p.version}`).join(', ')}`);
