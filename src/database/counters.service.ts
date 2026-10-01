import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Counter } from './counter.schema';

@Injectable()
export class CountersService {
  constructor(@InjectModel(Counter.name) private readonly counters: Model<Counter>) {}

  /** The next number in a sequence, starting after `start`. Atomic across instances. */
  async next(name: string, start = 0): Promise<number> {
    await this.counters.updateOne({ _id: name }, { $setOnInsert: { seq: start } }, { upsert: true });
    const counter = await this.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { returnDocument: 'after' }).lean();
    return counter!.seq;
  }
}
