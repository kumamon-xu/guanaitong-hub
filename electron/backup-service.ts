import type { LocalAddress } from './addresses';
import { AddressVault, validateAddresses } from './addresses';
import { HubStore, validatePortable } from './store';
import type { PortableData } from './persistence';
import { SqliteRepository } from './sqlite-repository';
import type { ManagementData } from '../src/shared/operations';
import { validateManagement } from './management-data';

export interface PreparedRestore {
  data: PortableData | null;
  addresses: LocalAddress[] | null;
  kind: 'unified' | 'cards' | 'addresses';
  exportedAt: string | null;
  management:ManagementData|null;
}
/** Preparing decrypts and validates without writing; applying replaces all included domains atomically. */
export class BackupService {
  constructor(private readonly database: SqliteRepository, private readonly store: HubStore, private readonly addresses: AddressVault) {}
  export(password: string): string { return this.store.exportBackup(password, this.addresses.list(),this.database.managementData()); }
  prepare(contents: string, password: string): PreparedRestore {
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 32 * 1024 * 1024) throw new Error('备份文件过大或格式无效');
    let envelope;
    try { envelope = JSON.parse(contents); } catch { throw new Error('备份文件不是有效 JSON'); }
    if (envelope?.format === 'guanaitong-addresses-backup') return { data: null, addresses: this.addresses.decodeBackup(contents, password), kind: 'addresses', exportedAt: null,management:null };
    const decoded = this.store.decodeBackup(contents, password);
    return { data: decoded.data, addresses: decoded.addresses, management:decoded.management,kind: decoded.addresses === null ? 'cards' : 'unified', exportedAt: decoded.exportedAt };
  }
  apply(prepared: PreparedRestore): void {
    if (!prepared.data && prepared.addresses === null) throw new Error('备份内容为空或无效');
    const data = prepared.data ? validatePortable(structuredClone(prepared.data)) : null;
    const book = prepared.addresses === null ? null : validateAddresses(prepared.addresses);
    const management=prepared.management&&data?validateManagement(prepared.management,new Set(data.state.cards.map(card=>card.id))):null;
    this.database.restore(data, book, management);
    if (data) this.store.refresh();
    if (book) this.addresses.refresh();
  }
}
