import { Injectable, PipeTransform } from '@nestjs/common';
import { isUuid } from '../util/uuid';
import { Errors } from './app-error';

/** Rejects malformed ids with a 404 before they reach a query: no such record can exist. */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw Errors.notFound();
    return value.toLowerCase();
  }
}
