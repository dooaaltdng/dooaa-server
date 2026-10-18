import { Injectable } from '@nestjs/common';
import type { AuthStaff } from '../../common/auth/principal';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { InjectDb, containsText, type Database, type Where } from '../../database/database';
import { auditLog } from '../../database/schema';

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
    const created = await this.db.insert(auditLog, {
        actorId: actor.kind === 'staff' ? actor.id : null,
        actorName: actor.kind === 'staff' ? `${actor.firstName} ${actor.lastName}` : (actor.name ?? 'DOOAA System'),
        actorRole: actor.kind === 'staff' ? actor.role : 'system',
        action: input.action,
        target: input.target,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        elevated: input.elevated ?? false,
        meta: input.meta ?? null,
      });
    return this.toView(created);
  }

  async list(query: { page?: number; limit?: number; search?: string; actorId?: string; targetType?: string; targetId?: string }): Promise<Page<AuditView>> {
    const where: Where<AuditRow> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    if (query.search?.trim()) {
      where.$or = [{ action: containsText(query.search) }, { target: containsText(query.search) }, { actorName: containsText(query.search) }];
    }
    const total = await this.db.count(auditLog, where);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db.find(auditLog, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
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
