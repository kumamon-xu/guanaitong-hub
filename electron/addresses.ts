import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { LegacyAddressRepository } from './legacy-storage';
import type { AddressRepository } from './persistence';

export interface AddressDraft {
  label: string;
  recipient: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  town: string;
  detail: string;
  postalCode: string;
  provinceId: string;
  cityId: string;
  districtId: string;
  townId: string;
}

export interface LocalAddress extends AddressDraft {
  id: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AddressVaultOptions {
  repository?: AddressRepository;
  directory: string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  now?: () => Date | string;
}

const MAX_ADDRESSES = 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const BACKUP_AAD = Buffer.from('guanaitong-addresses-backup:1');
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ADDRESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function field(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) fail(`${label}格式无效`);
  const result = value.trim();
  if (result.length > max) fail(`${label}格式无效`);
  if (required && !result) fail(`请填写${label}`);
  return result;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('地址时间格式无效');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('地址时间格式无效');
  return value;
}
function passphrase(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024) fail('备份口令须为 8 至 1024 个字符');
}
function encryptedField(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('地址备份加密数据格式无效');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) fail('地址备份加密数据格式无效');
  return buffer;
}

/** Accept only the local address schema; supplied extra fields are never persisted. */
export function validateAddressDraft(value: unknown): AddressDraft {
  if (!object(value)) fail('收货地址格式无效');
  const result: AddressDraft = {
    label: field(value.label, '地址标签', 80),
    recipient: field(value.recipient, '收货人', 60, true),
    phone: field(value.phone, '手机号', 20, true),
    province: field(value.province, '省份', 80, true),
    city: field(value.city, '城市', 80, true),
    district: field(value.district, '区县', 80, true),
    town: field(value.town, '街道或乡镇', 80),
    detail: field(value.detail, '详细地址', 500, true),
    postalCode: field(value.postalCode, '邮政编码', 6),
    provinceId: field(value.provinceId, '省份标识', 64),
    cityId: field(value.cityId, '城市标识', 64),
    districtId: field(value.districtId, '区县标识', 64),
    townId: field(value.townId, '街道标识', 64),
  };
  if (!/^1[3-9]\d{9}$/.test(result.phone)) fail('请填写有效的 11 位中国大陆手机号');
  if (result.postalCode && !/^\d{6}$/.test(result.postalCode)) fail('邮政编码须为 6 位数字');
  for (const key of ['provinceId', 'cityId', 'districtId', 'townId'] as const) {
    if (result[key] && !/^[a-zA-Z0-9_-]+$/.test(result[key])) fail('地区标识格式无效');
  }
  return result;
}

export function validateAddresses(value: unknown): LocalAddress[] {
  if (!Array.isArray(value) || value.length > MAX_ADDRESSES) fail('收货地址列表格式无效或数量过多');
  const ids = new Set<string>();
  const result = value.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !ADDRESS_ID.test(item.id) || ids.has(item.id)) fail('地址标识无效或重复');
    ids.add(item.id);
    if (typeof item.isDefault !== 'boolean') fail('默认地址标记格式无效');
    const createdAt = date(item.createdAt);
    const updatedAt = date(item.updatedAt);
    if (updatedAt < createdAt) fail('地址更新时间早于创建时间');
    return { ...validateAddressDraft(item), id: item.id, isDefault: item.isDefault, createdAt, updatedAt };
  });
  if (result.length && result.filter(item => item.isDefault).length !== 1) fail('收货地址必须有且仅有一个默认地址');
  return result;
}

/** A standalone local address book. This class never calls or writes to the official website. */
export class AddressVault {
  private addresses: LocalAddress[];
  readonly filePath: string;

  private readonly repository: AddressRepository;
  constructor(private readonly options: AddressVaultOptions) {
    this.repository = options.repository ?? new LegacyAddressRepository(options);
    this.filePath = this.repository.filePath;
    this.addresses = validateAddresses(this.repository.loadAddresses());
  }

  list(): LocalAddress[] { return structuredClone(this.addresses); }
  refresh(): LocalAddress[] {
    this.addresses = validateAddresses(this.repository.loadAddresses());
    return this.list();
  }

  save(value: AddressDraft, id?: string): LocalAddress {
    const draft = validateAddressDraft(value);
    const existing = id === undefined ? undefined : this.addresses.find(item => item.id === id);
    if (id !== undefined && !existing) fail('收货地址不存在');
    if (!existing && this.addresses.length >= MAX_ADDRESSES) fail('收货地址数量已达上限');
    const timestamp = this.timestamp();
    const address: LocalAddress = {
      ...draft, id: existing?.id ?? randomUUID(), isDefault: existing?.isDefault ?? this.addresses.length === 0,
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    const next = existing ? this.addresses.map(item => item.id === id ? address : item) : [...this.addresses, address];
    this.commit(next);
    return structuredClone(address);
  }

  setDefault(id: string): LocalAddress[] {
    const chosen = this.addresses.find(item => item.id === id);
    if (!chosen) fail('收货地址不存在');
    if (chosen.isDefault) return this.list();
    const timestamp = this.timestamp();
    const next = this.addresses.map(item => {
      const isDefault = item.id === id;
      return item.isDefault === isDefault ? item : { ...item, isDefault, updatedAt: timestamp };
    });
    this.commit(next);
    return this.list();
  }

  remove(id: string): LocalAddress[] {
    const existing = this.addresses.find(item => item.id === id);
    if (!existing) fail('收货地址不存在');
    const next = this.addresses.filter(item => item.id !== id);
    if (existing.isDefault && next.length) next[0] = { ...next[0], isDefault: true, updatedAt: this.timestamp() };
    this.commit(next);
    return this.list();
  }

  /** Restore addresses already protected by the application's encrypted backup. */
  replace(value: unknown): LocalAddress[] {
    const next = validateAddresses(value);
    this.commit(next);
    return this.list();
  }

  /** Password encryption makes an address backup portable without exporting an OS encryption key. */
  exportBackup(password: string): string {
    passphrase(password);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(BACKUP_AAD);
      const plaintext = JSON.stringify({ format: 'guanaitong-addresses', version: 1, addresses: this.addresses });
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return JSON.stringify({
        format: 'guanaitong-addresses-backup', version: 1, kdf: 'scrypt', cipher: 'aes-256-gcm',
        salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
      }, null, 2);
    } finally { key.fill(0); }
  }

  decodeBackup(contents: string, password: string): LocalAddress[] {
    passphrase(password);
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_BACKUP_BYTES) fail('地址备份文件过大或格式无效');
    let decoded: unknown;
    try { decoded = JSON.parse(contents); } catch { fail('地址备份文件不是有效 JSON'); }
    if (!object(decoded) || decoded.format !== 'guanaitong-addresses-backup' || decoded.version !== 1 || decoded.kdf !== 'scrypt' || decoded.cipher !== 'aes-256-gcm') fail('地址备份格式或版本不受支持');
    const salt = encryptedField(decoded.salt);
    const iv = encryptedField(decoded.iv);
    const tag = encryptedField(decoded.tag);
    const data = encryptedField(decoded.data);
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !data.length || data.length > MAX_FILE_BYTES) fail('地址备份加密参数无效');
    const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(BACKUP_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch { fail('地址备份口令错误或文件已损坏，现有地址未改变'); }
    finally { key.fill(0); }
    let payload: unknown;
    try { payload = JSON.parse(plaintext); } catch { fail('地址备份内容格式无效，现有地址未改变'); }
    if (!object(payload) || payload.format !== 'guanaitong-addresses' || payload.version !== 1) fail('地址备份内容格式或版本无效');
    return validateAddresses(payload.addresses);
  }

  importBackup(contents: string, password: string): LocalAddress[] {
    return this.replace(this.decodeBackup(contents, password));
  }

  private timestamp(): string {
    const value = this.options.now?.() ?? new Date();
    return date(value instanceof Date ? value.toISOString() : value);
  }

  private commit(value: LocalAddress[]): void {
    const next = validateAddresses(value);
    this.repository.saveAddresses(next);
    this.addresses = next;
  }
}
