// 组装浏览器内演示站点（纯静态文件，可以放到任意静态托管和任意子路径）：
//   site/app/  员工端演示构建（门店中枢在浏览器里运行）+ 展示页 showcase.html
//   site/sim/  运营模拟器
//   site/storex/  第二部分 StoreX 的门店模拟器（StoreX/dist）
//   site/storex-chain/  第三部分 StoreX 全链路的区域三维孪生（StoreX-Chain/dist）
//   site/benchmark/  值班台基准（Duty-Desk Bench）的结果页（StoreX-Chain/bench/duty-desk/site）
//   site/yard/  独立程序库 @storewright/yard 的浏览器演示（packages/yard/dist-demo）
//   site/index.html  首页：三个部分、集装箱导览、开发者入口（scripts/site-landing.mjs）
// 先运行 npm run build:sim、npm run build:demo、npm run build -w storex 和 npm run build -w storex-chain（npm run build:site 会一起做）。
// 所有构建都用相对的 base（vite.config.ts 里的 base: './'），数据打包进脚本、Web Worker 按 import.meta.url 加载，所以放在哪个子路径下都能用。
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingHtml } from './site-landing.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'site');
const parts = [
  ['apps/associate/dist-demo', 'app'],
  ['apps/simulator/dist', 'sim'],
  ['StoreX/dist', 'storex'],
  ['StoreX-Chain/dist', 'storex-chain'],
  // 值班台基准的结果页（npm run bench -- report 生成、随仓库提交，不用另外构建）
  ['StoreX-Chain/bench/duty-desk/site', 'benchmark'],
  // 卸货场引擎（程序库 @storewright/yard）的浏览器演示：npm run build:demo -w @storewright/yard
  ['packages/yard/dist-demo', 'yard'],
];
for (const [from] of parts) if (!existsSync(join(root, from))) throw new Error(`missing ${from}: run npm run build:site (it builds every part first)`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of parts) cpSync(join(root, from), join(out, to), { recursive: true });
// 首页：三个部分、集装箱导览和开发者入口放在一页上（scripts/site-landing.mjs）；导览的动图有就放在首页上
const heroFrom = ['StoreX-Chain/docs/images/tour/ship-to-shelf.en.webp', 'StoreX-Chain/docs/images/tour/ship-to-shelf.webp', 'StoreX-Chain/docs/images/tour/ship-to-shelf.en.jpg'].find((f) => existsSync(join(root, f)));
let hero;
if (heroFrom) {
  mkdirSync(join(out, 'media'), { recursive: true });
  hero = `media/${heroFrom.split('/').pop()}`;
  cpSync(join(root, heroFrom), join(out, hero));
}
writeFileSync(join(out, 'index.html'), landingHtml({ ...(hero ? { hero } : {}), has: (dir) => existsSync(join(out, dir)) }));
// 许可证和第三方组件声明随站点一起分发
for (const f of ['LICENSE', 'LICENSE-docs', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, f), join(out, f));
// GitHub Pages：不经过 Jekyll 处理
writeFileSync(join(out, '.nojekyll'), '');
console.log(`site ready: ${out}`);
