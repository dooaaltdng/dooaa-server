import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type { MediaKind, MediaVisibility } from '../media.schema';
import type { DirectUploadTicket, InspectedObject, PutResult, StorageDriver, StoredObject } from './storage.driver';

export type CloudinaryOptions = { cloudName: string; apiKey: string; apiSecret: string; folder: string };
type ResourceType = 'image' | 'video' | 'raw';

/** Formats each kind may arrive in when uploaded directly. */
const ALLOWED_FORMATS: Record<MediaKind, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'],
  video: ['mp4', 'mov', 'webm'],
  file: ['pdf'],
};

const PRIVATE_LINK_TTL_SECONDS = 5 * 60;
const DIRECT_UPLOAD_TTL_SECONDS = 30 * 60;

export function resourceTypeFor(kindOrMime: MediaKind | string): ResourceType {
  if (kindOrMime === 'image' || kindOrMime.startsWith('image/')) return 'image';
  if (kindOrMime === 'video' || kindOrMime.startsWith('video/')) return 'video';
  return 'raw';
}

/**
 * Cloudinary, the upload destination.
 *
 * - Public objects use the "upload" delivery type and are served from the CDN.
 * - Private objects (identity documents) use the "authenticated" type and are
 *   only ever handed out as five-minute private download links.
 * - Raw files (PDFs) keep their extension in the public id, as Cloudinary
 *   requires; images and videos drop it and are delivered in any format.
 * - Videos get a poster frame derived on the CDN for chat bubbles.
 */
export class CloudinaryStorage implements StorageDriver {
  readonly name = 'cloudinary' as const;

  constructor(private readonly options: CloudinaryOptions) {
    cloudinary.config({
      cloud_name: options.cloudName,
      api_key: options.apiKey,
      api_secret: options.apiSecret,
      secure: true,
    });
  }

  publicId(key: string, resourceType: ResourceType): string {
    const path = `${this.options.folder}/${key}`;
    return resourceType === 'raw' ? path : path.replace(/\.[^./]+$/, '');
  }

  private deliveryType(visibility: MediaVisibility): 'upload' | 'authenticated' {
    return visibility === 'private' ? 'authenticated' : 'upload';
  }

  private posterUrl(publicId: string): string {
    return cloudinary.url(publicId, {
      resource_type: 'video',
      type: 'upload',
      format: 'jpg',
      secure: true,
      transformation: [{ start_offset: '0' }],
    });
  }

  put(key: string, body: Buffer, contentType: string, visibility: MediaVisibility): Promise<PutResult> {
    const resourceType = resourceTypeFor(contentType);
    const publicId = this.publicId(key, resourceType);
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: resourceType,
          type: this.deliveryType(visibility),
          overwrite: false,
          timeout: 120_000,
        },
        (error, result?: UploadApiResponse) => {
          if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'));
          if (visibility === 'private') return resolve({});
          resolve({
            url: result.secure_url,
            ...(resourceType === 'video' ? { posterUrl: this.posterUrl(publicId) } : {}),
          });
        },
      );
      stream.end(body);
    });
  }

  async get(key: string, visibility: MediaVisibility, contentType: string): Promise<StoredObject | null> {
    const resourceType = resourceTypeFor(contentType);
    const publicId = this.publicId(key, resourceType);
    if (visibility === 'private') {
      // Raw files carry their extension in the public id; images and videos are asked for in their own format.
      const format = resourceType === 'raw' ? '' : (key.split('.').pop() ?? '');
      return {
        redirect: cloudinary.utils.private_download_url(publicId, format, {
          resource_type: resourceType,
          type: 'authenticated',
          expires_at: Math.floor(Date.now() / 1000) + PRIVATE_LINK_TTL_SECONDS,
        }),
      };
    }
    return { redirect: cloudinary.url(publicId, { resource_type: resourceType, type: 'upload', secure: true }) };
  }

  async delete(key: string, visibility: MediaVisibility, contentType: string): Promise<void> {
    const resourceType = resourceTypeFor(contentType);
    await cloudinary.uploader.destroy(this.publicId(key, resourceType), {
      resource_type: resourceType,
      type: this.deliveryType(visibility),
      invalidate: true,
    });
  }

  /** Signs the fields for a browser-to-Cloudinary upload of exactly one object at `key`. */
  createDirectUpload(key: string, visibility: MediaVisibility, kind: MediaKind): DirectUploadTicket {
    const resourceType = resourceTypeFor(kind);
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = {
      public_id: this.publicId(key, resourceType),
      timestamp,
      type: this.deliveryType(visibility),
      allowed_formats: ALLOWED_FORMATS[kind].join(','),
      overwrite: 'false',
    };
    const signature = cloudinary.utils.api_sign_request(params, this.options.apiSecret);
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.options.cloudName}/${resourceType}/upload`,
      fields: { ...params, api_key: this.options.apiKey, signature },
    };
  }

  /** Confirms a direct upload landed and reports what Cloudinary actually stored. */
  async inspect(key: string, visibility: MediaVisibility, kind: MediaKind): Promise<InspectedObject | null> {
    const resourceType = resourceTypeFor(kind);
    const publicId = this.publicId(key, resourceType);
    try {
      const resource = await cloudinary.api.resource(publicId, { resource_type: resourceType, type: this.deliveryType(visibility) });
      const format = String(resource.format ?? key.split('.').pop() ?? '').toLowerCase();
      return {
        bytes: Number(resource.bytes ?? 0),
        format,
        ...(visibility === 'public' ? { url: resource.secure_url as string } : {}),
        ...(visibility === 'public' && resourceType === 'video' ? { posterUrl: this.posterUrl(publicId) } : {}),
      };
    } catch (error) {
      const status = (error as { error?: { http_code?: number } }).error?.http_code;
      if (status === 404) return null;
      throw error;
    }
  }
}

export const CLOUDINARY_ALLOWED_FORMATS = ALLOWED_FORMATS;
export const CLOUDINARY_DIRECT_UPLOAD_TTL_SECONDS = DIRECT_UPLOAD_TTL_SECONDS;
