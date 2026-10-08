import type { HubAPI } from './shared/types';
declare global { interface Window { hub?: HubAPI; } }
export {};
