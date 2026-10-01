import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { toFailure } from '../../common/api/all-exceptions.filter';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser, Principal } from '../../common/auth/principal';
import { PrincipalService } from '../auth/principal.service';
import { TokenService } from '../auth/token.service';
import { ConversationsService } from '../conversations/conversations.service';
import { PRESENCE, PresenceRegistry } from '../staff/presence';
import { StaffService } from '../staff/staff.service';
import { Inject } from '@nestjs/common';
import { CLIENT_EVENTS, SERVER_EVENTS } from './realtime.events';
import { RealtimeService } from './realtime.service';

type Ack<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

function tokenOf(socket: Socket): string | undefined {
  const auth = socket.handshake.auth as { token?: string } | undefined;
  const header = socket.handshake.headers.authorization;
  const query = socket.handshake.query.token;
  if (auth?.token) return auth.token.replace(/^Bearer\s+/i, '');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (typeof query === 'string') return query;
  return undefined;
}

/**
 * Socket.IO namespace `/realtime`. Connect with `auth: { token }` (a user or
 * staff access token). Every reply is acknowledged with the same envelope
 * as the HTTP API.
 */
@WebSocketGateway({ namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server: Server;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalService,
    private readonly conversations: ConversationsService,
    private readonly staff: StaffService,
    @Inject(PRESENCE) private readonly presence: PresenceRegistry,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attach(server);
    // Authenticate in middleware so an unauthorised socket never connects.
    server.use(async (socket, next) => {
      try {
        socket.data.principal = await this.authenticate(tokenOf(socket));
        next();
      } catch (error) {
        const failure = toFailure(error);
        next(Object.assign(new Error(failure.body.error), { data: { code: failure.body.code } }));
      }
    });
  }

  private async authenticate(token: string | undefined): Promise<Principal> {
    if (!token) throw Errors.unauthorized();
    try {
      const payload = await this.tokens.verifyAccess('user', token);
      const user = await this.principals.user(payload.sub);
      if (!user || user.tokenVersion !== payload.ver || ['banned', 'closed', 'suspended'].includes(user.status)) throw Errors.unauthorized('Your session has ended.', 'SESSION_REVOKED');
      return user;
    } catch (userError) {
      if ((userError as { code?: string }).code === 'TOKEN_EXPIRED' || (userError as { code?: string }).code === 'SESSION_REVOKED') throw userError;
      const payload = await this.tokens.verifyAccess('staff', token);
      const member = await this.principals.staffMember(payload.sub);
      if (!member || member.tokenVersion !== payload.ver || member.status !== 'active') throw Errors.unauthorized('Your session has ended.', 'SESSION_REVOKED');
      return member;
    }
  }

  async handleConnection(socket: Socket): Promise<void> {
    const principal = socket.data.principal as Principal | undefined;
    if (!principal) {
      socket.disconnect(true);
      return;
    }
    if (principal.kind === 'user') {
      await socket.join(`user:${principal.id}`);
    } else {
      await socket.join([`staff:${principal.id}`, 'staff']);
      void this.staff.touch(principal.id).catch(() => undefined);
    }
    if (this.presence.connected(principal.id)) {
      this.server.to('staff').emit(SERVER_EVENTS.presence, { id: principal.id, kind: principal.kind, online: true });
    }
  }

  handleDisconnect(socket: Socket): void {
    const principal = socket.data.principal as Principal | undefined;
    if (!principal) return;
    if (this.presence.disconnected(principal.id)) {
      this.server.to('staff').emit(SERVER_EVENTS.presence, { id: principal.id, kind: principal.kind, online: false });
      if (principal.kind === 'staff') void this.staff.touch(principal.id).catch(() => undefined);
    }
  }

  private async reply<T>(work: () => Promise<T>): Promise<Ack<T>> {
    try {
      return { ok: true, data: await work() };
    } catch (error) {
      const failure = toFailure(error);
      if (failure.status >= 500) this.logger.error((error as Error).stack ?? String(error));
      return { ok: false, error: failure.body.error, code: failure.body.code };
    }
  }

  private user(socket: Socket): AuthUser {
    const principal = socket.data.principal as Principal;
    if (principal.kind !== 'user') throw Errors.forbidden('Sign in as a marketplace user for this.');
    return principal;
  }

  @SubscribeMessage(CLIENT_EVENTS.join)
  join(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    return this.reply(async () => {
      const principal = socket.data.principal as Principal;
      const id = String(body?.conversationId ?? '');
      const allowed = principal.kind === 'staff' || (await this.conversations.isParticipant(principal.id, id));
      if (!allowed) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
      await socket.join(`conversation:${id}`);
      return { joined: id };
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.leave)
  leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    return this.reply(async () => {
      await socket.leave(`conversation:${String(body?.conversationId ?? '')}`);
      return { left: String(body?.conversationId ?? '') };
    });
  }

  /** "Nelson is typing……" — relayed to the other people in the room, never stored. */
  @SubscribeMessage(CLIENT_EVENTS.typing)
  typing(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string; typing?: boolean }) {
    return this.reply(async () => {
      const user = this.user(socket);
      const id = String(body?.conversationId ?? '');
      if (!socket.rooms.has(`conversation:${id}`)) throw Errors.forbidden('Join the conversation first.', 'NOT_JOINED');
      this.realtime.toConversation(id, SERVER_EVENTS.typing, { conversationId: id, userId: user.id, name: user.firstName, typing: Boolean(body?.typing) }, socket.id);
      return { relayed: true };
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.send)
  send(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string; kind?: 'text' | 'image' | 'video' | 'file'; body?: string; mediaUrl?: string }) {
    return this.reply(async () => {
      const user = this.user(socket);
      if (!user.emailVerified) throw Errors.forbidden('Verify your email address first.', 'EMAIL_NOT_VERIFIED');
      if (typeof body?.body === 'string' && body.body.length > 2000) throw Errors.badRequest('That message is too long.', 'VALIDATION_FAILED');
      return this.conversations.send(user, String(body?.conversationId ?? ''), { kind: body?.kind, body: body?.body, mediaUrl: body?.mediaUrl });
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.read)
  read(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    return this.reply(async () => this.conversations.markRead(this.user(socket), String(body?.conversationId ?? '')));
  }

  /** Which of these people are online right now. */
  @SubscribeMessage(CLIENT_EVENTS.presence)
  presenceQuery(@MessageBody() body: { ids?: string[] }) {
    return this.reply(async () => Object.fromEntries((body?.ids ?? []).slice(0, 100).map((id) => [id, this.presence.isOnline(String(id))])));
  }

  /** Console: follow a dispute's thread live. */
  @SubscribeMessage(CLIENT_EVENTS.disputeJoin)
  disputeJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    return this.reply(async () => {
      const principal = socket.data.principal as AuthStaff | AuthUser;
      if (principal.kind !== 'staff') throw Errors.forbidden();
      await socket.join(`conversation:${String(body?.conversationId ?? '')}`);
      return { joined: String(body?.conversationId ?? '') };
    });
  }
}
