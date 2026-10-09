import type { AppState, Product, Order } from './types';
import type { PriceFilterValue } from './price-filter';
import type { TradeAttempt } from './trade';

export interface ProductQuery {
  page: number; pageSize: number; cardId: string; search: string; category: string;
  favoritesOnly: boolean; price: PriceFilterValue;
}
export interface ProductPage {
  items: Product[]; total: number; page: number; pageSize: number;
  categories: { name: string; count: number }[]; units: string[]; amounts: number[];
}
export interface OrderQuery {
  page: number; pageSize: number; cardId: string; search: string; status: string;
  from: string; to: string;
}
export interface OrderPage { items: Order[]; total: number; page: number; pageSize: number; statuses: string[]; }
export type SyncPhase = 'queued' | 'identity' | 'products' | 'orders' | 'categories' | 'commit' | 'complete';
export type SyncStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type FailureKind = 'login' | 'network' | 'timeout' | 'http' | 'schema' | 'identity' | 'storage' | 'cancelled' | 'unknown';
export interface SyncTask {
  id: string; batchId: string; cardId: string; status: SyncStatus; phase: SyncPhase;
  page: number; completed: number; total: number | null; message: string;
  errorKind: FailureKind | null; startedAt: string; finishedAt: string | null;
  endpoint?: string;
}
export interface PriceHistory { id: string; cardId: string; sourceId: string; at: string; price: number | null; unit: string; }
export interface ManagementData { priceHistory: PriceHistory[]; syncTasks: SyncTask[]; tradeAttempts?: TradeAttempt[]; }
export interface UpdateInfo {
  currentVersion: string; version: string; available: boolean; notes: string; url: string; publishedAt: string;
  status?: 'available' | 'current' | 'unpublished' | 'unsupported'; source?: 'github' | 'manifest';
  releaseUrl?: string; sha256?: string; size?: number; databaseVersion?: number;
}
export interface UpdateProgress { phase: 'downloading' | 'verifying' | 'backing-up' | 'ready'; downloaded: number; total: number | null; }
export interface PreparedUpdate { version: string; filePath: string; sha256: string; size: number; backupPath: string; }
export interface AppSummary { products: number; offers: number; orders: number; favorites: number; }
export const DEFAULT_PRODUCT_QUERY: ProductQuery = { page: 1, pageSize: 24, cardId: 'all', search: '', category: '全部分类', favoritesOnly: false, price: { amounts: [], unit: 'all', sort: 'default' } };
export const DEFAULT_ORDER_QUERY: OrderQuery = { page: 1, pageSize: 40, cardId: 'all', search: '', status: 'all', from: '', to: '' };
export function viewState(state: AppState): AppState {
  const ids = new Set([...state.products.slice(0, 4).map(item => item.id), ...state.cart.map(item => item.productId)]);
  return { ...state, products: state.products.filter(item => ids.has(item.id)), orders: [], summary: {
    products: state.products.length, offers: state.products.reduce((n, item) => n + item.offers.length, 0), orders: state.orders.length, favorites: state.products.filter(item => item.favorite).length,
  } };
}
