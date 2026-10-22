import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * 本地演示用的自签名 HTTPS 证书（HTTPS=1）。
 *
 * 手机通过局域网 IP 访问时，浏览器只在 HTTPS 下允许打开摄像头。证书用系统的 openssl 生成，
 * 覆盖 localhost、127.0.0.1 和本机的局域网 IPv4 地址，保存在 dir 中，之后启动时复用；
 * 局域网地址变了或证书快过期时重新生成（手机需要重新接受一次）。正式部署使用云端的 HTTPS。
 */

export interface DevCert {
  key: Buffer;
  cert: Buffer;
  /** 证书覆盖的局域网 IPv4 地址 */
  lan: string[];
  /** 这次启动新生成的证书 */
  created: boolean;
}

/** 本机的局域网 IPv4 地址（不含回环和自分配的 169.254.x.x） */
export function lanAddresses(): string[] {
  const all = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
  return [...new Set(all)];
}

const DAY = 86_400_000;

/** 证书覆盖 localhost 和全部给定 IP，并且一周内不会过期 */
function covers(pem: Buffer, ips: string[]): boolean {
  try {
    const c = new X509Certificate(pem);
    return Date.parse(c.validTo) > Date.now() + 7 * DAY && c.checkHost('localhost') !== undefined && ips.every((ip) => c.checkIP(ip) !== undefined);
  } catch {
    return false;
  }
}

export function devCert(dir: string, lan = lanAddresses()): DevCert {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const ips = ['127.0.0.1', ...lan];
  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath);
    if (covers(cert, ips)) return { key: readFileSync(keyPath), cert, lan, created: false };
  }

  mkdirSync(dir, { recursive: true });
  const conf = join(dir, 'openssl.cnf');
  // 自带配置，不依赖系统的 openssl.cnf；macOS 自带的 LibreSSL 和 OpenSSL 都能用
  writeFileSync(
    conf,
    [
      '[req]',
      'prompt = no',
      'distinguished_name = dn',
      'x509_extensions = ext',
      '[dn]',
      'CN = Storewright local demo',
      '[ext]',
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectKeyIdentifier = hash',
      `subjectAltName = ${['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(', ')}`,
      '',
    ].join('\n'),
  );
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365', '-config', conf, '-keyout', keyPath, '-out', certPath], {
      stdio: 'pipe',
    });
  } catch (err) {
    const detail = (err as { code?: string; stderr?: Buffer }).code === 'ENOENT' ? 'openssl not found on PATH' : String((err as { stderr?: Buffer }).stderr ?? err).trim();
    throw new Error(`HTTPS=1: could not create a self-signed certificate with openssl (${detail})`);
  } finally {
    rmSync(conf, { force: true });
  }
  chmodSync(keyPath, 0o600);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), lan, created: true };
}
