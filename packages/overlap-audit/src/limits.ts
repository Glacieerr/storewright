import type { Counts, OverlapTally } from './audit';

/**
 * Limits per area and the report. Use limits as a regression gate: measure today's numbers, add a margin, and fail the run when
 * a change makes any area worse.
 * 每个区域的上限和报告。把上限当回归门槛用：按现在测到的数加一点余量，改动以后哪个区域变多了就失败。
 */
export type Limits = Record<string, Counts>;

export interface LimitRow {
  area: string;
  static: number;
  moving: number;
  limit?: Counts;
  over: boolean;
  /** Largest pairs in this area. 这个区域最多的几种车型对。 */
  pairs: { pair: string; static: number; moving: number }[];
}

export interface LimitReport {
  rows: LimitRow[];
  /** Number of areas over their limit. 超过上限的区域数。 */
  over: number;
}

/**
 * Compare a tally with limits. Rows list the limited areas first (in the order of `limits`), then any other area seen.
 * `enforce: false` reports without flagging (for example on a random map whose numbers are not comparable).
 * 和上限比：先列有上限的区域（按 limits 的顺序），再列其他出现过的区域；enforce: false 只报告、不判超。
 */
export function checkLimits(tally: OverlapTally, limits: Limits = {}, opts: { enforce?: boolean; topPairs?: number } = {}): LimitReport {
  const enforce = opts.enforce ?? true;
  const top = opts.topPairs ?? 4;
  const areas = [...new Set([...Object.keys(limits), ...tally.areaNames()])];
  let over = 0;
  const rows = areas.map((area) => {
    const c = tally.total(area);
    const limit = limits[area];
    const isOver = !!limit && enforce && (c.static > limit.static || c.moving > limit.moving);
    if (isOver) over++;
    return { area, static: c.static, moving: c.moving, ...(limit ? { limit } : {}), over: isOver, pairs: tally.pairs(area).slice(0, top) };
  });
  return { rows, over };
}

/** Plain-text table (English). 纯文本表格（英文）。 */
export function formatReport(r: LimitReport, opts: { title?: string; unit?: string } = {}): string {
  const L: string[] = [];
  if (opts.title) L.push(opts.title);
  L.push(`${'area'.padEnd(24)}${'static'.padStart(10)}${'moving'.padStart(10)}${'limit (static / moving)'.padStart(26)}`);
  for (const row of r.rows) {
    L.push(`${row.area.padEnd(24)}${String(round(row.static)).padStart(10)}${String(round(row.moving)).padStart(10)}${(row.limit ? `${row.limit.static} / ${row.limit.moving}` : '-').padStart(26)}${row.over ? '  OVER' : ''}`);
    for (const p of row.pairs) L.push(`    ${p.pair.padEnd(40)}${String(round(p.static)).padStart(10)}${String(round(p.moving)).padStart(10)}`);
  }
  L.push(r.over ? `${r.over} area(s) over the limit${opts.unit ? ` (${opts.unit})` : ''}` : `all areas within limits${opts.unit ? ` (${opts.unit})` : ''}`);
  return L.join('\n');
}

const round = (x: number) => Math.round(x * 100) / 100;
