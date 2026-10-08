import type { Card } from './types';

export const cardNumber = (card: Pick<Card, 'number'>, mask: boolean): string =>
  mask ? `${card.number.slice(0, 4)} •••• ${card.number.slice(-4)}` : card.number;
