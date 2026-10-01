import type { EscrowPhase, OrderStatus } from '../../common/domain';

/**
 * The order lifecycle, as pure rules. Fulfilment (status) and money (escrow
 * phase) move together, and the actions offered to each side follow from
 * where an order is.
 */

export type BuyerAction = 'cancel' | 'request-cancellation' | 'mark-received' | 'release' | 'dispute' | 'review';
export type SellerAction = 'confirm' | 'ship' | 'deliver' | 'cancel';

export type OrderState = {
  status: OrderStatus;
  escrowPhase: EscrowPhase | null;
  shipBy?: Date | null;
  cancellationRequested?: boolean;
  disputed?: boolean;
  reviewed?: boolean;
};

/** Phases from which the money can still go either way. */
export const HELD_PHASES: EscrowPhase[] = ['funded', 'shipped', 'inspection'];

export function buyerActions(state: OrderState, now: Date = new Date()): BuyerAction[] {
  const actions: BuyerAction[] = [];
  const overdue = Boolean(state.shipBy && state.shipBy.getTime() < now.getTime());
  if (state.status === 'pending' || (state.status === 'confirmed' && overdue)) actions.push('cancel');
  if (state.status === 'confirmed' && !overdue && !state.cancellationRequested) actions.push('request-cancellation');
  if (state.status === 'shipped' && state.escrowPhase === 'shipped') actions.push('mark-received');
  if ((state.status === 'shipped' || state.status === 'delivered') && (state.escrowPhase === 'shipped' || state.escrowPhase === 'inspection')) {
    actions.push('release');
    if (!state.disputed) actions.push('dispute');
  }
  if (state.escrowPhase === 'released' && !state.reviewed) actions.push('review');
  return actions;
}

export function sellerActions(state: OrderState): SellerAction[] {
  const actions: SellerAction[] = [];
  if (state.status === 'pending') actions.push('confirm');
  if (state.status === 'pending' || state.status === 'confirmed') actions.push('ship', 'cancel');
  if ((state.status === 'confirmed' || state.status === 'shipped') && state.escrowPhase !== 'disputed') actions.push('deliver');
  return actions;
}

/** Escrow transitions DOOAA may instruct, and from where. */
export const ESCROW_TRANSITIONS: Record<EscrowPhase, EscrowPhase[]> = {
  funded: ['shipped', 'inspection', 'released', 'refunded'],
  shipped: ['inspection', 'released', 'refunded', 'disputed'],
  inspection: ['released', 'refunded', 'disputed'],
  disputed: ['released', 'refunded', 'funded', 'shipped', 'inspection'],
  released: ['disputed'],
  refunded: [],
};

export function canMoveEscrow(from: EscrowPhase, to: EscrowPhase): boolean {
  return ESCROW_TRANSITIONS[from].includes(to);
}

/** Phases a given target can be reached from (for atomic, conditional updates). */
export function phasesLeadingTo(to: EscrowPhase): EscrowPhase[] {
  return (Object.keys(ESCROW_TRANSITIONS) as EscrowPhase[]).filter((from) => ESCROW_TRANSITIONS[from].includes(to));
}

/** "Held" / "Released" / "Refunded" — the seller's Escrow Payments tab. */
export function escrowStateLabel(phase: EscrowPhase | null | undefined): 'held' | 'released' | 'refunded' | 'unpaid' {
  if (!phase) return 'unpaid';
  if (phase === 'released') return 'released';
  if (phase === 'refunded') return 'refunded';
  return 'held';
}
