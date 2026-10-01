import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Unit tests assert on behaviour, not log lines.
Logger.overrideLogger(false);
