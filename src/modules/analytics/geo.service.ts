import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Reader, type CityResponse } from 'maxmind';

/** Where a visit came from, as precise as the database knows. */
export type GeoPlace = {
  countryCode: string;
  country: string;
  city: string;
  region: string | null;
  lat: number;
  lng: number;
};

/**
 * IP → city for the dashboard's visit map, using DB-IP's free "IP to City
 * Lite" database (CC BY 4.0, https://db-ip.com). The file is downloaded by
 * the server itself into `.geo/` (git-ignored) on first boot and replaced
 * once it is more than a month old, since DB-IP republishes monthly and IP
 * ranges move between networks and places over time. Lookups happen in
 * memory; IPs are never stored or sent anywhere.
 *
 * Until the file is ready (first boot, download failed, tests) `lookup`
 * returns null and visits are simply counted without a place.
 */
const DIR = join(process.cwd(), '.geo');
const FILE = join(DIR, 'dbip-city-lite.mmdb');
const MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class GeoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GeoService.name);
  private reader: Reader<CityResponse> | null = null;
  private refreshing = false;

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Never hold up the boot: load what is on disk, refresh in the background.
    void this.prepare();
  }

  lookup(ip: string | undefined | null): GeoPlace | null {
    if (!this.reader || !ip) return null;
    const address = ip.replace(/^::ffff:/, '');
    let hit: CityResponse | null = null;
    try {
      hit = this.reader.get(address);
    } catch {
      return null; // not an IP address
    }
    const code = hit?.country?.iso_code;
    const lat = hit?.location?.latitude;
    const lng = hit?.location?.longitude;
    if (!hit || !code || typeof lat !== 'number' || typeof lng !== 'number') return null;
    const country = hit.country?.names?.en ?? code;
    return {
      countryCode: code,
      country,
      // "Lagos (Victoria Island Annex)" → "Lagos", so a city's districts count together.
      city: (hit.city?.names?.en ?? country).replace(/\s*\(.*\)\s*$/, '') || country,
      region: hit.subdivisions?.[0]?.names?.en ?? null,
      lat: Math.round(lat * 10_000) / 10_000,
      lng: Math.round(lng * 10_000) / 10_000,
    };
  }

  private async prepare(): Promise<void> {
    const age = await stat(FILE).then((info) => Date.now() - info.mtimeMs, () => Infinity);
    if (age !== Infinity) await this.load();
    if (age > MAX_AGE_MS) await this.refresh();
    // Check again daily so a long-running server picks up next month's file; sooner if there is none yet.
    setTimeout(() => void this.prepare(), this.reader ? 24 * 60 * 60 * 1000 : RETRY_MS).unref();
  }

  private async load(): Promise<void> {
    try {
      this.reader = new Reader<CityResponse>(await readFile(FILE));
      this.logger.log('City database loaded for visit locations');
    } catch (error) {
      this.logger.warn(`City database unreadable, visits will be counted without a place: ${(error as Error).message}`);
    }
  }

  /** Downloads this month's file (or last month's, early in the month) and swaps it in. */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const temp = `${FILE}.download`;
    try {
      await mkdir(DIR, { recursive: true });
      for (const month of candidateMonths(new Date())) {
        const url = `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;
        const response = await fetch(url);
        if (!response.ok || !response.body) continue;
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createGunzip(), createWriteStream(temp));
        await rename(temp, FILE);
        this.logger.log(`City database updated (DB-IP Lite ${month})`);
        await this.load();
        return;
      }
      this.logger.warn('City database download found no file; will retry later');
    } catch (error) {
      this.logger.warn(`City database download failed; will retry later: ${(error as Error).message}`);
      await rm(temp, { force: true });
    } finally {
      this.refreshing = false;
    }
  }
}

/** "2026-11" then "2026-10": the new month's file may not be published on the 1st. */
function candidateMonths(now: Date): string[] {
  const key = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return [key(now), key(previous)];
}
