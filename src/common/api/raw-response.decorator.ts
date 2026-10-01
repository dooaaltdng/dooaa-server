import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'api:raw-response';

/** Skips the `{ ok, data }` envelope — for webhooks, file streams and HTML pages. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
