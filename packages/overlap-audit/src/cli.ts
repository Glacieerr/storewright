#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { formatReport, type Limits } from './limits';
import { auditTrajectories } from './run';
import { validateTrajectories, type TrajectoryFile } from './trajectory';

/**
 * overlap-audit <trajectories.json> [--step 1] [--from t] [--to t] [--limits limits.json] [--touching] [--json]
 * Exit code: 0 within limits, 1 over a limit, 2 bad input.
 * 退出码：0 都在上限以内，1 有区域超了，2 输入有误。
 */
const USAGE = 'usage: overlap-audit <trajectories.json> [--step 1] [--from t] [--to t] [--limits limits.json] [--touching] [--json]';

function main(argv: string[]): number {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length ? 0 : 2;
  }
  const opt = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const VALUE = new Set(['--step', '--from', '--to', '--limits']);
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUE.has(a)) i++;
    else if (!a.startsWith('--')) {
      file = a;
      break;
    }
  }
  if (!file) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let data: TrajectoryFile;
  let limits: Limits | undefined;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
    const lf = opt('limits');
    if (lf) limits = JSON.parse(readFileSync(lf, 'utf8'));
  } catch (e) {
    process.stderr.write(`cannot read input: ${String(e)}\n`);
    return 2;
  }
  const errors = validateTrajectories(data);
  if (errors.length) {
    process.stderr.write(`invalid trajectory file:\n  ${errors.join('\n  ')}\n`);
    return 2;
  }
  const num = (k: string) => (opt(k) !== undefined ? Number(opt(k)) : undefined);
  const r = auditTrajectories(data, { step: num('step') ?? 1, from: num('from'), to: num('to'), ...(limits ? { limits } : {}), touching: argv.includes('--touching') });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    process.stdout.write(`${formatReport(r, { title: `overlap audit · ${file} · t ${r.t0}–${r.t1} s every ${r.step} s (${r.samples} samples) · unit: pair-seconds` })}\n`);
    for (const e of r.examples) process.stdout.write(`  e.g. t=${e.t} ${e.area}: ${e.a} × ${e.b} (${e.pair})\n`);
  }
  return r.over ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
