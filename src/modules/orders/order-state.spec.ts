import { buyerActions, canMoveEscrow, escrowStateLabel, phasesLeadingTo, sellerActions } from './order-state';

const now = new Date('2026-01-10T12:00:00Z');
const later = new Date('2026-01-12T12:00:00Z');
const earlier = new Date('2026-01-08T12:00:00Z');

describe('order state rules', () => {
  it('lets a buyer cancel only before the seller confirms (or once the ship-by date has passed)', () => {
    expect(buyerActions({ status: 'pending', escrowPhase: 'funded', shipBy: later }, now)).toEqual(['cancel']);
    expect(buyerActions({ status: 'confirmed', escrowPhase: 'funded', shipBy: later }, now)).toEqual(['request-cancellation']);
    expect(buyerActions({ status: 'confirmed', escrowPhase: 'funded', shipBy: earlier }, now)).toEqual(['cancel']);
    expect(buyerActions({ status: 'confirmed', escrowPhase: 'funded', shipBy: later, cancellationRequested: true }, now)).toEqual([]);
  });

  it('offers receipt, release and dispute once the item is on its way', () => {
    expect(buyerActions({ status: 'shipped', escrowPhase: 'shipped' }, now)).toEqual(['mark-received', 'release', 'dispute']);
    expect(buyerActions({ status: 'delivered', escrowPhase: 'inspection' }, now)).toEqual(['release', 'dispute']);
    expect(buyerActions({ status: 'delivered', escrowPhase: 'disputed', disputed: true }, now)).toEqual([]);
    // A dispute on a shipped order freezes everything the buyer could do.
    expect(buyerActions({ status: 'shipped', escrowPhase: 'disputed', disputed: true }, now)).toEqual([]);
  });

  it('offers a review after release, once', () => {
    expect(buyerActions({ status: 'delivered', escrowPhase: 'released' }, now)).toEqual(['review']);
    expect(buyerActions({ status: 'delivered', escrowPhase: 'released', reviewed: true }, now)).toEqual([]);
    expect(buyerActions({ status: 'cancelled', escrowPhase: 'refunded' }, now)).toEqual([]);
    expect(buyerActions({ status: 'awaiting-payment', escrowPhase: null }, now)).toEqual([]);
  });

  it('walks the seller through confirm, ship and deliver', () => {
    expect(sellerActions({ status: 'pending', escrowPhase: 'funded' })).toEqual(['confirm', 'ship', 'cancel']);
    expect(sellerActions({ status: 'confirmed', escrowPhase: 'funded' })).toEqual(['ship', 'cancel', 'deliver']);
    expect(sellerActions({ status: 'shipped', escrowPhase: 'shipped' })).toEqual(['deliver']);
    expect(sellerActions({ status: 'shipped', escrowPhase: 'disputed' })).toEqual([]);
    expect(sellerActions({ status: 'delivered', escrowPhase: 'inspection' })).toEqual([]);
  });

  it('only moves escrow along legal paths', () => {
    expect(canMoveEscrow('funded', 'released')).toBe(true);
    expect(canMoveEscrow('released', 'refunded')).toBe(false);
    expect(canMoveEscrow('refunded', 'released')).toBe(false);
    expect(canMoveEscrow('released', 'disputed')).toBe(true);
    expect(phasesLeadingTo('released').sort()).toEqual(['disputed', 'funded', 'inspection', 'shipped']);
    expect(phasesLeadingTo('refunded').sort()).toEqual(['disputed', 'funded', 'inspection', 'shipped']);
  });

  it('labels where the money is for the seller', () => {
    expect(escrowStateLabel('funded')).toBe('held');
    expect(escrowStateLabel('disputed')).toBe('held');
    expect(escrowStateLabel('released')).toBe('released');
    expect(escrowStateLabel('refunded')).toBe('refunded');
    expect(escrowStateLabel(null)).toBe('unpaid');
  });
});
