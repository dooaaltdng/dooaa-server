import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';

@Injectable()
export class PasswordService {
  /** Compared against when an account does not exist, so timing does not reveal which emails are registered. */
  private dummyHash: string | null = null;

  constructor(@InjectConfig() private readonly config: AppConfig) {}

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.config.auth.bcryptRounds);
  }

  async verify(password: string, hash: string | undefined | null): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= await bcrypt.hash('dooaa-timing-equaliser', this.config.auth.bcryptRounds);
      await bcrypt.compare(password, this.dummyHash);
      return false;
    }
    return bcrypt.compare(password, hash);
  }
}
