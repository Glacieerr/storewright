import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';

/**
 * 全流程走查的记录器：每一步记录是否通过、用时、说明和截图（写成 NDJSON，报告脚本据此生成图文报告）。
 * 一步失败只记录，不中断后面的步骤，这样报告里能看到全部问题。
 */
export const OUT = join(process.cwd(), 'experiments/results/walkthrough');
mkdirSync(join(OUT, 'shots'), { recursive: true });

export interface StepRecord {
  section: string;
  order: number;
  title: string;
  ok: boolean;
  ms: number;
  note?: string;
  error?: string;
  shot?: string;
  device?: string;
}

let counter = 0;

export class Recorder {
  readonly failures: string[] = [];
  constructor(readonly section: string, readonly sectionNo: number) {}

  /**
   * 执行一步。fn 返回的字符串作为说明写进报告；shot 是这一步之后要截图的页面。
   */
  async step(title: string, fn: () => Promise<string | void>, opts: { shot?: Page; device?: string; fullPage?: boolean } = {}): Promise<boolean> {
    const t0 = Date.now();
    const rec: StepRecord = { section: this.section, order: ++counter, title, ok: true, ms: 0, ...(opts.device ? { device: opts.device } : {}) };
    try {
      const note = await fn();
      if (note) rec.note = note;
    } catch (e) {
      rec.ok = false;
      rec.error = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 6).join('\n');
      this.failures.push(`${title}: ${rec.error.split('\n')[0]}`);
    }
    rec.ms = Date.now() - t0;
    if (opts.shot && !opts.shot.isClosed()) {
      const name = `${String(this.sectionNo).padStart(2, '0')}-${String(rec.order).padStart(3, '0')}.png`;
      try {
        await opts.shot.screenshot({ path: join(OUT, 'shots', name), fullPage: opts.fullPage ?? false, timeout: 10_000 });
        rec.shot = `shots/${name}`;
      } catch {
        // 截图失败不影响结果
      }
    }
    appendFileSync(join(OUT, 'steps.ndjson'), `${JSON.stringify(rec)}\n`);
    return rec.ok;
  }

  /** 只记一条说明（不执行操作） */
  note(title: string, note: string): void {
    appendFileSync(join(OUT, 'steps.ndjson'), `${JSON.stringify({ section: this.section, order: ++counter, title, ok: true, ms: 0, note } satisfies StepRecord)}\n`);
  }
}

export const PHONE = { width: 390, height: 844 };
export const DESK = { width: 1280, height: 860 };

export async function device(browser: Browser, base: string, opts: { viewport?: { width: number; height: number }; locale?: string } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? PHONE, locale: opts.locale ?? 'zh-CN', baseURL: base });
  return ctx.newPage();
}
