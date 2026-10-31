import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureFlag } from '../../modules/settings/settings.defaults';
import { SettingsService } from '../../modules/settings/settings.service';

const FEATURE_KEY = 'requiredFeature';

/** The route belongs to a feature the console can switch off (Features page); off, it answers 403 FEATURE_OFF. */
export const RequireFeature = (flag: FeatureFlag) => SetMetadata(FEATURE_KEY, flag);

/** Registered globally; routes without @RequireFeature pass straight through. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = this.reflector.getAllAndOverride<FeatureFlag | undefined>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (flag) await this.settings.requireFeature(flag);
    return true;
  }
}
