import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EncryptionOptions } from './persistence';
import { LegacyAddressRepository, LegacyHubRepository, LegacySessionRepository, atomicWrite, privateDirectory, regularFile } from './legacy-storage';
import { blankState, validatePortable } from './store';
import { validateAddresses } from './addresses';
import { normalizeOfficialCookies } from './session-vault';
import { SqliteRepository } from './sqlite-repository';

/** No legacy file is rewritten or deleted. A failed import is retried on the next start. */
export function openStorage(options: EncryptionOptions): SqliteRepository {
  const repository = new SqliteRepository(options);
  try {
    if (repository.initialized()) return repository;
    if (repository.loadHub() !== null || repository.loadAddresses().length) throw new Error('数据库初始化记录缺失，已停止迁移以保留现有数据');
    const names = readdirSync(repository.directory).filter(name => name === 'state.json' || name === 'addresses.enc' || /^session-[0-9a-f]{64}\.enc$/.test(name));
    let backup: string | undefined;
    if (names.length) {
      backup = privateDirectory(join(repository.directory, 'backups', `legacy-${Date.now()}-${randomUUID()}`));
      for (const name of names) {
        const source = join(repository.directory, name);
        regularFile(source, name === 'state.json' ? 32 * 1024 * 1024 : 4 * 1024 * 1024);
        atomicWrite(join(backup, name), readFileSync(source));
      }
      atomicWrite(join(backup, 'manifest.json'), JSON.stringify({ format: 'guanaitong-legacy-snapshot', version: 1, files: names, createdAt: new Date().toISOString() }, null, 2));
    }
    const data = validatePortable(new LegacyHubRepository(options).loadHub() ?? { state: blankState(), credentials: {}, manualMerges: {} });
    const addresses = validateAddresses(new LegacyAddressRepository(options).loadAddresses());
    const legacySessions = new LegacySessionRepository(options);
    const sessions = new Map<string, unknown>();
    for (const card of data.state.cards) {
      if (!existsSync(legacySessions.filePathForSession(card.id))) continue;
      const decoded = legacySessions.loadSession(card.id);
      if (!decoded || (!Array.isArray(decoded) && (typeof decoded !== 'object' || !('version' in decoded) || decoded.version !== 1 || !('cookies' in decoded)))) throw new Error('旧官网登录会话格式无效，迁移未完成；原文件已保留');
      const cookies = normalizeOfficialCookies(Array.isArray(decoded) ? decoded : (decoded as { cookies: unknown }).cookies);
      sessions.set(card.id, { version: 1, cookies });
    }
    repository.initialize(data, addresses, sessions, backup);
    return repository;
  } catch (error) {
    repository.close();
    throw error;
  }
}
