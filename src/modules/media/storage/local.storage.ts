import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { MediaVisibility } from '../media.schema';
import type { PutResult, StorageDriver, StoredObject } from './storage.driver';

/**
 * Disk storage for development and single-server deployments. Public files
 * are served statically under /uploads; private files sit outside that tree.
 */
export class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;

  constructor(
    private readonly root: string,
    private readonly appUrl: string,
  ) {}

  private path(key: string, visibility: MediaVisibility): string {
    const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    return join(this.root, visibility, safe);
  }

  async put(key: string, body: Buffer, _contentType: string, visibility: MediaVisibility): Promise<PutResult> {
    const file = this.path(key, visibility);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    return visibility === 'public' ? { url: `${this.appUrl}/uploads/${key}` } : {};
  }

  async get(key: string, visibility: MediaVisibility, contentType: string): Promise<StoredObject | null> {
    try {
      return { body: await readFile(this.path(key, visibility)), contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string, visibility: MediaVisibility): Promise<void> {
    await rm(this.path(key, visibility), { force: true });
  }
}
