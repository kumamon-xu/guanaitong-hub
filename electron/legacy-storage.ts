import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppState } from '../src/shared/types';
import type { LocalAddress } from './addresses';
import type { AddressRepository, DiskData, EncryptionOptions, HubRepository, PortableData, SessionRepository } from './persistence';

export function privateDirectory(directory: string): string {
  const path = resolve(directory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('数据目录必须是普通目录');
  chmodSync(path, 0o700);
  return path;
}
export function regularFile(path: string, maxBytes = Infinity): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('本地数据文件无效或过大');
}
export function atomicWrite(path: string, bytes: string | Buffer): void {
  if (existsSync(path)) regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    if (process.platform !== 'win32') {
      const parent = openSync(resolve(path, '..'), 'r');
      try { fsyncSync(parent); } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { closeSync(parent); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Compatibility adapters used to read pre-SQLite vaults and test old backup formats. */
export class LegacyHubRepository implements HubRepository {
  readonly filePath: string;
  constructor(private readonly options: EncryptionOptions) {
    this.filePath = join(privateDirectory(options.directory), 'state.json');
  }
  loadHub(): PortableData | null {
    if (!existsSync(this.filePath)) return null;
    regularFile(this.filePath, 32 * 1024 * 1024);
    const disk = JSON.parse(readFileSync(this.filePath, 'utf8')) as DiskData;
    if (disk.format !== 'guanaitong-hub' || disk.version !== 1 || !disk.state || !disk.credentials || !disk.manualMerges) throw new Error('本地数据文件格式无效');
    const credentials: PortableData['credentials'] = Object.create(null);
    for (const [id, cipher] of Object.entries(disk.credentials)) {
      if (typeof cipher !== 'string' || !cipher || cipher.length > 20000) throw new Error('加密凭据格式无效');
      try { credentials[id] = JSON.parse(this.options.decryptString(Buffer.from(cipher, 'base64'))); }
      catch { throw new Error('系统安全存储无法解密卡片凭据，请在原设备导出加密备份后恢复'); }
    }
    chmodSync(this.filePath, 0o600);
    return { state: { ...disk.state, cards: disk.state.cards.map(card => ({ ...card, number: credentials[card.id]?.number })) } as AppState, credentials, manualMerges: disk.manualMerges };
  }
  saveHub(data: PortableData): void {
    const credentials = Object.fromEntries(Object.entries(data.credentials).map(([id, credential]) => {
      const encrypted = this.options.encryptString(JSON.stringify(credential));
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('系统凭据加密不可用，未保存任何密码');
      return [id, encrypted.toString('base64')];
    }));
    const cards = data.state.cards.map(({ number: _number, ...card }) => card);
    const disk: DiskData = { format: 'guanaitong-hub', version: 1, state: { ...data.state, cards }, credentials, manualMerges: data.manualMerges };
    atomicWrite(this.filePath, JSON.stringify(disk));
  }
}

export class LegacyAddressRepository implements AddressRepository {
  readonly filePath: string;
  constructor(private readonly options: EncryptionOptions) {
    this.filePath = join(privateDirectory(options.directory), 'addresses.enc');
  }
  loadAddresses(): LocalAddress[] {
    if (!existsSync(this.filePath)) return [];
    regularFile(this.filePath, 4 * 1024 * 1024);
    let decoded;
    try { decoded = JSON.parse(this.options.decryptString(readFileSync(this.filePath))); }
    catch { throw new Error('保存的收货地址无法解密或格式无效'); }
    if (!decoded || decoded.format !== 'guanaitong-addresses' || decoded.version !== 1) throw new Error('保存的收货地址版本或格式无效');
    chmodSync(this.filePath, 0o600);
    return decoded.addresses;
  }
  saveAddresses(addresses: LocalAddress[]): void {
    const encrypted = this.options.encryptString(JSON.stringify({ format: 'guanaitong-addresses', version: 1, addresses }));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 4 * 1024 * 1024) throw new Error('收货地址无法安全保存');
    atomicWrite(this.filePath, encrypted);
  }
}

export class LegacySessionRepository implements SessionRepository {
  constructor(private readonly options: EncryptionOptions) { privateDirectory(options.directory); }
  filePathForSession(id: string): string {
    if (typeof id !== 'string' || !id || id.length > 512) throw new Error('卡片会话标识无效');
    return join(this.options.directory, `session-${createHash('sha256').update(id).digest('hex')}.enc`);
  }
  loadSession(id: string): unknown | null {
    const path = this.filePathForSession(id);
    if (!existsSync(path)) return null;
    regularFile(path, 4 * 1024 * 1024);
    try { return JSON.parse(this.options.decryptString(readFileSync(path))); }
    catch { throw new Error('保存的官网登录会话格式无效'); }
  }
  saveSession(id: string, encrypted: Buffer): void { atomicWrite(this.filePathForSession(id), encrypted); }
}
