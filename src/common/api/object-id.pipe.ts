import { Injectable, PipeTransform } from '@nestjs/common';
import { isObjectId } from '../util/ids';
import { Errors } from './app-error';

/** Rejects malformed ids with a 404 before they reach a query. */
@Injectable()
export class ObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isObjectId(value)) throw Errors.notFound();
    return value;
  }
}
