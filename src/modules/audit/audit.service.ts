import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter } from 'mongoose';
import type { AuthStaff } from '../../common/auth/principal';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { containsRegex } from '../../common/util/text';
import { AuditEntry } from './audit.schema';

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

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditEntry.name) private readonly entries: Model<AuditEntry>) {}

  async record(actor: AuditActor, input: AuditRecordInput): Promise<AuditView> {
    const created = await this.entries.create({
      actorId: actor.kind === 'staff' ? actor.id : undefined,
      actorName: actor.kind === 'staff' ? `${actor.firstName} ${actor.lastName}` : (actor.name ?? 'DOOAA System'),
      actorRole: actor.kind === 'staff' ? actor.role : 'system',
      action: input.action,
      target: input.target,
      targetType: input.targetType,
      targetId: input.targetId,
      elevated: input.elevated ?? false,
      meta: input.meta,
    });
    return this.toView(created.toObject());
  }

  async list(query: { page?: number; limit?: number; search?: string; actorId?: string; targetType?: string; targetId?: string }): Promise<Page<AuditView>> {
    const filter: QueryFilter<AuditEntry> = {};
    if (query.actorId) filter.actorId = query.actorId;
    if (query.targetType) filter.targetType = query.targetType;
    if (query.targetId) filter.targetId = query.targetId;
    if (query.search?.trim()) {
      const pattern = containsRegex(query.search);
      filter.$or = [{ action: pattern }, { target: pattern }, { actorName: pattern }];
    }
    const total = await this.entries.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.entries.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean();
    return toPage(rows.map((row) => this.toView(row)), total, window);
  }

  private toView(row: AuditEntry & { _id: unknown; createdAt: Date }): AuditView {
    return {
      id: String(row._id),
      at: new Date(row.createdAt).toISOString(),
      actor: row.actorName,
      actorRole: row.actorRole,
      action: row.action,
      target: row.target,
      targetType: row.targetType,
      targetId: row.targetId,
      ...(row.elevated ? { elevated: true } : {}),
    };
  }
}
