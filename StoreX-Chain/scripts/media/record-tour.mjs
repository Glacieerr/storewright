// 录「一个集装箱从船到货架」导览的动画 WebP（README 顶部用）：开发服务器开着时（npm run dev）运行
//   node scripts/media/record-tour.mjs [--lang zh|en] [--out docs/images/tour/ship-to-shelf.webp] [--poster docs/images/tour/ship-to-shelf.jpg]
//                                      [--url http://localhost:5182/] [--width 960] [--q 0.62] [--max-mb 6]
// 用本机的 Chrome（Playwright 的 channel: 'chrome'）无界面打开网页、放导览：每一段让镜头慢慢飞（几秒），这期间尽量多截几帧，
// 拼的时候每帧只放 0.11 秒（动图里飞行一秒左右）；镜头停稳后截一帧停留近两秒（读说明卡）；截图在页面的画布里转成 WebP，再用 make-webp.mjs 拼成动画。超过 --max-mb 就降画质重拼。
// 不需要 ffmpeg；画面只取三维视图那一块（含导览卡片），工具条和跟随横幅不录。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { animatedWebp } from './make-webp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const LANG = opt('lang', 'zh');
const URL0 = opt('url', 'http://localhost:5182/');
const OUT = resolve(ROOT, opt('out', `docs/images/tour/ship-to-shelf${LANG === 'en' ? '.en' : ''}.webp`));
const POSTER = resolve(ROOT, opt('poster', `docs/images/tour/ship-to-shelf${LANG === 'en' ? '.en' : ''}.jpg`));
const WIDTH = Number(opt('width', 960));
const MAX_MB = Number(opt('max-mb', 6));
/** 每一段：镜头飞的那几秒录多久、停稳后那一帧停多久（跨天的段多停一会儿） */
/** 每一段镜头飞行截几帧、每帧在动图里放多久（毫秒）：镜头飞多久按截一帧要多久来定，机器忙的时候也一样顺 */
const FLY_FRAMES = 8;
const FRAME_MS = 110;
const HOLD_MS = 1500;
const HOLD_SKIP_MS = 2000;
const END_MS = 2600;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await page.routeWebSocket(/localhost:5182/, () => {});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
await page.goto(`${URL0}${URL0.includes('?') ? '&' : '?'}lang=${LANG}&onboard=0`);
await page.waitForFunction(() => document.getElementById('busy')?.hidden === true, null, { timeout: 300000 });
await page.selectOption('#quality', 'high').catch(() => {});
await page.addStyleTag({ content: '#toolbar,.follow,.tk-filters{display:none!important}' });
await page.waitForTimeout(6000);
await page.waitForSelector('#tour-btn', { state: 'visible', timeout: 60000 });
await page.click('#tour-btn');
await page.waitForFunction(() => window.__twin?.tour?.()?.isActive, null, { timeout: 60000 });
// 自己控制节奏：关掉自动翻页；先量一下截一帧要多久，让镜头飞 FLY_FRAMES 帧那么久，拼的时候每帧只放 FRAME_MS（飞行在动图里一秒左右）
const rect0 = await page.evaluate(() => {
  const r = document.querySelector('.map-wrap').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const m0 = Date.now();
for (let i = 0; i < 3; i++) await page.screenshot({ clip: rect0, type: 'jpeg', quality: 88 });
const shotMs = (Date.now() - m0) / 3;
await page.evaluate((fly) => {
  const tp = window.__twin.tour();
  tp.autoAdvance = false;
  tp.flyMs = fly;
}, Math.round(shotMs * FLY_FRAMES));
const n = await page.evaluate(() => window.__twin.tour().state.journey.legs.length);
const rect = await page.evaluate(() => {
  const r = document.querySelector('.map-wrap').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
/** 截到的帧：JPEG + 这一帧显示的毫秒 */
const shots = [];
const shot = async () => page.screenshot({ clip: rect, type: 'jpeg', quality: 88 });
for (let k = 0; k <= n; k++) {
  await page.evaluate((i) => window.__twin.tour().go(i), k);
  if (k === n) {
    await page.waitForTimeout(700);
    shots.push({ jpg: await shot(), ms: END_MS });
    break;
  }
  const skip = await page.evaluate(() => {
    const tp = window.__twin.tour();
    return !!tp.state.journey.legs[tp.state.index].skipDays;
  });
  for (let f = 0; f < FLY_FRAMES; f++) shots.push({ jpg: await shot(), ms: FRAME_MS });
  await page.waitForTimeout(400);
  shots.push({ jpg: await shot(), ms: skip ? HOLD_SKIP_MS : HOLD_MS });
}
await page.evaluate(() => window.__twin.tour().stop());

// 在一个空白页面的画布里把 JPEG 缩到 WIDTH 宽、转成 WebP（不同画质）
const conv = await (await browser.newContext()).newPage();
async function toWebp(q) {
  const out = [];
  for (const s of shots) {
    const b64 = await conv.evaluate(
      async ({ src, width, q }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round((img.height * width) / img.width);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/webp', q).split(',')[1];
      },
      { src: `data:image/jpeg;base64,${s.jpg.toString('base64')}`, width: WIDTH, q },
    );
    out.push({ data: Buffer.from(b64, 'base64'), ms: s.ms });
  }
  return out;
}
let q = Number(opt('q', 0.62));
let buf;
for (;;) {
  buf = animatedWebp(await toWebp(q));
  if (buf.length <= MAX_MB * 1024 * 1024 || q <= 0.3) break;
  q = Math.round((q - 0.08) * 100) / 100;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
// 海报：第一段停稳的那一帧（缩到同样宽）
const holdFirst = shots.find((s) => s.ms >= HOLD_MS) ?? shots[0];
const posterB64 = await conv.evaluate(
  async ({ src, width }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((img.height * width) / img.width);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.84).split(',')[1];
  },
  { src: `data:image/jpeg;base64,${holdFirst.jpg.toString('base64')}`, width: WIDTH },
);
writeFileSync(POSTER, Buffer.from(posterB64, 'base64'));
const total = shots.reduce((a, s) => a + s.ms, 0);
console.log(`${OUT}：截一帧约 ${Math.round(shotMs)} 毫秒；${shots.length} 帧、${(total / 1000).toFixed(1)} 秒、画质 ${q}、${(buf.length / 1024 / 1024).toFixed(2)} MB；海报 ${POSTER}`);
if (errs.length) console.log('页面报错：', errs);
await browser.close();
