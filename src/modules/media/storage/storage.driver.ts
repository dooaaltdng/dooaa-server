import { type MediaKind, type MediaVisibility } from '../../../common/domain';

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
 * Where uploaded bytes live: Cloudinary in every environment. The test
 * suite substitutes an in-memory driver through dependency injection.
 */
export interface StorageDriver {
  /** Recorded on each upload, e.g. "cloudinary". */
  readonly name: string;
  put(key: string, body: Buffer, contentType: string, visibility: MediaVisibility): Promise<PutResult>;
  /** Reads an object back (or a short-lived redirect) for the content route. */
  get(key: string, visibility: MediaVisibility, contentType: string): Promise<StoredObject | null>;
  delete(key: string, visibility: MediaVisibility, contentType: string): Promise<void>;
  /** Direct browser uploads — only drivers backed by a provider support them. */
  createDirectUpload?(key: string, visibility: MediaVisibility, kind: MediaKind): DirectUploadTicket;
  inspect?(key: string, visibility: MediaVisibility, kind: MediaKind): Promise<InspectedObject | null>;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
