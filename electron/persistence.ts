import type { AppState, Card } from '../src/shared/types';
import type { LocalAddress } from './addresses';

export interface EncryptionOptions {
  directory: string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface Credential { number: string; password: string; }
export interface PortableData {
  state: AppState;
  credentials: Record<string, Credential>;
  manualMerges: Record<string, string>;
}
export interface DiskData {
  format: 'guanaitong-hub'; version: 1;
  state: Omit<AppState, 'cards'> & { cards: Omit<Card, 'number'>[] };
  credentials: Record<string, string>;
  manualMerges: Record<string, string>;
}
export interface HubRepository {
  readonly filePath: string;
  loadHub(): PortableData | null;
  saveHub(data: PortableData): void;
}
export interface AddressRepository {
  readonly filePath: string;
  loadAddresses(): LocalAddress[];
  saveAddresses(addresses: LocalAddress[]): void;
}
export interface SessionRepository {
  filePathForSession(id: string): string;
  loadSession(id: string): unknown | null;
  saveSession(id: string, encrypted: Buffer): void | Promise<void>;
}
