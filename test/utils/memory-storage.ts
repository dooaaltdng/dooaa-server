import type { MediaVisibility } from '../media.schema';
import type { PutResult, StorageDriver, StoredObject } from './storage.driver';

/** Keeps uploads in process memory; served through the API's content route. Tests only. */
export class MemoryStorage implements StorageDriver {
  readonly name = 'memory' as const;
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string, visibility: MediaVisibility): Promise<PutResult> {
    this.objects.set(`${visibility}/${key}`, { body, contentType });
    return {};
  }

  async get(key: string, visibility: MediaVisibility): Promise<StoredObject | null> {
    return this.objects.get(`${visibility}/${key}`) ?? null;
  }

  async delete(key: string, visibility: MediaVisibility): Promise<void> {
    this.objects.delete(`${visibility}/${key}`);
  }
}
