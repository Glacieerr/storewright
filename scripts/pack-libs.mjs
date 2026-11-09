// 把两个独立的程序库打成可以发布 / 安装的包（npm 的 .tgz）：
//   npm run pack:libs                 # 两个都打
//   node scripts/pack-libs.mjs yard   # 只打一个（yard / overlap-audit）
// 每个库：tsc 把 src/ 编译到 dist-pkg/<库>/dist（ES2022 模块 + 类型声明，相对引用补上 .js 后缀，Node 直接能跑），
// 写一份发布用的 package.json（exports / types / bin 指向编译后的文件），复制 README、CHANGELOG 和根目录的 LICENSE
// （README 里指向仓库别处的相对链接换成 GitHub 地址），再 npm pack 出 dist-pkg/<文件名>.tgz。dist-pkg/ 不提交。
//
// Packs the standalone libraries into installable npm tarballs (compiled JavaScript + type declarations). Nothing is published;
// install a tarball with `npm install ./dist-pkg/storewright-yard-0.1.0.tgz`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'dist-pkg');
const REPO = 'https://github.com/Glacieerr/storewright';
const LIBS = {
  yard: { dir: 'packages/yard', extra: [] },
  'overlap-audit': { dir: 'packages/overlap-audit', extra: ['examples/crossing.json', 'examples/limits.json'], bin: { 'overlap-audit': './dist/cli.js' } },
};
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const k of only) if (!LIBS[k]) throw new Error(`unknown library ${k}; known: ${Object.keys(LIBS).join(', ')}`);

/** 编译后的 JS / 类型声明里，相对引用补 .js（Node 的 ESM 不认没有后缀的相对路径） */
function addJsExtensions(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      addJsExtensions(p);
      continue;
    }
    if (!/\.(js|d\.ts)$/.test(f)) continue;
    const s = readFileSync(p, 'utf8').replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+?)\2/g, (m, pre, q, spec) => (/\.(js|json)$/.test(spec) ? m : `${pre}${q}${spec}.js${q}`));
    writeFileSync(p, s);
  }
}

/** README 里的相对链接：包里有的文件保持相对，其余换成 GitHub 上的地址 */
function rewriteLinks(md, pkgDir, shipped) {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return m;
    const [path, hash = ''] = href.split('#');
    const inPkg = posix.normalize(path.replace(/\/$/, ''));
    if (shipped.has(inPkg)) return m;
    const repoPath = posix.normalize(posix.join(pkgDir, path));
    const abs = join(root, repoPath);
    const kind = existsSync(abs) && statSync(abs).isDirectory() ? 'tree' : 'blob';
    return `](${REPO}/${kind}/main/${repoPath.replace(/\/$/, '')}${hash ? `#${hash}` : ''})`;
  });
}

mkdirSync(out, { recursive: true });
const made = [];
for (const [name, lib] of Object.entries(LIBS)) {
  if (only.length && !only.includes(name)) continue;
  const src = join(root, lib.dir);
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const stage = join(out, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // 1. 编译
  const tsconfig = join(stage, 'tsconfig.build.json');
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        extends: join(root, 'tsconfig.base.json'),
        compilerOptions: { noEmit: false, declaration: true, outDir: join(stage, 'dist'), rootDir: join(src, 'src'), sourceMap: false, declarationMap: false, lib: ['ES2022'] },
        include: [join(src, 'src/**/*.ts')],
      },
      null,
      2,
    ),
  );
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', tsconfig], { stdio: 'inherit' });
  rmSync(tsconfig);
  addJsExtensions(join(stage, 'dist'));
  // 2. 文档、许可证、样例
  const shipped = new Set(['README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', ...lib.extra]);
  for (const f of ['README.md', 'README.en.md']) writeFileSync(join(stage, f), rewriteLinks(readFileSync(join(src, f), 'utf8').replaceAll('../../LICENSE', 'LICENSE'), lib.dir, shipped));
  cpSync(join(src, 'CHANGELOG.md'), join(stage, 'CHANGELOG.md'));
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  for (const f of lib.extra) {
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    cpSync(join(src, f), join(stage, f));
  }
  // 3. 发布用的 package.json
  const publish = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: 'module',
    sideEffects: false,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    ...(lib.bin ? { bin: lib.bin } : {}),
    files: ['dist', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', ...lib.extra],
    keywords: pkg.keywords,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    engines: pkg.engines,
  };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(publish, null, 2)}\n`);
  // 4. 打包
  const file = execFileSync('npm', ['pack', '--pack-destination', out, '--json', '--workspaces=false'], { cwd: stage, encoding: 'utf8' });
  const info = JSON.parse(file)[0];
  made.push(`${relative(root, join(out, info.filename))} (${info.entryCount} files, ${(info.size / 1024).toFixed(1)} kB)`);
}
console.log(`packed:\n  ${made.join('\n  ')}`);
