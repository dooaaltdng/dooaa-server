import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '../../common/domain';
import { defaultSettings } from './settings.defaults';
import { mergeSettings, normalizeRoles } from './settings.service';

describe('settings', () => {
  it('fills sections and keys missing from storage with defaults', () => {
    const merged = mergeSettings({ escrow: { feePercent: 0.8 } });
    expect(merged.escrow.feePercent).toBe(0.8);
    expect(merged.escrow.enabled).toBe(true);
    expect(merged.commerce).toEqual(defaultSettings().commerce);
    expect(mergeSettings(undefined)).toEqual(defaultSettings());
  });

  it('ignores corrupted section values', () => {
    expect(mergeSettings({ escrow: 'oops' as never }).escrow).toEqual(defaultSettings().escrow);
  });

  it('always gives superadmin every permission', () => {
    const roles = normalizeRoles({ superadmin: [], admin: ['users.ban'], moderator: [] });
    expect(roles.superadmin).toEqual([...PERMISSIONS]);
    expect(roles.admin).toEqual(['users.ban']);
  });

  it('refuses to hand the elevated escrow verbs to anyone else', () => {
    expect(() => normalizeRoles({ ...DEFAULT_ROLE_PERMISSIONS, admin: ['escrow.force'] })).toThrow(/superadmins/);
    expect(() => normalizeRoles({ ...DEFAULT_ROLE_PERMISSIONS, moderator: ['escrow.reverse'] })).toThrow();
  });

  it('de-duplicates permissions', () => {
    expect(normalizeRoles({ ...DEFAULT_ROLE_PERMISSIONS, moderator: ['users.suspend', 'users.suspend'] }).moderator).toEqual(['users.suspend']);
  });
});
