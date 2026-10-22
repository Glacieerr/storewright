import { rmSync } from 'node:fs';

export default function setup(): void {
  rmSync('experiments/results/walkthrough', { recursive: true, force: true });
}
