import OAuth2Repository from '../db/repositories/OAuth2Repository';
import { Logger } from 'winston';
import TokenService from '../oauth/TokenService';
import { OAuth2ClientEntity } from '../api/types/entities/OAuth2ClientEntity';
import UserManager from './UserManager';
import { OAuth2ClientRaw, OAuth2Token, OAuth2RefreshTokenCheckResult } from '../db/types/OAuth2';

const accessToktenTtlSeconds = 3600 * 24 * 7;
const authorizationCodeTtlSeconds = 300;

export default class OAuth2Manager {
  private oauthRepository: OAuth2Repository;
  private userManager: UserManager;
  private logger: Logger;
  private revokedTokensCache;

  constructor(oauthRepository: OAuth2Repository, userManager: UserManager, logger: Logger) {
    this.oauthRepository = oauthRepository;
    this.userManager = userManager;
    this.logger = logger;
    this.revokedTokensCache = new OAuth2RevokedTokensCache(this.logger);
    this.warmUpCache();
  }

  warmUpCache() {
    this.oauthRepository.getRevokedTokens().then((tokens) => {
      if (!tokens) {
        return;
      }
      tokens.forEach((token) => {
        this.revokedTokensCache.revoke(token.access_token_hash);
        this.revokedTokensCache.revoke(token.refresh_token_hash);
      });
    });
  }

  async registerClient(name: string, description: string, logoUrl: string, initialAuthorizationUrl: string, redirectUrls: string, userId: number, isPublic: boolean): Promise<OAuth2ClientRaw> {
    try {
      const clientId = TokenService.generateClientId();
      const clientSecret = TokenService.generateClientSecret();
      const clientSecretHash = TokenService.hashString(clientSecret);
      const result: OAuth2ClientRaw = await this.oauthRepository.createClient(name, description, logoUrl, initialAuthorizationUrl, clientId, clientSecretHash, redirectUrls, userId, isPublic);
      result.client_secret_original = clientSecret;
      return result;
    } catch (error) {
      this.logger.error('Error registering OAuth client', { error });
      throw error;
    }
  }

  async listClients(userId: number): Promise<OAuth2ClientEntity[]> {
    try {
      const clients = await this.oauthRepository.getClients(userId);
      console.log()
      return await Promise.all(clients.map(async (client) => {
        const author = await this.userManager.getById(client.user_id);
        return {
          id: client.id,
          name: client.name,
          description: client.description,
          clientId: client.client_id,
          initialAuthorizationUrl: client.initial_authorization_url,
          redirectUrls: client.redirect_urls,
          grants: client.grants,
          userId: client.user_id,
          logoUrl: client.logo_url,
          author,
          isAuthorized: !!client.is_authorized,
          isMy: !!client.is_my,
          isPublic: !!client.is_public
        } as OAuth2ClientEntity;
      }));
    } catch (error) {
      this.logger.error('Error listing OAuth clients', { error });
      throw error;
    }
  }

  async getClientByClientId(clientId: string, includeSecret = false): Promise<OAuth2ClientEntity | undefined> {
    try {
      const client = await this.oauthRepository.getClientByClientId(clientId);
      if (!client) {
        return undefined;
      }
      const author = await this.userManager.getById(client.user_id);
      if (!author) {
        return undefined;
      }
      return {
        id: client.id,
        name: client.name,
        description: client.description,
        clientId: client.client_id,
        ...(includeSecret ? { clientSecretHash: client.client_secret_hash } : {}),
        initialAuthorizationUrl: client.initial_authorization_url,
        redirectUrls: client.redirect_urls,
        grants: client.grants,
        userId: client.user_id,
        logoUrl: client.logo_url,
        author
      } as OAuth2ClientEntity;
    } catch (error) {
      this.logger.error('Error getting OAuth client by client ID', { error });
      throw error;
    }
  }

  async authorizeClientAndGetAuthorizationCode(client: OAuth2ClientEntity, userId: number, scope: string, redirectUrl: string): Promise<string | undefined> {
    try {
      const authorizationCode = TokenService.generateAuthorizationCode(authorizationCodeTtlSeconds);
      if (await this.oauthRepository.authorizeClient(client.id, userId, scope, redirectUrl, authorizationCode.code, authorizationCode.expiresAt)) {
        return authorizationCode.code;
      }
      return;
    } catch (error) {
      this.logger.error('Error authorizing OAuth client', { error });
      throw error;
    }
  }

  async generateTokenWithAuthorizationCode(client: OAuth2ClientEntity, grantType: string, code?: string, refreshToken?: string, nonce?: string): Promise<OAuth2Token> {
    const clientNumericId = client.id;
    if (!code) {
      throw new Error('Missing authorization code');
    }

    const authorizationCode = await this.oauthRepository.getAuthorizationCode(code);
    if (!authorizationCode) {
      throw new Error('Invalid authorization code');
    }

    if (authorizationCode.client_id !== client.id) {
      throw new Error('Invalid authorization code');
    }

    if (authorizationCode.expires_at < new Date()) {
      throw new Error('Authorization code expired');
    }

    if (
      authorizationCode.user_id !== authorizationCode.user_id ||
      authorizationCode.redirect_url !== authorizationCode.redirect_url
    ) {
      throw new Error('Invalid authorization code');
    }

    try {
      const user = await this.userManager.getById(authorizationCode.user_id);
      const nowTs = Math.floor(Date.now() / 1000);
      const accessTokenExpiresAtTs = nowTs + accessToktenTtlSeconds;
      const accessToken = TokenService.generateAccessToken(authorizationCode.user_id.toString(), user.username, client.clientId, authorizationCode.scope, accessTokenExpiresAtTs, nowTs, nowTs, nonce);
      const refreshToken = TokenService.generateRefreshToken();
      const accessTokenHash = TokenService.hashString(accessToken);
      const refreshTokenHash = TokenService.hashString(refreshToken);
      await this.oauthRepository.createToken(clientNumericId, authorizationCode.user_id, accessTokenHash, new Date(accessTokenExpiresAtTs * 1000), refreshTokenHash, authorizationCode.scope);
      return {
        access_token: accessToken,
        expires_in: accessToktenTtlSeconds,
        token_type: 'Bearer',
        refresh_token: refreshToken
      } as OAuth2Token;
    } catch (error) {
      this.logger.error('Error generating OAuth token', { error });
      throw error;
    }
  }

  async generateTokenWithRefreshToken(refreshTokenHash: string): Promise<OAuth2Token> {
    const token = await this.oauthRepository.getTokenByRefreshTokenHash(refreshTokenHash);
    if (!token) {
      throw new Error('Invalid refresh token');
    }

    try {
      const client = await this.oauthRepository.getClientById(token.client_id);
      const user = await this.userManager.getById(token.user_id);
      const nowTs = Math.floor(Date.now() / 1000);
      const accessTokenExpiresAtTs = nowTs + accessToktenTtlSeconds;
      const accessToken = TokenService.generateAccessToken(token.user_id.toString(), user.username, client.client_id, token.scope, accessTokenExpiresAtTs, nowTs, nowTs);
      return {
        access_token: accessToken,
        expires_in: accessToktenTtlSeconds,
        token_type: 'Bearer',
        scope: token.scope
      } as OAuth2Token;

    } catch (error) {
      this.logger.error('Error generating OAuth token', { error });
      throw error;
    }
  }

  async regenerateClientSecret(id: number, authorId: number): Promise<string | undefined> {
    try {
      const clientSecret = TokenService.generateClientSecret();
      const clientSecretHash = TokenService.hashString(clientSecret);
      if (await this.oauthRepository.updateClientSecret(clientSecretHash, id, authorId)) {
        return clientSecret;
      }
      return null;
    } catch (error) {
      this.logger.error('Error regenerating OAuth client secret', { error });
      throw error;
    }
  }

  async deleteClient(id: number, byUserId: number): Promise<boolean> {
    const client = await this.oauthRepository.getClientById(id);
    if (!client) {
      this.logger.error('Error deleting OAuth client, no such client', { id });
      return false;
    }

    if (client.user_id !== byUserId) {
      this.logger.error('Error deleting OAuth client, not client owner initiated', { id, byUserId, authorId: client.user_id });
      return false;
    }

    const revokeTokensResult = await this.revokeClientTokens(id);
    if (!revokeTokensResult) {
      this.logger.error('Failed to revoke some of tokens when deleting a client', { id });
    }

    return await this.oauthRepository.deleteClient(id, byUserId);
  }

  async unAuthorizeClient(clientNumericId: number, userId: number): Promise<boolean> {
    try {
      const revokeTokensResult = await this.revokeClientTokens(clientNumericId, userId);
      if (!revokeTokensResult) {
        this.logger.error('Failed to revoke some of tokens when unauthorizing a client', { clientNumericId, userId });
      }
      return await this.oauthRepository.unAuthorizeClient(clientNumericId, userId);
    } catch (error) {
      this.logger.error('Error unauthorizing OAuth client', { error });
      throw error;
    }
  }

  async revokeClientTokens(id: number, userId?: number): Promise<boolean> {
    let tokens;
    try {
      if (userId) {
        tokens = await this.oauthRepository.getRawTokensByClientAndUserId(id, userId);
      } else {
        tokens = await this.oauthRepository.getRawTokensByClientId(id);
      }
      if (!tokens) {
        console.log(`No tokens found`);
        return true;
      }
      tokens.forEach((token) => {
        this.logger.info('Revoking token', { token });
        this.revokedTokensCache.revoke(token.access_token_hash);
        this.revokedTokensCache.revoke(token.refresh_token_hash);
      });
      return true;
    } catch (error) {
      this.logger.error('Error revoking OAuth client tokens', { error });
      throw error;
    }
  }

  async updateClientLogoUrl(id: number, userId: number, logoUrl: string): Promise<boolean> {
    return await this.oauthRepository.updateClientLogoUrl(id, userId, logoUrl);
  }

  isTokenRevoked(tokenHash: string): boolean {
    return this.revokedTokensCache.isRevoked(tokenHash);
  }

  async checkRefreshTokenHash(refreshTokenHash: string, clientId: string, clientSecretHash: string): Promise<OAuth2RefreshTokenCheckResult | undefined> {
    try {
      const tokenFromDb = await this.oauthRepository.getTokenByRefreshTokenHash(refreshTokenHash);
      if (!tokenFromDb) {
        console.log(`No token found by refresh token hash`);
        return;
      }
      const userId = tokenFromDb.user_id;
      const clientNumericId = tokenFromDb.client_id;

      const client = await this.oauthRepository.getClientById(tokenFromDb.client_id);
      if (!client || client.id !== clientNumericId || client.client_secret_hash !== clientSecretHash) {
        console.log(`client found by refresh token hash is not valid`);
        return;
      }
      const consent = await this.oauthRepository.getConsent(clientNumericId, userId);
      if (!consent) {
        console.log(`consent not found`);
        return;
      }

      return {
        userId: userId,
        scope: consent.scope
      };
    } catch (err) {
      this.logger.error('Error checking refresh token', { error: err});
      throw err;
    }
  }

  async changeClientVisibility(id: number, userId: number): Promise<boolean> {
    return await this.oauthRepository.changeClientVisibility(id, userId);
  }
}

class OAuth2RevokedTokensCache {
  revokedTokens?: string[] = [];
  logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  revoke(tokenHash: string) {
    this.revokedTokens.push(tokenHash);
  }

  isRevoked(tokenHash: string): boolean {
    return this.revokedTokens.includes(tokenHash);
  }
}