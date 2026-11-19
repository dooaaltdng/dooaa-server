import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import { dayKey } from '../../common/util/dates';
import { isUuid } from '../../common/util/uuid';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { blogArticles, blogViews } from '../../database/schema';
import { GeoService } from '../analytics/geo.service';
import { classifyTraffic } from '../analytics/traffic';
import { BlogService } from './blog.service';

export type ViewOrigin = { referrer?: string; utmSource?: string; utmMedium?: string; userAgent?: string };

/** A reload (or a back-and-forth) within this window is the same read. */
const SAME_READ_MS = 30 * 60_000;
/** A read beacon can report at most this long; a tab left open overnight is not a four-hour read. */
const MAX_READ_SECONDS = 60 * 60;

/** The blog-only source for moving between the storefront's own pages. */
export const INTERNAL_SOURCE = 'internal';

/**
 * Who reads the blog and how: page views with their source and rough
 * location, and how long each read lasted.
 */
@Injectable()
export class BlogAudienceService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly blog: BlogService,
    private readonly geo: GeoService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private ownHosts(): string[] {
    const hosts = ['localhost', '127.0.0.1'];
    try {
      hosts.push(new URL(this.config.platformUrl).hostname.replace(/^www\./, ''));
    } catch {
      // A bad PLATFORM_URL is caught at boot.
    }
    return hosts;
  }

  /** Where a read came from: another page of DOOAA, else the same sources as site visits. */
  sourceOf(origin: ViewOrigin): string {
    if (!origin.utmSource && origin.referrer) {
      try {
        const host = new URL(origin.referrer).hostname.toLowerCase().replace(/^www\./, '');
        if (this.ownHosts().includes(host)) return INTERNAL_SOURCE;
      } catch {
        // Not a URL: let the classifier decide.
      }
    }
    return classifyTraffic({ ...origin, ownHosts: this.ownHosts() });
  }

  /* --- Views ------------------------------------------------------------- */

  /**
   * Counts a read of a live article. The same browser reading the same
   * article again within half an hour is the same read; the answer carries
   * the read's id for the beacon that reports how long it lasted.
   */
  async recordView(slug: string, visitorId: string, ip: string | undefined, origin: ViewOrigin, userId?: string): Promise<{ viewId: string; counted: boolean }> {
    const { row } = await this.blog.liveBySlug(slug);
    const recent = await this.db.findOne(
      blogViews,
      { articleId: row.id, visitorId, createdAt: { $gte: new Date(Date.now() - SAME_READ_MS) } },
      { sort: { createdAt: -1 } },
    );
    if (recent) return { viewId: recent.id, counted: false };
    const place = this.geo.lookup(ip);
    const view = await this.db.insert(blogViews, {
      articleId: row.id,
      visitorId,
      userId: userId ?? null,
      day: dayKey(),
      source: this.sourceOf(origin),
      countryCode: place?.countryCode ?? null,
      country: place?.country ?? null,
      region: place?.region ?? null,
      city: place?.city ?? null,
      seconds: null,
    });
    await this.db.update(blogArticles, { id: row.id }, { $inc: { views: 1 } });
    return { viewId: view.id, counted: true };
  }

  /** The read beacon: the longest time reported wins, and reaching the end sticks. */
  async recordRead(viewId: string, input: { seconds?: unknown; completed?: unknown }): Promise<{ recorded: boolean }> {
    if (!isUuid(viewId)) return { recorded: false };
    const seconds = Math.round(Number(input.seconds));
    if (!Number.isFinite(seconds) || seconds < 0) throw Errors.badRequest('Seconds must be a number.', 'INVALID_READ');
    const capped = Math.min(seconds, MAX_READ_SECONDS);
    const view = await this.db.findOne(blogViews, { id: viewId });
    if (!view) return { recorded: false };
    await this.db.update(
      blogViews,
      { id: view.id },
      { seconds: Math.max(view.seconds ?? 0, capped), completed: view.completed || input.completed === true },
    );
    return { recorded: true };
  }
}
