import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FacebookOAuthProvider } from './oauth/facebook.provider';
import { GoogleOAuthProvider } from './oauth/google.provider';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthGrant, OAuthGrantSchema } from './oauth/oauth-grant.schema';
import { OAUTH_PROVIDER_REGISTRY, type OAuthProviderRegistry } from './oauth/oauth-provider';
import { OAuthService } from './oauth/oauth.service';
import { SandboxOAuthProvider } from './oauth/sandbox.provider';

@Module({
  imports: [JwtModule.register({}), UsersModule, MongooseModule.forFeature([{ name: OAuthGrant.name, schema: OAuthGrantSchema }])],
  controllers: [AuthController, OAuthController],
  providers: [
    AuthService,
    OAuthService,
    {
      provide: OAUTH_PROVIDER_REGISTRY,
      inject: [APP_CONFIG],
      useFactory: ({ oauth }: AppConfig): OAuthProviderRegistry =>
        oauth.driver === 'live'
          ? { google: new GoogleOAuthProvider(oauth.google), facebook: new FacebookOAuthProvider(oauth.facebook) }
          : { google: new SandboxOAuthProvider('google'), facebook: new SandboxOAuthProvider('facebook') },
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
