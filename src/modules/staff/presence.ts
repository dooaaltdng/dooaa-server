/**
 * Who is connected right now. The realtime gateway keeps it current; other
 * modules only read it. Kept as a tiny standalone registry so the staff and
 * messaging modules do not depend on the gateway.
 */
export class PresenceRegistry {
  private readonly counts = new Map<string, number>();

  connected(id: string): boolean {
    const next = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, next);
    return next === 1;
  }

  disconnected(id: string): boolean {
    const next = (this.counts.get(id) ?? 1) - 1;
    if (next <= 0) {
      this.counts.delete(id);
      return true;
    }
    this.counts.set(id, next);
    return false;
  }

  isOnline(id: string): boolean {
    return (this.counts.get(id) ?? 0) > 0;
  }
}

export const PRESENCE = Symbol('PRESENCE');
