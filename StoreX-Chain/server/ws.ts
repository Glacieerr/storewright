import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * 不依赖第三方库的 WebSocket（RFC 6455）：握手、文本帧收发、ping / pong、关闭。
 * 服务端发的帧不加掩码；客户端发来的帧带掩码（浏览器、虚幻引擎、MATLAB 的 WebSocket 客户端都这样）。
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 一帧最多多大（实时接入一次最多推 16 MB，留点余量）：更大的直接断开，不往内存里攒 */
const MAX_FRAME = 20 * 1024 * 1024;

export class WsClient {
  onMessage?: (text: string) => void;
  onClose?: () => void;
  private buf = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d: Buffer) => this.read(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }

  get open(): boolean {
    return !this.closed;
  }

  send(obj: unknown): void {
    if (this.closed) return;
    this.frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8'));
  }

  close(): void {
    if (this.closed) return;
    this.frame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  private frame(op: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), bigLen(n)]);
    this.socket.write(Buffer.concat([head, payload]));
  }

  private read(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0] as number;
      const b1 = this.buf[1] as number;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_FRAME) {
        this.close();
        return;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] = (payload[i] as number) ^ (this.buf[maskOff + (i % 4)] as number);
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) this.close();
      else if (op === 0x9) this.frame(0xa, payload);
      else if (op === 0x1) this.onMessage?.(payload.toString('utf8'));
    }
  }
}

function bigLen(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** 处理 HTTP 的 upgrade：握手成功返回客户端，不是 WebSocket 请求返回 undefined */
export function acceptWs(req: IncomingMessage, socket: Duplex): WsClient | undefined {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return undefined;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  return new WsClient(socket);
}
