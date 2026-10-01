import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { PRIVATE_MEDIA_PURPOSES, type MediaPurpose } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { Media, type MediaKind, type MediaVisibility } from './media.schema';
import { sniff } from './sniff';
import { CLOUDINARY_ALLOWED_FORMATS, CLOUDINARY_DIRECT_UPLOAD_TTL_SECONDS } from './storage/cloudinary.storage';
import { STORAGE_DRIVER, type DirectUploadTicket, type StorageDriver, type StoredObject } from './storage/storage.driver';

export type UploadedFile = { buffer: Buffer; originalname: string; size: number; mimetype?: string };
export type MediaOwner = { id: string; type: 'user' | 'staff' };

export type MediaView = {
  id: string;
  url: string;
  posterUrl: string | null;
  kind: MediaKind;
  name: string;
  size: number;
  mimeType: string;
  purpose: MediaPurpose;
  visibility: MediaVisibility;
  createdAt: string;
};

export type DirectUploadStart = {
  /** Hand this back to `confirm` once the browser has finished uploading. */
  ticket: string;
  upload: DirectUploadTicket;
  expiresAt: string;
};

/** Which kinds of file each purpose accepts. */
export const ALLOWED_KINDS: Record<MediaPurpose, MediaKind[]> = {
  product: ['image', 'video'],
  avatar: ['image'],
  kyc: ['image', 'file'],
  message: ['image', 'video', 'file'],
  evidence: ['image', 'video'],
  support: ['image', 'file'],
  meetup: ['image'],
  shipment: ['image', 'file'],
  content: ['image'],
};

const FORMAT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

const KIND_EXT: Record<MediaKind, string> = { image: '.jpg', video: '.mp4', file: '.pdf' };
const SIGNED_URL_TTL_SECONDS = 15 * 60;

type TicketPayload = {
  key: string;
  purpose: MediaPurpose;
  kind: MediaKind;
  visibility: MediaVisibility;
  ownerId: string;
  ownerType: 'user' | 'staff';
  name: string;
  exp: number;
};

function safeName(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '').trim().slice(0, 120);
  return cleaned || 'upload';
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectModel(Media.name) private readonly media: Model<Media>,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private limitMb(kind: MediaKind): number {
    if (kind === 'image') return this.config.storage.maxImageMb;
    if (kind === 'video') return this.config.storage.maxVideoMb;
    return this.config.storage.maxFileMb;
  }

  private assertKind(purpose: MediaPurpose, kind: MediaKind): void {
    if (!ALLOWED_KINDS[purpose].includes(kind)) {
      throw Errors.badRequest(`A ${kind === 'file' ? 'document' : kind} cannot be used here.`, 'UNSUPPORTED_FILE');
    }
  }

  private assertSize(kind: MediaKind, bytes: number): void {
    const limit = this.limitMb(kind);
    if (bytes > limit * 1024 * 1024) {
      throw Errors.badRequest(`That ${kind === 'file' ? 'document' : kind} is larger than ${limit}MB.`, 'FILE_TOO_LARGE');
    }
  }

  private newKey(purpose: MediaPurpose, ext: string): string {
    const now = new Date();
    return `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(12).toString('hex')}${ext}`;
  }

  private visibilityFor(purpose: MediaPurpose): MediaVisibility {
    return PRIVATE_MEDIA_PURPOSES.includes(purpose) ? 'private' : 'public';
  }

  /** Upload through the API: the bytes are sniffed, then stored with the driver (Cloudinary). */
  async upload(file: UploadedFile | undefined, purpose: MediaPurpose, owner: MediaOwner): Promise<MediaView> {
    if (!file?.buffer?.length) throw Errors.badRequest('Choose a file to upload.', 'FILE_REQUIRED');
    const detected = sniff(file.buffer);
    if (!detected) throw Errors.badRequest('That file type is not supported.', 'UNSUPPORTED_FILE');
    this.assertKind(purpose, detected.kind);
    this.assertSize(detected.kind, file.size);

    const visibility = this.visibilityFor(purpose);
    const storageKey = this.newKey(purpose, detected.ext);
    let stored: { url?: string; posterUrl?: string };
    try {
      stored = await this.storage.put(storageKey, file.buffer, detected.mime, visibility);
    } catch (error) {
      this.logger.error(`Storage upload failed: ${(error as Error).message}`);
      throw Errors.badGateway('We could not store that file. Please try again.', 'STORAGE_ERROR');
    }
    return this.record({
      owner,
      purpose,
      kind: detected.kind,
      name: file.originalname,
      mimeType: detected.mime,
      size: file.size,
      visibility,
      storageKey,
      url: stored.url,
      posterUrl: stored.posterUrl,
    });
  }

  private async record(input: {
    owner: MediaOwner;
    purpose: MediaPurpose;
    kind: MediaKind;
    name: string;
    mimeType: string;
    size: number;
    visibility: MediaVisibility;
    storageKey: string;
    url?: string;
    posterUrl?: string;
  }): Promise<MediaView> {
    const id = new Types.ObjectId();
    const created = await this.media.create({
      _id: id,
      ownerId: new Types.ObjectId(input.owner.id),
      ownerType: input.owner.type,
      purpose: input.purpose,
      kind: input.kind,
      name: safeName(input.name),
      mimeType: input.mimeType,
      size: input.size,
      visibility: input.visibility,
      storageKey: input.storageKey,
      provider: this.storage.name,
      // Drivers without a CDN serve public objects through the content route.
      url: input.visibility === 'public' ? (input.url ?? this.contentUrl(String(id))) : undefined,
      posterUrl: input.posterUrl,
    });
    return this.view(created.toObject() as Lean<Media>);
  }

  /**
   * Starts a browser-to-Cloudinary upload. The ticket pins the object key,
   * purpose and owner, so `confirm` can only ever register that one object
   * for that one account.
   */
  startDirectUpload(input: { purpose: MediaPurpose; kind: MediaKind; name: string; size: number }, owner: MediaOwner): DirectUploadStart {
    if (!this.storage.createDirectUpload) {
      throw Errors.badRequest('Direct uploads need Cloudinary. Upload through POST /media instead.', 'DIRECT_UPLOAD_UNAVAILABLE');
    }
    this.assertKind(input.purpose, input.kind);
    this.assertSize(input.kind, input.size);
    const visibility = this.visibilityFor(input.purpose);
    const ext = (input.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? KIND_EXT[input.kind]).toLowerCase();
    const key = this.newKey(input.purpose, input.kind === 'file' ? '.pdf' : ext);
    const exp = Math.floor(Date.now() / 1000) + CLOUDINARY_DIRECT_UPLOAD_TTL_SECONDS;
    const payload: TicketPayload = {
      key,
      purpose: input.purpose,
      kind: input.kind,
      visibility,
      ownerId: owner.id,
      ownerType: owner.type,
      name: safeName(input.name),
      exp,
    };
    return {
      ticket: this.signTicket(payload),
      upload: this.storage.createDirectUpload(key, visibility, input.kind),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Registers a finished direct upload after checking with Cloudinary what actually landed. */
  async confirmDirectUpload(ticket: string, owner: MediaOwner): Promise<MediaView> {
    const payload = this.readTicket(ticket);
    if (payload.ownerId !== owner.id || payload.ownerType !== owner.type) {
      throw Errors.forbidden('That upload belongs to someone else.', 'UPLOAD_TICKET_INVALID');
    }
    const existing = await this.media.findOne({ storageKey: payload.key }).lean<Lean<Media>>();
    if (existing) return this.view(existing);
    if (!this.storage.inspect) throw Errors.badRequest('Direct uploads need Cloudinary.', 'DIRECT_UPLOAD_UNAVAILABLE');

    const object = await this.storage.inspect(payload.key, payload.visibility, payload.kind);
    if (!object) throw Errors.badRequest('We could not find that upload. Try uploading again.', 'UPLOAD_NOT_FOUND');
    const format = object.format.toLowerCase();
    const mimeType = FORMAT_MIME[format];
    const formatOk = Boolean(mimeType) && CLOUDINARY_ALLOWED_FORMATS[payload.kind].includes(format);
    const sizeOk = object.bytes <= this.limitMb(payload.kind) * 1024 * 1024;
    if (!formatOk || !sizeOk) {
      await this.storage.delete(payload.key, payload.visibility, mimeType ?? `${payload.kind}/*`).catch(() => undefined);
      if (!formatOk) throw Errors.badRequest('That file type is not supported.', 'UNSUPPORTED_FILE');
      this.assertSize(payload.kind, object.bytes);
    }
    return this.record({
      owner,
      purpose: payload.purpose,
      kind: payload.kind,
      name: payload.name,
      mimeType,
      size: object.bytes,
      visibility: payload.visibility,
      storageKey: payload.key,
      url: object.url,
      posterUrl: object.posterUrl,
    });
  }

  private ticketSignature(body: string): string {
    return createHmac('sha256', this.config.storage.signingSecret).update(`upload:${body}`).digest('base64url');
  }

  private signTicket(payload: TicketPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.ticketSignature(body)}`;
  }

  private readTicket(ticket: string): TicketPayload {
    const [body, sig] = String(ticket ?? '').split('.');
    const expected = body ? Buffer.from(this.ticketSignature(body)) : Buffer.alloc(0);
    const actual = Buffer.from(sig ?? '');
    if (!body || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw Errors.badRequest('That upload ticket is not valid.', 'UPLOAD_TICKET_INVALID');
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TicketPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw Errors.badRequest('That upload ticket has expired. Start the upload again.', 'UPLOAD_TICKET_EXPIRED');
    }
    return payload;
  }

  private contentUrl(id: string): string {
    return `${this.config.appUrl}/api/v1/media/${id}/content`;
  }

  /** A link to a private file that works in an <img> for fifteen minutes. */
  signedUrl(id: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.contentUrl(id)}?expires=${expires}&sig=${this.signature(id, expires)}`;
  }

  private signature(id: string, expires: number): string {
    return createHmac('sha256', this.config.storage.signingSecret).update(`${id}:${expires}`).digest('base64url');
  }

  verifySignature(id: string, expires: number, sig: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.signature(id, expires));
    const actual = Buffer.from(sig ?? '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  view(row: Lean<Media>): MediaView {
    return {
      id: String(row._id),
      url: row.visibility === 'private' ? this.signedUrl(String(row._id)) : row.url!,
      posterUrl: row.posterUrl ?? null,
      kind: row.kind,
      name: row.name,
      size: row.size,
      mimeType: row.mimeType,
      purpose: row.purpose,
      visibility: row.visibility,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  async findById(id: string): Promise<Lean<Media> | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.media.findById(id).lean<Lean<Media>>();
  }

  /** Streams (or redirects to) a file for the content route. */
  async read(id: string, access: { expires?: number; sig?: string }): Promise<{ media: Lean<Media>; object: StoredObject }> {
    const media = await this.findById(id);
    if (!media) throw Errors.notFound();
    if (media.visibility === 'private' && !this.verifySignature(id, Number(access.expires), access.sig ?? '')) {
      throw Errors.forbidden('This link has expired.', 'LINK_EXPIRED');
    }
    const object = await this.storage.get(media.storageKey, media.visibility, media.mimeType);
    if (!object) throw Errors.notFound();
    return { media, object };
  }

  async remove(id: string, owner: MediaOwner): Promise<{ deleted: true }> {
    const media = await this.media.findOne({ _id: id, ownerId: owner.id }).lean<Lean<Media>>();
    if (!media) throw Errors.notFound();
    await this.storage.delete(media.storageKey, media.visibility, media.mimeType).catch((error) => {
      this.logger.warn(`Could not delete ${media.storageKey}: ${(error as Error).message}`);
    });
    await this.media.deleteOne({ _id: id });
    return { deleted: true };
  }

  /**
   * Checks that every URL is a file this owner uploaded for one of the given
   * purposes. URLs already attached to the record being edited may be kept.
   */
  async assertOwnedUrls(urls: string[], owner: MediaOwner, purposes: MediaPurpose[], keep: string[] = []): Promise<void> {
    const fresh = [...new Set(urls.filter((url) => !keep.includes(url)))];
    if (!fresh.length) return;
    const found = await this.media
      .find({ url: { $in: fresh }, ownerId: new Types.ObjectId(owner.id), purpose: { $in: purposes } })
      .select('url')
      .lean();
    const known = new Set(found.map((row) => row.url));
    const missing = fresh.filter((url) => !known.has(url));
    if (missing.length) {
      throw Errors.badRequest('Upload each file through the media endpoint before attaching it.', 'MEDIA_NOT_FOUND', { missing });
    }
  }

  /** Looks up public media by URL (for message attachments: name, size, poster). */
  async byUrl(url: string): Promise<Lean<Media> | null> {
    return this.media.findOne({ url }).lean<Lean<Media>>();
  }

  /** Resolves private media ids (KYC documents) owned by the user. */
  async ownedByIds(ids: string[], owner: MediaOwner, purpose: MediaPurpose): Promise<Lean<Media>[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length !== ids.length) throw Errors.badRequest('Upload each document first.', 'MEDIA_NOT_FOUND');
    const rows = await this.media
      .find({ _id: { $in: valid }, ownerId: new Types.ObjectId(owner.id), purpose })
      .lean<Lean<Media>[]>();
    if (rows.length !== new Set(valid).size) throw Errors.badRequest('Upload each document first.', 'MEDIA_NOT_FOUND');
    return rows;
  }
}
