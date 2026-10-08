import { LegacySessionRepository } from './legacy-storage';
import type { SessionRepository } from './persistence';

const MAX_COOKIES = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface OfficialCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

export interface SessionVaultOptions {
  repository?: SessionRepository;
  directory: string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  /** Unix time in seconds, matching Chromium cookie expiration timestamps. */
  now?: () => number;
}

function malformed(): never { throw new Error('保存的官网登录会话格式无效'); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function booleanField(cookie: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (cookie[key] === undefined) return fallback;
  if (typeof cookie[key] !== 'boolean') malformed();
  return cookie[key] as boolean;
}

/** Only the official site's cookies belong in a card vault. CAPTCHA provider cookies are excluded. */
export function officialCookieDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string' || domain.length > 254) return false;
  const host = domain.replace(/^\./, '').toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*guanaitong\.com$/.test(host)) return false;
  return true;
}

/** Accept Electron and CDP cookies, preserving real expirations and host-only scope. */
export function normalizeOfficialCookies(value: unknown, nowSeconds = Date.now() / 1000): OfficialCookie[] {
  if (!Array.isArray(value) || value.length > MAX_COOKIES || !Number.isFinite(nowSeconds)) malformed();
  const result = new Map<string, OfficialCookie>();
  for (const item of value) {
    if (!record(item) || typeof item.domain !== 'string') malformed();
    if (!officialCookieDomain(item.domain)) continue;
    if (typeof item.name !== 'string' || !item.name || /[=;\s]/.test(item.name) || CONTROL_CHARACTERS.test(item.name)) malformed();
    if (typeof item.value !== 'string' || CONTROL_CHARACTERS.test(item.value)) malformed();
    if (item.path !== undefined && (typeof item.path !== 'string' || !item.path.startsWith('/') || CONTROL_CHARACTERS.test(item.path))) malformed();

    // Do not coerce malformed expiry strings to numbers or convert them into session cookies.
    const expiry = item.expirationDate !== undefined ? item.expirationDate : item.expires;
    if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry))) malformed();
    // CDP uses -1 for a session cookie. Electron leaves expirationDate absent.
    const expirationDate = expiry === -1 || expiry === undefined ? undefined : expiry as number;
    if (expirationDate !== undefined && expirationDate <= nowSeconds) continue;

    const sameSites: Record<string, OfficialCookie['sameSite']> = {
      unspecified: 'unspecified', no_restriction: 'no_restriction', lax: 'lax', strict: 'strict',
      None: 'no_restriction', Lax: 'lax', Strict: 'strict',
    };
    const sameSite = typeof item.sameSite === 'string' ? sameSites[item.sameSite] : undefined;
    if (item.sameSite !== undefined && !sameSite) malformed();
    const cookie: OfficialCookie = {
      name: item.name,
      value: item.value,
      domain: item.domain.toLowerCase(),
      path: typeof item.path === 'string' ? item.path : '/',
      secure: booleanField(item, 'secure', false),
      httpOnly: booleanField(item, 'httpOnly', false),
      hostOnly: booleanField(item, 'hostOnly', !item.domain.startsWith('.')),
      ...(sameSite ? { sameSite } : {}),
      ...(expirationDate === undefined ? {} : { expirationDate }),
    };
    const key = JSON.stringify([cookie.domain.replace(/^\./, ''), cookie.path, cookie.name]);
    result.set(key, cookie);
  }
  return [...result.values()];
}

/** Strip read-only Chromium properties and preserve host-only cookies when setting them. */
export function officialCookieDetails(cookie: OfficialCookie) {
  const host = cookie.domain.replace(/^\./, '');
  const url = new URL(`https://${host}`);
  url.pathname = cookie.path;
  return {
    url: url.toString(), name: cookie.name, value: cookie.value,
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
}

/** OS encryption is injected, keeping this module independent of Electron and testable. */
export class SessionVault {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly now: () => number;

  private readonly repository: SessionRepository;
  constructor(private readonly options: SessionVaultOptions) {
    this.now = options.now ?? (() => Date.now() / 1000);
    this.repository = options.repository ?? new LegacySessionRepository(options);
  }

  filePath(id: string): string { return this.repository.filePathForSession(id); }

  load(id: string): OfficialCookie[] {
    const decoded = this.repository.loadSession(id);
    if (decoded === null) return [];
    // Accept existing encrypted array files from version 0.1 without rewriting them on read.
    if (Array.isArray(decoded)) return normalizeOfficialCookies(decoded, this.now());
    if (!record(decoded) || decoded.version !== 1) malformed();
    return normalizeOfficialCookies(decoded.cookies, this.now());
  }

  /** Serialize both cookie capture and disk replacement so a stale capture cannot overwrite a new one. */
  save(id: string, capture: () => Promise<unknown>): Promise<void> {
    this.filePath(id);
    const previous = this.pending.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const cookies = normalizeOfficialCookies(await capture(), this.now());
      const value = JSON.stringify({ version: 1, savedAt: this.now(), cookies });
      const encrypted = this.options.encryptString(value);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_FILE_BYTES) throw new Error('官网登录会话无法安全保存');
      await this.repository.saveSession(id, encrypted);
    });
    this.pending.set(id, work);
    const cleanup = () => { if (this.pending.get(id) === work) this.pending.delete(id); };
    work.then(cleanup, cleanup);
    return work;
  }

  /** Wait for queued writes before closing Chromium sessions on normal application exit. */
  async flush(): Promise<void> { await Promise.all([...this.pending.values()]); }

}
