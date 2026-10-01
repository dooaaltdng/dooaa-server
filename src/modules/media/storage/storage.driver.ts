import type { MediaKind, MediaVisibility } from '../media.schema';

export type StoredObject = { body: Buffer; contentType: string } | { redirect: string };

export type PutResult = { url?: string; posterUrl?: string };

/** What the browser needs to upload straight to the provider. */
export type DirectUploadTicket = {
  uploadUrl: string;
  /** Multipart fields to send alongside `file`, exactly as given. */
  fields: Record<string, string | number>;
};

/** What the provider says about an object uploaded directly. */
export type InspectedObject = { bytes: number; format: string; url?: string; posterUrl?: string };

/**
 * Where uploaded bytes live. Cloudinary is the destination in every real
 * environment; `local` is an opt-in for offline development and `memory`
 * serves the test suite.
 */
export interface StorageDriver {
  readonly name: 'cloudinary' | 'local' | 'memory';
  put(key: string, body: Buffer, contentType: string, visibility: MediaVisibility): Promise<PutResult>;
  /** Reads an object back (or a short-lived redirect) for the content route. */
  get(key: string, visibility: MediaVisibility, contentType: string): Promise<StoredObject | null>;
  delete(key: string, visibility: MediaVisibility, contentType: string): Promise<void>;
  /** Direct browser uploads — only drivers backed by a provider support them. */
  createDirectUpload?(key: string, visibility: MediaVisibility, kind: MediaKind): DirectUploadTicket;
  inspect?(key: string, visibility: MediaVisibility, kind: MediaKind): Promise<InspectedObject | null>;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
