import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { normalizeOfficialCookies, officialCookieDetails, officialCookieDomain, SessionVault, type SessionVaultOptions } from '../electron/session-vault';

const NOW = Date.parse('2026-10-02T04:00:00Z') / 1000;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gat-session-test-'));
  directories.push(directory);
  const key = randomBytes(32);
  const options: SessionVaultOptions = {
    directory, now: () => NOW,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  return { vault: new SessionVault(options), options, directory };
}
function cookie(value = 'fake-auth-token', changes: Record<string, unknown> = {}) {
  return { name: 'auth', value, domain: '.guanaitong.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: NOW + 3600, ...changes };
}

test('only exact official domains and subdomains are accepted', () => {
  for (const domain of ['guanaitong.com', '.guanaitong.com', 'a.guanaitong.com', '.pay.guanaitong.com', 'A.GUANAITONG.COM']) assert.equal(officialCookieDomain(domain), true);
  for (const domain of ['guanaitong.com.evil.test', 'evilguanaitong.com', '..guanaitong.com', 'https://a.guanaitong.com', 'a.guanaitong.com:443', '-bad.guanaitong.com', 'captcha.example', null]) assert.equal(officialCookieDomain(domain), false);
  const normalized = normalizeOfficialCookies([cookie(), cookie('provider-token', { domain: 'captcha.example' })], NOW);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].value, 'fake-auth-token');
});

test('CDP and Electron expiry normalization keeps session cookies without inventing lifetime', () => {
  const normalized = normalizeOfficialCookies([
    cookie('current'), cookie('expired', { name: 'expired', expirationDate: NOW }),
    cookie('session', { name: 'session', expirationDate: undefined, expires: -1, sameSite: 'None' }),
    cookie('cdp', { name: 'cdp', expirationDate: undefined, expires: NOW + 120, sameSite: 'Strict' }),
  ], NOW);
  assert.equal(normalized.length, 3);
  assert.equal(normalized.find(item => item.name === 'session')!.expirationDate, undefined);
  assert.equal(normalized.find(item => item.name === 'session')!.sameSite, 'no_restriction');
  assert.equal(normalized.find(item => item.name === 'cdp')!.expirationDate, NOW + 120);
  assert.equal(normalized.find(item => item.name === 'cdp')!.sameSite, 'strict');
  for (const expiry of ['9999999999', null, NaN, Infinity]) assert.throws(() => normalizeOfficialCookies([cookie('invalid', { expirationDate: expiry })], NOW), /格式无效/);
});

test('restoration preserves host-only scope and removes properties Electron cannot set', () => {
  const [hostOnly, domainCookie] = normalizeOfficialCookies([
    cookie('host', { name: 'host', domain: 'a.guanaitong.com', hostOnly: true, session: false, size: 14, sameParty: false }),
    cookie('domain', { name: 'domain' }),
  ], NOW);
  const hostDetails = officialCookieDetails(hostOnly);
  assert.equal(hostDetails.url, 'https://a.guanaitong.com/');
  assert.equal('domain' in hostDetails, false);
  assert.equal('hostOnly' in hostDetails, false);
  assert.equal('size' in hostDetails, false);
  assert.equal(officialCookieDetails(domainCookie).domain, '.guanaitong.com');
});

test('encrypted private snapshots reopen, omit expired cookies and leave no temporary file', async () => {
  const { vault, options, directory } = fixture();
  await vault.save('card-a', async () => [cookie(), cookie('session-value', { name: 'session', expirationDate: undefined })]);
  const file = vault.filePath('card-a');
  assert.equal(readFileSync(file).includes(Buffer.from('fake-auth-token')), false);
  assert.equal(readFileSync(file).includes(Buffer.from('card-a')), false);
  // Windows uses ACLs instead of POSIX permission bits.
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(readdirSync(directory).length, 1);
  assert.equal(new SessionVault(options).load('card-a').length, 2);
  const later = new SessionVault({ ...options, now: () => NOW + 3601 });
  const restored = later.load('card-a');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].name, 'session');
  assert.deepEqual(vault.load('unknown-card'), []);
});

test('legacy encrypted arrays migrate on next save; corrupt reads never rewrite the snapshot', async () => {
  const { vault, options } = fixture();
  const path = vault.filePath('legacy');
  writeFileSync(path, options.encryptString(JSON.stringify([cookie()])), { mode: 0o600 });
  const old = readFileSync(path);
  assert.equal(vault.load('legacy')[0].value, 'fake-auth-token');
  assert.deepEqual(readFileSync(path), old);
  await vault.save('legacy', async () => vault.load('legacy'));
  assert.equal(JSON.parse(options.decryptString(readFileSync(path))).version, 1);
  for (const invalid of ['not-json-secret', '{"version":2,"cookies":[]}', '{"version":1,"cookies":"invalid"}', JSON.stringify([cookie('invalid', { expirationDate: 'tomorrow' })])]) {
    writeFileSync(path, options.encryptString(invalid));
    const before = readFileSync(path);
    assert.throws(() => vault.load('legacy'), /格式无效/);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('same-card writes serialize capture, while another card saves independently', async () => {
  const { vault } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const first = vault.save('card-a', async () => { calls.push('first'); await gate; return [cookie('old')]; });
  const second = vault.save('card-a', async () => { calls.push('second'); return [cookie('new')]; });
  await vault.save('card-b', async () => [cookie('other')]);
  assert.deepEqual(calls, ['first']);
  assert.equal(vault.load('card-b')[0].value, 'other');
  release();
  await Promise.all([first, second, vault.flush()]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(vault.load('card-a')[0].value, 'new');
});

test('capture, malformed input and encryption failures keep the last complete snapshot; later saves recover', async () => {
  const { vault, options, directory } = fixture();
  await vault.save('card-a', async () => [cookie('complete')]);
  const path = vault.filePath('card-a');
  const before = readFileSync(path);
  await assert.rejects(vault.save('card-a', async () => { throw new Error('cookie read failed'); }), /cookie read failed/);
  await assert.rejects(vault.save('card-a', async () => [cookie('bad', { value: null })]), /格式无效/);
  const broken = new SessionVault({ ...options, encryptString() { throw new Error('keychain unavailable'); } });
  await assert.rejects(broken.save('card-a', async () => [cookie('incomplete')]), /keychain unavailable/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(readdirSync(directory).length, 1);
  await vault.save('card-a', async () => [cookie('recovered')]);
  assert.equal(vault.load('card-a')[0].value, 'recovered');
});

test('an explicitly empty cookie capture persists logout instead of resurrecting an older session', async () => {
  const { vault } = fixture();
  await vault.save('card-a', async () => [cookie()]);
  await vault.save('card-a', async () => []);
  assert.deepEqual(vault.load('card-a'), []);
});
