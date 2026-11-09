import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { animatedWebp } from '../scripts/media/make-webp.mjs';

/** README 顶部的导览动图（scripts/media/record-tour.mjs 录的）：结构对、大小和时长在约定的范围里，拼装脚本拆开再拼回来一字不差 */
const FILES = ['docs/images/tour/ship-to-shelf.webp', 'docs/images/tour/ship-to-shelf.en.webp'];

interface Chunk {
  id: string;
  data: Buffer;
}
function chunks(buf: Buffer, from: number, to: number): Chunk[] {
  const out: Chunk[] = [];
  let p = from;
  while (p + 8 <= to) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    out.push({ id, data: buf.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}
const chunk = (id: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const still = (frame: Chunk[]) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...frame.map((c) => chunk(c.id, c.data))]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('导览动图', () => {
  for (const f of FILES) {
    const url = new URL(`../${f}`, import.meta.url);
    let buf: Buffer;
    try {
      buf = readFileSync(url);
    } catch {
      it.skip(`${f}（还没录）`, () => undefined);
      continue;
    }
    it(`${f}：动画 WebP、20 帧以上、15–45 秒、不超过 6 MB，拆开再拼回来一样`, () => {
      expect(statSync(url).size).toBeLessThanOrEqual(6 * 1024 * 1024);
      expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
      expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
      const top = chunks(buf, 12, buf.length);
      expect(top[0]?.id).toBe('VP8X');
      expect((top[0]?.data[0] ?? 0) & 0x02).toBe(0x02);
      expect(top[1]?.id).toBe('ANIM');
      const frames = top.filter((c) => c.id === 'ANMF');
      expect(frames.length).toBeGreaterThanOrEqual(20);
      const ms = frames.map((c) => c.data.readUIntLE(12, 3));
      const total = ms.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(15000);
      expect(total).toBeLessThanOrEqual(45000);
      // 拆成静态帧，再用拼装脚本拼回来：和原文件一字不差
      const again = animatedWebp(frames.map((c, i) => ({ data: still(chunks(c.data, 16, c.data.length)), ms: ms[i] as number })));
      expect(again.equals(buf)).toBe(true);
    });
  }
});
