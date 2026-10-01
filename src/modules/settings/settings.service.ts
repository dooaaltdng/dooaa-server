import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Model } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { flattenValidationErrors } from '../../common/api/validation';
import type { AuthStaff } from '../../common/auth/principal';
import { PERMISSIONS, SUPERADMIN_ONLY, type Permission, type StaffRole } from '../../common/domain';
import { TtlCache } from '../../common/util/cache';
import { AuditService } from '../audit/audit.service';
import { SECTION_DTO } from './dto/settings.dto';
import { SettingsRecord } from './settings.schema';
import {
  defaultSettings,
  type PlatformSettings,
  type SettingsSection,
} from './settings.defaults';

const SECTION_LABEL: Record<SettingsSection, string> = {
  escrow: 'Escrow',
  disputes: 'Disputes',
  moderation: 'Moderation',
  marketplace: 'Marketplace',
  notifications: 'Notifications',
  roles: 'Roles & permissions',
  commerce: 'Checkout & payouts',
};

const RECORD_ID = 'platform';

/** Merges stored values over the defaults so a key added later always has a value. */
export function mergeSettings(stored: Partial<Record<SettingsSection, unknown>> | undefined): PlatformSettings {
  const defaults = defaultSettings();
  const out = { ...defaults } as Record<SettingsSection, unknown>;
  for (const key of Object.keys(defaults) as SettingsSection[]) {
    const value = stored?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(defaults[key] as object), ...(value as object) };
    }
  }
  return out as PlatformSettings;
}

/** Locks the superadmin row to everything and keeps the elevated verbs off every other row. */
export function normalizeRoles(value: Record<StaffRole, Permission[]>): Record<StaffRole, Permission[]> {
  const leaked = (['admin', 'moderator'] as const).flatMap((role) =>
    value[role].filter((permission) => SUPERADMIN_ONLY.includes(permission)).map((permission) => `${role}: ${permission}`),
  );
  if (leaked.length) {
    throw Errors.badRequest(
      `Force-release and reversal stay with superadmins. Remove ${leaked.join(', ')}.`,
      'SUPERADMIN_ONLY_PERMISSION',
    );
  }
  return {
    superadmin: [...PERMISSIONS],
    admin: [...new Set(value.admin)],
    moderator: [...new Set(value.moderator)],
  };
}

@Injectable()
export class SettingsService {
  private readonly cache = new TtlCache<PlatformSettings>(10_000, 1);

  constructor(
    @InjectModel(SettingsRecord.name) private readonly records: Model<SettingsRecord>,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<PlatformSettings> {
    return this.cache.wrap(RECORD_ID, async () => {
      const record = await this.records.findById(RECORD_ID).lean();
      return mergeSettings(record?.values as Partial<Record<SettingsSection, unknown>> | undefined);
    });
  }

  async section<K extends SettingsSection>(key: K): Promise<PlatformSettings[K]> {
    return (await this.get())[key];
  }

  async permissionsFor(role: StaffRole): Promise<Permission[]> {
    if (role === 'superadmin') return [...PERMISSIONS];
    const roles = await this.section('roles');
    return (roles[role] ?? []).filter((permission) => !SUPERADMIN_ONLY.includes(permission));
  }

  async can(role: StaffRole, permission: Permission): Promise<boolean> {
    return (await this.permissionsFor(role)).includes(permission);
  }

  /** Validates and replaces one section. Panes save a section at a time, never the whole. */
  async update<K extends SettingsSection>(key: K, value: unknown, actor: AuthStaff): Promise<PlatformSettings[K]> {
    const dto = SECTION_DTO[key];
    const instance = plainToInstance(dto as new () => object, value ?? {});
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const details = flattenValidationErrors(errors);
      throw Errors.badRequest(details[0]?.messages[0] ?? 'Those settings are not valid.', 'VALIDATION_FAILED', details);
    }

    let next = { ...(instance as object) } as PlatformSettings[K];
    if (key === 'roles') {
      if (actor.role !== 'superadmin') {
        throw Errors.forbidden('Only a superadmin can change what each role may do.', 'SUPERADMIN_REQUIRED');
      }
      next = normalizeRoles(next as PlatformSettings['roles']) as PlatformSettings[K];
    }

    const before = await this.section(key);
    await this.records.updateOne(
      { _id: RECORD_ID },
      { $set: { [`values.${key}`]: next, updatedBy: actor.id } },
      { upsert: true },
    );
    this.cache.clear();

    await this.audit.record(actor, {
      action: describeChange(key, before, next),
      target: SECTION_LABEL[key],
      targetType: 'settings',
      targetId: key,
      elevated: key === 'roles',
      meta: { before, after: next },
    });
    return next;
  }

  /** Restores every section to its default. Used by seeding and tests. */
  async reset(): Promise<void> {
    await this.records.deleteOne({ _id: RECORD_ID });
    this.cache.clear();
  }

  invalidate(): void {
    this.cache.clear();
  }

  /** What the storefront may read without signing in. */
  async publicView() {
    const settings = await this.get();
    return {
      escrow: {
        enabled: settings.escrow.enabled,
        feePercent: settings.escrow.feePercent,
        minimumFee: settings.escrow.minimumFee,
        autoReleaseDays: settings.escrow.autoReleaseDays,
      },
      commerce: {
        deliveryFee: settings.commerce.deliveryFee,
        escrowDeliveryFee: settings.commerce.escrowDeliveryFee,
        taxRate: settings.commerce.taxRate,
        minimumWithdrawal: settings.commerce.minimumWithdrawal,
        shipWithinHours: settings.commerce.shipWithinHours,
      },
      disputes: {
        responseHours: settings.disputes.responseHours,
        returnWindowDays: settings.disputes.returnWindowDays,
        nonDeliveryWindowDays: settings.disputes.nonDeliveryWindowDays,
        settlementDays: settings.disputes.settlementDays,
      },
      marketplace: {
        activeCategories: settings.marketplace.activeCategories,
        regions: settings.marketplace.regions,
      },
    };
  }
}

/** "Changed the escrow fee — 1% → 0.8%" reads better in the log than "Updated escrow". */
function describeChange<K extends SettingsSection>(key: K, before: PlatformSettings[K], after: PlatformSettings[K]): string {
  if (key === 'escrow') {
    const b = before as PlatformSettings['escrow'];
    const a = after as PlatformSettings['escrow'];
    if (b.enabled !== a.enabled) return a.enabled ? 'Switched escrow on' : 'Switched escrow off';
    if (b.feePercent !== a.feePercent) return `Changed the escrow fee (${b.feePercent}% → ${a.feePercent}%)`;
  }
  return `Updated ${SECTION_LABEL[key].toLowerCase()} settings`;
}
