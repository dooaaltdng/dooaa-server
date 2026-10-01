import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { BANK_VERIFICATION_METHODS, ID_TYPES, type BankVerificationMethod, type IdType } from '../../common/domain';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

export const VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

@Schema({ _id: false })
export class VerificationDocument {
  @Prop({ type: String, enum: ['id-front', 'id-back', 'selfie'], required: true }) kind: 'id-front' | 'id-back' | 'selfie';
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) mediaId: Types.ObjectId;
  @Prop({ required: true }) uploadedAt: Date;
}
const VerificationDocumentSchema = SchemaFactory.createForClass(VerificationDocument);

@Schema({ _id: false })
export class VerificationBank {
  @Prop({ type: String, enum: BANK_VERIFICATION_METHODS, required: true }) method: BankVerificationMethod;
  @Prop({ required: true }) bankName: string;
  @Prop({ required: true }) bankCode: string;
  @Prop({ required: true }) last4: string;
  @Prop({ required: true }) accountName: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) payoutAccountId?: Types.ObjectId;
}
const VerificationBankSchema = SchemaFactory.createForClass(VerificationBank);

/** One run of the five-step identity wizard, reviewed by a person in the console. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'verifications' })
export class Verification {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: String, enum: VERIFICATION_STATUSES, default: 'pending' }) status: VerificationStatus;
  @Prop({ type: String, enum: ID_TYPES, required: true }) idType: IdType;
  @Prop({ type: [VerificationDocumentSchema], default: [] }) documents: VerificationDocument[];
  @Prop({ required: true }) livenessPassed: boolean;
  @Prop({ type: VerificationBankSchema }) bank?: VerificationBank;
  @Prop({ type: [Boolean], default: [] }) consents: boolean[];
  @Prop({ required: true }) submittedAt: Date;
  @Prop() reviewedBy?: string;
  @Prop() reviewedAt?: Date;
  @Prop() rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type VerificationRecordDocument = HydratedDocument<Verification>;
export const VerificationSchema = SchemaFactory.createForClass(Verification);
VerificationSchema.index({ userId: 1, createdAt: -1 });
VerificationSchema.index({ status: 1, submittedAt: -1 });
