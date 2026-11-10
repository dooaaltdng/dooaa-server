import { Injectable } from '@nestjs/common';
import { dayKey } from '../../common/util/dates';
import { InjectDb, type Database } from '../../database/database';
import { SOCIAL_PLATFORMS, socialSnapshots, type SocialPlatform } from '../../database/schema';

const LABEL: Record<SocialPlatform, string> = { x: 'X', tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook' };

/** The last six Lagos months, oldest first, as YYYY-MM. */
function lastSixMonths(): string[] {
  const thisMonth = dayKey().slice(0, 7);
  const months: string[] = [];
  for (let back = 5; back >= 0; back--) {
    const d = new Date(`${thisMonth}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - back);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

const monthLabel = (key: string) => new Date(`${key}-15T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });

@Injectable()
export class SocialMetricsService {
  constructor(@InjectDb() private readonly db: Database) {}

  /**
   * Per platform: the latest reading (followers, handle, link, day) and the
   * follower count at the end of each of the last six months — the last
   * reading on or before that month's end, carried forward; null before the
   * first reading.
   */
  async overview() {
    const months = lastSixMonths();
    const rows = await this.db.find(socialSnapshots, {}, { sort: { day: 1 } });
    return SOCIAL_PLATFORMS.map((platform) => {
      const readings = rows.filter((row) => row.platform === platform);
      const latest = readings[readings.length - 1] ?? null;
      const monthly = months.map((month) => {
        let value: number | null = null;
        for (const row of readings) {
          if (row.day.slice(0, 7) <= month) value = row.followers;
          else break;
        }
        return { month, label: monthLabel(month), followers: value };
      });
      return {
        id: platform,
        label: LABEL[platform],
        followers: latest?.followers ?? null,
        handle: latest?.handle ?? '',
        link: latest?.link ?? '',
        updatedOn: latest?.day ?? null,
        monthly,
      };
    });
  }

  /** Today's reading for a platform; a second entry the same day replaces the first. */
  async record(platform: SocialPlatform, input: { followers: number; link: string; handle: string }, staffId: string) {
    const day = dayKey();
    await this.db.upsert(
      socialSnapshots,
      { platform, day },
      { followers: input.followers, link: input.link.trim(), handle: input.handle.trim(), recordedBy: staffId },
    );
    return (await this.overview()).find((entry) => entry.id === platform)!;
  }
}
