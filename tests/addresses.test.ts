import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AddressVault, validateAddressDraft, type AddressDraft, type AddressVaultOptions } from '../electron/addresses';

const NOW = new Date('2026-10-02T04:00:00.000Z');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gat-address-test-'));
  directories.push(directory);
  const key = randomBytes(32);
  const options: AddressVaultOptions = {
    directory, now: () => NOW,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  return { vault: new AddressVault(options), options, directory };
}
function draft(overrides: Partial<AddressDraft> = {}): AddressDraft {
  return {
    label: '家', recipient: '测试收件人', phone: '13800138000', province: '上海市', city: '上海市', district: '黄浦区',
    town: '', detail: '测试路 100 号 101 室', postalCode: '', provinceId: '', cityId: '', districtId: '', townId: '', ...overrides,
  };
}

test('private encrypted addresses reopen without persisting plaintext and return isolated copies', () => {
  const { vault, options, directory } = fixture();
  assert.deepEqual(vault.list(), []);
  const saved = vault.save(draft());
  assert.equal(saved.isDefault, true);
  assert.equal(saved.createdAt, NOW.toISOString());
  assert.equal(saved.updatedAt, NOW.toISOString());
  const bytes = readFileSync(vault.filePath);
  for (const text of ['测试收件人', '13800138000', '测试路', 'recipient', saved.id]) assert.equal(bytes.includes(Buffer.from(text)), false);
  // Windows uses ACLs instead of POSIX permission bits.
  if (process.platform !== 'win32') {
    assert.equal(statSync(vault.filePath).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }
  assert.deepEqual(readdirSync(directory), ['addresses.enc']);
  const reopened = new AddressVault(options);
  assert.deepEqual(reopened.list(), [saved]);
  saved.recipient = '外部修改';
  const listed = reopened.list();
  listed[0].detail = '外部修改';
  assert.equal(vault.list()[0].recipient, '测试收件人');
  assert.equal(reopened.list()[0].detail, '测试路 100 号 101 室');
});

test('save trims all fields and drops unknown supplied data', () => {
  const { vault } = fixture();
  const input = { ...draft({ label: ' 家 ', recipient: ' 收件人 ', phone: ' 13912345678 ', detail: ' 测试路 200 号 ', provinceId: ' 310000 ', postalCode: ' 200001 ' }), officialToken: 'should-never-persist' };
  const saved = vault.save(input);
  assert.equal(saved.label, '家');
  assert.equal(saved.recipient, '收件人');
  assert.equal(saved.phone, '13912345678');
  assert.equal(saved.detail, '测试路 200 号');
  assert.equal(saved.provinceId, '310000');
  assert.equal(saved.postalCode, '200001');
  assert.equal('officialToken' in saved, false);
  assert.equal(input.label, ' 家 ');
});

test('default switches, edits and removals maintain exactly one default for a nonempty list', () => {
  const { vault, options } = fixture();
  const first = vault.save(draft());
  const second = vault.save(draft({ label: '办公室', detail: '测试路 200 号' }));
  const third = vault.save(draft({ label: '其他', detail: '测试路 300 号' }));
  assert.deepEqual(vault.list().map(item => item.isDefault), [true, false, false]);
  options.now = () => new Date('2026-10-03T04:00:00.000Z');
  vault.setDefault(second.id);
  assert.deepEqual(vault.list().map(item => item.isDefault), [false, true, false]);
  const edited = vault.save(draft({ label: '公司', detail: '测试路 201 号' }), second.id);
  assert.equal(edited.id, second.id);
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(edited.updatedAt, '2026-10-03T04:00:00.000Z');
  assert.equal(edited.isDefault, true);
  vault.remove(second.id);
  assert.deepEqual(vault.list().map(item => item.isDefault), [true, false]);
  vault.remove(first.id);
  assert.equal(vault.list()[0].id, third.id);
  assert.equal(vault.list()[0].isDefault, true);
  vault.remove(third.id);
  assert.deepEqual(vault.list(), []);
  assert.deepEqual(new AddressVault(options).list(), []);
});

test('malformed drafts and unknown IDs never change existing addresses or their ciphertext', () => {
  const { vault } = fixture();
  const saved = vault.save(draft());
  const bytes = readFileSync(vault.filePath);
  const invalid: Array<Partial<AddressDraft>> = [
    { recipient: ' ' }, { phone: '12800138000' }, { phone: '+8613800138000' }, { phone: '1380013800' },
    { province: '' }, { city: '' }, { district: '' }, { detail: '' }, { detail: 'a\nb' },
    { label: 'x'.repeat(81) }, { postalCode: '12345' }, { postalCode: 'abc123' }, { provinceId: '../310000' },
  ];
  for (const changes of invalid) assert.throws(() => vault.save(draft(changes), saved.id));
  assert.throws(() => validateAddressDraft(null), /格式无效/);
  assert.throws(() => vault.save(draft(), 'missing'), /不存在/);
  assert.throws(() => vault.setDefault('missing'), /不存在/);
  assert.throws(() => vault.remove('missing'), /不存在/);
  assert.deepEqual(vault.list(), [saved]);
  assert.deepEqual(readFileSync(vault.filePath), bytes);
});

test('encrypted replacement validates duplicate IDs, defaults, timestamps and schema before committing', () => {
  const { vault } = fixture();
  const first = vault.save(draft());
  const second = vault.save(draft({ label: '其他' }));
  const original = vault.list();
  const bytes = readFileSync(vault.filePath);
  const invalid: unknown[] = [
    {}, null, [first, first], [{ ...first, id: '../bad' }], [{ ...first, isDefault: false }],
    [first, { ...second, isDefault: true }], [{ ...first, isDefault: 'true' }],
    [{ ...first, createdAt: '2026-02-31T04:00:00.000Z' }], [{ ...first, updatedAt: '2026-10-01T04:00:00.000Z' }],
    [{ ...first, phone: 'bad' }],
  ];
  for (const value of invalid) assert.throws(() => vault.replace(value));
  assert.deepEqual(vault.list(), original);
  assert.deepEqual(readFileSync(vault.filePath), bytes);
  assert.deepEqual(vault.replace([{ ...second, isDefault: true }]), [{ ...second, isDefault: true }]);
});

test('encryption and filesystem write failures preserve memory and the last complete encrypted snapshot', () => {
  const { vault, options, directory } = fixture();
  const saved = vault.save(draft());
  const bytes = readFileSync(vault.filePath);
  const encrypt = options.encryptString;
  options.encryptString = () => { throw new Error('keychain unavailable'); };
  assert.throws(() => vault.save(draft({ detail: '不应保存' }), saved.id), /keychain unavailable/);
  options.encryptString = () => Buffer.alloc(0);
  assert.throws(() => vault.remove(saved.id), /无法安全保存/);
  options.encryptString = encrypt;
  assert.deepEqual(vault.list(), [saved]);
  assert.deepEqual(readFileSync(vault.filePath), bytes);
  const moved = `${directory}-moved`;
  directories.push(moved);
  renameSync(directory, moved);
  try {
    assert.throws(() => vault.save(draft({ detail: '不应保存' }), saved.id));
    assert.deepEqual(vault.list(), [saved]);
    assert.deepEqual(readFileSync(join(moved, 'addresses.enc')), bytes);
    assert.deepEqual(readdirSync(moved), ['addresses.enc']);
  } finally { renameSync(moved, directory); }
  assert.equal(vault.save(draft({ detail: '恢复写入' }), saved.id).detail, '恢复写入');
});

test('corrupt, unsupported and invalid encrypted files remain untouched on reopening', () => {
  const { vault, options } = fixture();
  vault.save(draft());
  for (const invalid of [
    'not-json', '{"format":"guanaitong-addresses","version":2,"addresses":[]}',
    '{"format":"guanaitong-addresses","version":1,"addresses":{}}',
    JSON.stringify({ format: 'guanaitong-addresses', version: 1, addresses: [{ ...vault.list()[0], phone: 'bad' }] }),
  ]) {
    writeFileSync(vault.filePath, options.encryptString(invalid));
    const before = readFileSync(vault.filePath);
    assert.throws(() => new AddressVault(options));
    assert.deepEqual(readFileSync(vault.filePath), before);
  }
  writeFileSync(vault.filePath, Buffer.from('broken cipher'));
  const before = readFileSync(vault.filePath);
  assert.throws(() => new AddressVault(options), /无法解密/);
  assert.deepEqual(readFileSync(vault.filePath), before);
});

test('portable password backups reopen under a different OS key, retaining default and metadata', () => {
  const source = fixture();
  const first = source.vault.save(draft());
  const second = source.vault.save(draft({ label: '办公室' }));
  source.vault.setDefault(second.id);
  const backup = source.vault.exportBackup('test password 123');
  assert.equal(backup.includes('13800138000'), false);
  assert.equal(backup.includes('测试收件人'), false);
  assert.equal(backup.includes(first.id), false);
  const destination = fixture();
  destination.vault.save(draft({ label: '将被替换' }));
  const restored = destination.vault.importBackup(backup, 'test password 123');
  assert.deepEqual(restored, source.vault.list());
  assert.deepEqual(new AddressVault(destination.options).list(), restored);
  assert.notDeepEqual(readFileSync(destination.vault.filePath), readFileSync(source.vault.filePath));
  const emptyBackup = new AddressVault({ ...source.options, directory: fixture().directory }).exportBackup('test password 123');
  assert.deepEqual(destination.vault.importBackup(emptyBackup, 'test password 123'), []);
});

test('wrong password, tampering and invalid backup parameters never replace local addresses', () => {
  const { vault } = fixture();
  vault.save(draft());
  const original = vault.list();
  const bytes = readFileSync(vault.filePath);
  const backup = vault.exportBackup('correct password');
  assert.throws(() => vault.importBackup(backup, 'wrong password'), /口令错误或文件已损坏/);
  const tampered = JSON.parse(backup);
  const data = Buffer.from(tampered.data, 'base64');
  data[0] ^= 1;
  tampered.data = data.toString('base64');
  assert.throws(() => vault.importBackup(JSON.stringify(tampered), 'correct password'), /口令错误或文件已损坏/);
  for (const change of [{ version: 2 }, { format: 'guanaitong-hub-backup' }, { salt: 'AA==' }, { iv: '?' }, { tag: 'AA==' }, { data: '' }]) {
    assert.throws(() => vault.importBackup(JSON.stringify({ ...JSON.parse(backup), ...change }), 'correct password'));
  }
  assert.throws(() => vault.importBackup('bad-json', 'correct password'), /有效 JSON/);
  assert.throws(() => vault.exportBackup('short'), /口令/);
  assert.throws(() => vault.importBackup(backup, 'short'), /口令/);
  assert.deepEqual(vault.list(), original);
  assert.deepEqual(readFileSync(vault.filePath), bytes);
});
