// 把一组静态 WebP 帧拼成一个动画 WebP（RIFF：VP8X + ANIM + ANMF），不需要 ffmpeg 等外部工具。
// 用法（命令行）：node scripts/media/make-webp.mjs 输出.webp 帧目录   —— 帧目录里有 frames.json：[{ "file": "0001.webp", "ms": 120 }, …]
// 也可以在别的脚本里 import { animatedWebp } 直接用（录导览的脚本 record-tour.mjs 就是这样）。
// 格式见 Google 的 WebP 容器规范（RIFF 容器、扩展格式、动画）。
//
// Assemble still WebP frames into one animated WebP (RIFF: VP8X + ANIM + ANMF), no external tools needed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一个静态 WebP 文件里的块（chunk） */
function chunksOf(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error('不是 WebP 文件');
  const out = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    out.push({ id, data: buf.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}

/** 有损（VP8）或无损（VP8L）位流里的宽、高 */
function sizeOf(chunks) {
  const x = chunks.find((c) => c.id === 'VP8X');
  if (x) return { w: 1 + x.data.readUIntLE(4, 3), h: 1 + x.data.readUIntLE(7, 3) };
  const v = chunks.find((c) => c.id === 'VP8 ');
  if (v) return { w: v.data.readUInt16LE(6) & 0x3fff, h: v.data.readUInt16LE(8) & 0x3fff };
  const l = chunks.find((c) => c.id === 'VP8L');
  if (l) {
    const b = l.data.readUInt32LE(1);
    return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
  }
  throw new Error('WebP 里没有图像数据');
}

const u24 = (n) => {
  const b = Buffer.alloc(3);
  b.writeUIntLE(n, 0, 3);
  return b;
};
function chunk(id, data) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * frames：[{ data: 静态 WebP 文件的 Buffer, ms: 这一帧显示多少毫秒 }]；loop：0 = 一直循环。
 * 所有帧画在 (0, 0)、不混合（每一帧都是完整的画面）。
 */
export function animatedWebp(frames, { loop = 0, background = 0xffffffff } = {}) {
  if (!frames.length) throw new Error('没有帧');
  const parsed = frames.map((f) => {
    const c = chunksOf(f.data);
    return { chunks: c.filter((x) => x.id === 'ALPH' || x.id === 'VP8 ' || x.id === 'VP8L'), size: sizeOf(c), ms: Math.max(20, Math.min(0xffffff, Math.round(f.ms))) };
  });
  const W = Math.max(...parsed.map((p) => p.size.w));
  const H = Math.max(...parsed.map((p) => p.size.h));
  const alpha = parsed.some((p) => p.chunks.some((c) => c.id === 'ALPH'));
  const vp8x = Buffer.concat([Buffer.from([0x02 | (alpha ? 0x10 : 0), 0, 0, 0]), u24(W - 1), u24(H - 1)]);
  const anim = Buffer.alloc(6);
  anim.writeUInt32LE(background >>> 0, 0);
  anim.writeUInt16LE(loop, 4);
  const anmf = parsed.map((p) => chunk('ANMF', Buffer.concat([u24(0), u24(0), u24(p.size.w - 1), u24(p.size.h - 1), u24(p.ms), Buffer.from([0x02]), ...p.chunks.map((c) => chunk(c.id, c.data))])));
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out, dir] = process.argv.slice(2);
  if (!out || !dir) {
    console.error('用法：node scripts/media/make-webp.mjs 输出.webp 帧目录（里面有 frames.json）');
    process.exit(1);
  }
  const list = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
  const buf = animatedWebp(list.map((f) => ({ data: readFileSync(join(dir, f.file)), ms: f.ms })));
  writeFileSync(out, buf);
  console.log(`${out}：${list.length} 帧，${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}
