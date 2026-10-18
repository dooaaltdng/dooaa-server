import { Global, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, assertConfig, loadConfig } from './configuration';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => {
        const config = loadConfig();
        assertConfig(config);
        return config;
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}

/** Injects the typed {@link AppConfig}. */
export const InjectConfig = () => Inject(APP_CONFIG);
