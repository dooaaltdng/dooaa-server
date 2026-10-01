import { Inject, Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PRESENCE, PresenceRegistry } from '../staff/presence';

/**
 * Pushes events to connected apps. Every user and staff member has a
 * private room; conversations have rooms for whoever has the thread open.
 * Safe to call before the gateway is up (events are simply dropped).
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  constructor(@Inject(PRESENCE) private readonly presence: PresenceRegistry) {}

  attach(server: Server): void {
    this.server = server;
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  toUsers(userIds: string[], event: string, payload: unknown): void {
    if (!this.server || !userIds.length) return;
    this.server.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  }

  toStaffMember(staffId: string, event: string, payload: unknown): void {
    this.server?.to(`staff:${staffId}`).emit(event, payload);
  }

  toAllStaff(event: string, payload: unknown): void {
    this.server?.to('staff').emit(event, payload);
  }

  toConversation(conversationId: string, event: string, payload: unknown, exceptSocketId?: string): void {
    if (!this.server) return;
    const room = this.server.to(`conversation:${conversationId}`);
    (exceptSocketId ? room.except(exceptSocketId) : room).emit(event, payload);
  }

  isOnline(id: string): boolean {
    return this.presence.isOnline(id);
  }
}
