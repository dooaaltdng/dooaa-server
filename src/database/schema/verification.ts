import type { IdType, VerificationStatus } from '../../common/domain';
import { index, table } from '../database';
import type { VerificationBank, VerificationDocument } from './values';

/** One run of the five-step identity wizard, reviewed by a person in the console. */
export type VerificationRow = {
  id: string;
  userId: string;
  status: VerificationStatus;
  idType: IdType;
  documents: VerificationDocument[];
  livenessPassed: boolean;
  bank: VerificationBank | null;
  consents: boolean[];
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const verifications = table<VerificationRow>()('verifications', {
  key: 'id',
  defaults: () => ({ status: 'pending' as VerificationStatus, documents: [] as VerificationDocument[], consents: [] as boolean[] }),
  nullable: ['bank', 'reviewedBy', 'reviewedAt', 'rejectionReason'],
  indexes: [index('verifications_user_idx', { userId: 1, createdAt: -1 }), index('verifications_status_idx', { status: 1, submittedAt: -1 })],
});
