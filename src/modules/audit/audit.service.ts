import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, or, type SQL } from 'drizzle-orm';
import type { AuthStaff } from '../../common/auth/principal';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { InjectDb, type Database } from '../../database/database';
import { auditLog } from '../../database/schema';
import { containsText } from '../../database/sql';

export type AuditActor = AuthStaff | { kind: 'system'; name?: string };

export type AuditRecordInput = {
  action: string;
  target: string;
  targetType?: string;
  targetId?: string;
  elevated?: boolean;
  meta?: Record<string, unknown>;
};

export type AuditView = { id: string; at: string; actor: string; actorRole?: string; action: string; target: string; targetType?: string; targetId?: string; elevated?: boolean };

type AuditRow = typeof auditLog.$inferSelect;

@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Database) {}

  async record(actor: AuditActor, input: AuditRecordInput): Promise<AuditView> {
    const [created] = await this.db
      .insert(auditLog)
      .values({
        actorId: actor.kind === 'staff' ? actor.id : null,
        actorName: actor.kind === 'staff' ? `${actor.firstName} ${actor.lastName}` : (actor.name ?? 'DOOAA System'),
        actorRole: actor.kind === 'staff' ? actor.role : 'system',
        action: input.action,
        target: input.target,
        targetType: input.targetType,
        targetId: input.targetId,
        elevated: input.elevated ?? false,
        meta: input.meta,
      })
      .returning();
    return this.toView(created);
  }

  async list(query: { page?: number; limit?: number; search?: string; actorId?: string; targetType?: string; targetId?: string }): Promise<Page<AuditView>> {
    const conditions: SQL[] = [];
    if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId));
    if (query.targetType) conditions.push(eq(auditLog.targetType, query.targetType));
    if (query.targetId) conditions.push(eq(auditLog.targetId, query.targetId));
    if (query.search?.trim()) {
      conditions.push(or(containsText(auditLog.action, query.search), containsText(auditLog.target, query.search), containsText(auditLog.actorName, query.search))!);
    }
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(auditLog).where(where);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .offset(window.skip)
      .limit(window.size);
    return toPage(
      rows.map((row) => this.toView(row)),
      total,
      window,
    );
  }

  private toView(row: AuditRow): AuditView {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      actor: row.actorName,
      actorRole: row.actorRole ?? undefined,
      action: row.action,
      target: row.target,
      targetType: row.targetType ?? undefined,
      targetId: row.targetId ?? undefined,
      ...(row.elevated ? { elevated: true } : {}),
    };
  }
}
