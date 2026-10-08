export type CardStatus = 'pending' | 'active' | 'expired' | 'exhausted' | 'error';
export type { AddressDraft, LocalAddress } from '../../electron/addresses';
import type { AddressDraft, LocalAddress } from '../../electron/addresses';
import type { AppSummary, ProductQuery, ProductPage, OrderQuery, OrderPage, SyncTask, PriceHistory, UpdateInfo } from './operations';
export interface RegionOption { id: string; name: string; children: RegionOption[] | null; }
export interface OfficialAddress { id: string; draft: AddressDraft; isDefault: boolean; }
export interface AddressPublishResult { id: string; created: boolean; }
export interface Card {
  id: string; number: string; label: string; status: CardStatus; balance: number | null;
  balanceUnit: string; expiresAt: string | null; syncedAt: string | null;
  addedAt: string; archived: boolean; note: string; error: string | null;
  productCount: number; hasPassword: boolean;
  tags?: string[];
}
export interface ProductOffer {
  cardId: string; sourceId: string; price: number | null; priceUnit: string;
  stock: number | null; url: string; variant: string; syncedAt: string;
  categories?: string[];
}
export interface Product {
  id: string; name: string; brand: string; image: string; category: string;
  specification: string; offers: ProductOffer[]; mergeKey: string; favorite: boolean;
  categories?: string[];
}
export interface Order {
  id: string; cardId: string; sourceId: string; name: string;
  status: string; amount: number | null; createdAt: string; tracking: string; url: string;
}
export interface CartItem { id: string; productId: string; cardId: string; sourceId: string; quantity: number; }
export interface Activity { id: string; at: string; type: 'success' | 'warning' | 'info'; message: string; cardId?: string; }
export interface AppState {
  cards: Card[]; products: Product[]; orders: Order[]; cart: CartItem[]; activities: Activity[];
  settings: { autoArchive: boolean; maskNumbers: boolean; autoLogin: boolean; syncConcurrency?: number; expiryReminderDays?: number; updateFeed?: string }; version: number;
  summary?: AppSummary;
}
export interface AddCardInput { number: string; password: string; label?: string; }
export interface SyncResult { cardId: string; ok: boolean; message: string; cancelled?: boolean; }
export interface HubAPI {
  getViewState(): Promise<AppState>;
  queryProducts(query: ProductQuery): Promise<ProductPage>;
  getProduct(id: string): Promise<Product>;
  queryOrders(query: OrderQuery): Promise<OrderPage>;
  exportOrders(query: OrderQuery): Promise<boolean>;
  getSyncTasks(): Promise<SyncTask[]>;
  cancelSync(cardId?: string): Promise<void>;
  retryFailedSync(): Promise<SyncResult[]>;
  onSyncTasks(callback: (tasks: SyncTask[]) => void): () => void;
  getPriceHistory(cardId: string, sourceId: string): Promise<PriceHistory[]>;
  checkUpdates(): Promise<UpdateInfo>;
  openUpdate(): Promise<void>;
  getAddresses(): Promise<LocalAddress[]>;
  saveAddress(draft: AddressDraft, id?: string): Promise<LocalAddress>;
  setDefaultAddress(id: string): Promise<LocalAddress[]>;
  removeAddress(id: string): Promise<LocalAddress[]>;
  exportAddresses(passphrase: string): Promise<boolean>;
  importAddresses(passphrase: string): Promise<LocalAddress[] | null>;
  getAddressRegions(parentId?: string): Promise<RegionOption[]>;
  getOfficialAddresses(cardId: string): Promise<OfficialAddress[]>;
  publishAddress(cardId: string, localId: string, makeDefault: boolean): Promise<AddressPublishResult>;
  getState(): Promise<AppState>;
  addCards(cards: AddCardInput[]): Promise<AppState>;
  updateCard(id: string, patch: Partial<Pick<Card, 'label' | 'note' | 'archived' | 'tags'>>): Promise<AppState>;
  openCard(id: string, purpose?: 'login' | 'shop' | 'orders' | 'addresses'): Promise<void>;
  openProduct(productId: string, cardId: string, sourceId?: string): Promise<void>;
  syncCard(id: string): Promise<SyncResult>;
  syncAll(): Promise<SyncResult[]>;
  favoriteProduct(id: string): Promise<AppState>;
  mergeProducts(ids: string[]): Promise<AppState>;
  addToCart(productId: string, cardId: string, quantity: number, sourceId?: string): Promise<AppState>;
  updateCart(id: string, quantity: number): Promise<AppState>;
  checkout(cardId: string): Promise<void>;
  updateSettings(settings: Partial<AppState['settings']>): Promise<AppState>;
  exportData(passphrase: string): Promise<boolean>;
  importData(passphrase: string): Promise<AppState | null>;
  openDataFolder(): Promise<void>;
  exportDiagnostics(): Promise<boolean>;
  onState(callback: (state: AppState) => void): () => void;
}
