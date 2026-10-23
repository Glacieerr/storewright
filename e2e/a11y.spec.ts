import { expect, test } from './fixtures';

/**
 * 无障碍检查（决策记录 0015）：主要页面在浅色和深色主题下，所有按钮、链接、输入框都有可读的名称；
 * 文字和背景的对比度达到 WCAG AA（正文 4.5:1，大字 3:1）；只用键盘可以登录。
 */
const PAGES: Array<[string, string, number]> = [
  ['登录', '/app/?store=demo', 3000],
  ['拣货员', '/app/?as=A01', 3000],
  ['交付员', '/app/?as=A05', 3000],
  ['带班负责人', '/app/?as=A08', 3000],
  ['控制台', '/app/?as=console', 3000],
  ['展示页', '/app/showcase.html', 8000],
  ['模拟器', '/sim/', 9000],
];

/** 在页面里运行：找出没有名称的可操作元素、对比度不够的文字、统计焦点样式规则 */
const audit = (): { unnamed: string[]; lowContrast: string[]; focusRules: number } => {
  type Rgba = { r: number; g: number; b: number; a: number };
  const out = { unnamed: [] as string[], lowContrast: [] as string[], focusRules: 0 };
  const name = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    const labels = (el as HTMLInputElement).labels;
    return (
      el.getAttribute('aria-label') ||
      (labelledBy ? document.getElementById(labelledBy)?.textContent : '') ||
      (labels ? [...labels].map((l) => l.textContent ?? '').join(' ') : '') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.textContent ||
      el.getAttribute('value') ||
      el.getAttribute('alt') ||
      ''
    ).trim();
  };
  const tag = (el: Element) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`;
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]')) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (!name(el)) out.unnamed.push(tag(el));
  }
  const parse = (c: string): Rgba | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = (m[1] as string).split(',').map((x) => parseFloat(x));
    return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }: Rgba) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el: Element): Rgba => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const seen = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const el = t.parentElement;
    if (!el || !t.textContent?.trim()) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest('canvas, svg, [aria-hidden=true]')) continue;
    const fg = parse(st.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(st.fontSize);
    const large = size >= 24 || (parseInt(st.fontWeight, 10) >= 700 && size >= 18.66);
    if (ratio < (large ? 3 : 4.5)) {
      const key = `${tag(el)}|${st.color}|${ratio.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.lowContrast.push(`${ratio.toFixed(2)} ${tag(el)} "${t.textContent.trim().slice(0, 24)}" ${st.color} on rgb(${bg.r},${bg.g},${bg.b})`);
      }
    }
  }
  out.focusRules = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    })
    .filter((rule) => (rule as CSSStyleRule).selectorText?.includes(':focus')).length;
  return out;
};

for (const scheme of ['light', 'dark'] as const) {
  test(`无障碍：名称、对比度、焦点样式（${scheme === 'light' ? '浅色' : '深色'}主题）`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN', colorScheme: scheme });
    await ctx.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
    const problems: string[] = [];
    for (const [label, path, wait] of PAGES) {
      const p = await ctx.newPage();
      await p.goto(path);
      await p.waitForTimeout(wait);
      const r = await p.evaluate(audit);
      for (const x of r.unnamed) problems.push(`${label}：没有名称 ${x}`);
      for (const x of r.lowContrast) problems.push(`${label}：对比度不够 ${x}`);
      if (r.focusRules === 0) problems.push(`${label}：没有焦点样式`);
      await p.close();
    }
    await ctx.close();
    expect(problems).toEqual([]);
  });
}

test('只用键盘登录：Tab 到员工，回车进入作业端', async ({ page }) => {
  await page.goto('/app/?store=demo');
  await expect(page.locator('.person').first()).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.classList.contains('person'))) break;
  }
  expect(await page.evaluate(() => document.activeElement?.classList.contains('person'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.statusbar')).toBeVisible({ timeout: 30_000 });
});
