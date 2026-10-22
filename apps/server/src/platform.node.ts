import { createHash, randomBytes } from 'node:crypto';
import type { HubPlatform } from './platform';

/** Node 平台：系统的 SHA-256 和安全随机数 */
export const nodePlatform: HubPlatform = {
  sha256Hex: (input) => createHash('sha256').update(input).digest('hex'),
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
};
