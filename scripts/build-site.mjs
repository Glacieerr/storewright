// 组装浏览器内演示站点（纯静态文件，可以放到任意静态托管和任意子路径）：
//   site/app/  员工端演示构建（门店中枢在浏览器里运行）+ 展示页 showcase.html
//   site/sim/  运营模拟器
//   site/index.html  跳到展示页
// 先运行 npm run build:sim 和 npm run build:demo（npm run build:site 会一起做）。
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'site');
const parts = [
  ['apps/associate/dist-demo', 'app'],
  ['apps/simulator/dist', 'sim'],
];
for (const [from] of parts) if (!existsSync(join(root, from))) throw new Error(`missing ${from}: run npm run build:sim && npm run build:demo first`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of parts) cpSync(join(root, from), join(out, to), { recursive: true });
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Storewright · Live demo</title>
<meta name="description" content="Storewright: an integrated, AI-assisted store-operations system for mid-size grocers. The whole system runs in your browser." />
<meta http-equiv="refresh" content="0; url=./app/showcase.html" />
</head>
<body>
<p><a href="./app/showcase.html">Open the live demo</a> · <a href="./sim/">Store simulator</a> · <a href="./app/">Associate app</a></p>
</body>
</html>
`,
);
// GitHub Pages：不经过 Jekyll 处理
writeFileSync(join(out, '.nojekyll'), '');
console.log(`site ready: ${out}`);
