import { ALL_SCHEMAS } from './schemas';

/**
 * `@Prop({ type: Types.ObjectId })` silently becomes a Mixed path in
 * @nestjs/mongoose, so string ids stop being cast and lookups quietly miss.
 * Every `*Id` / `*Ids` field must be a real ObjectId path.
 */
/** Deliberately strings: external ids, slugs and group keys. */
const NOT_OBJECT_IDS = new Set(['actorId', 'targetId', 'invitedBy', 'updatedBy', 'checkoutId', 'providerTransactionId', 'providerRefundId', 'categoryId', 'conversationKey', 'authorId', 'visitorId']);

describe('schema structure', () => {
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    it(`${name}: id fields are ObjectIds`, () => {
      const offenders: string[] = [];
      schema.eachPath((path, type) => {
        const leaf = path.split('.').pop()!;
        if (leaf === '_id' || NOT_OBJECT_IDS.has(leaf)) return;
        if (/Id$/.test(leaf) && type.instance !== 'ObjectId') offenders.push(`${path} (${type.instance})`);
        if (/Ids$/.test(leaf)) {
          const caster = (type as unknown as { embeddedSchemaType?: { instance: string } }).embeddedSchemaType;
          if (type.instance !== 'Array' || caster?.instance !== 'ObjectId') offenders.push(`${path} (${type.instance})`);
        }
      });
      expect(offenders).toEqual([]);
    });
  }
});
