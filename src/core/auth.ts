import fetch from 'node-fetch';
import {
  AuthConfig,
  BearerAuthConfig,
  BasicAuthConfig,
  OAuth2ClientCredentialsConfig,
  RequestConfig
} from '../types';
import { VariableResolver } from './variables';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  rawResponse?: any;
}

export class AuthManager {
  private variableResolver: VariableResolver;
  private tokenCache: Map<string, TokenCache> = new Map();
  private oauth2RefreshBuffer: number = 60;

  constructor(variableResolver: VariableResolver) {
    this.variableResolver = variableResolver;
  }

  setVariableResolver(resolver: VariableResolver): void {
    this.variableResolver = resolver;
  }

  resolveAuthHeader(authConfig: AuthConfig | undefined): Record<string, string> {
    if (!authConfig || authConfig.type === 'none') {
      return {};
    }

    switch (authConfig.type) {
      case 'bearer':
        return this.resolveBearerAuth(authConfig);
      case 'basic':
        return this.resolveBasicAuth(authConfig);
      case 'oauth2_client_credentials':
        return this.resolveOAuth2ClientCredentials(authConfig);
      default:
        return {};
    }
  }

  async resolveAuthHeaderAsync(authConfig: AuthConfig | undefined): Promise<Record<string, string>> {
    if (!authConfig || authConfig.type === 'none') {
      return {};
    }

    switch (authConfig.type) {
      case 'bearer':
        return this.resolveBearerAuth(authConfig);
      case 'basic':
        return this.resolveBasicAuth(authConfig);
      case 'oauth2_client_credentials':
        return await this.resolveOAuth2ClientCredentialsAsync(authConfig);
      default:
        return {};
    }
  }

  private resolveBearerAuth(config: BearerAuthConfig): Record<string, string> {
    const resolvedToken = this.variableResolver.resolve(config.token);
    return {
      'Authorization': `Bearer ${resolvedToken}`
    };
  }

  private resolveBasicAuth(config: BasicAuthConfig): Record<string, string> {
    const resolvedUsername = this.variableResolver.resolve(config.username);
    const resolvedPassword = this.variableResolver.resolve(config.password);
    const credentials = Buffer.from(`${resolvedUsername}:${resolvedPassword}`).toString('base64');
    return {
      'Authorization': `Basic ${credentials}`
    };
  }

  private resolveOAuth2ClientCredentials(config: OAuth2ClientCredentialsConfig): Record<string, string> {
    const cacheKey = this.getOAuth2CacheKey(config);
    const cached = this.tokenCache.get(cacheKey);

    if (cached && !this.isTokenExpiring(cached)) {
      const prefix = config.header_prefix || cached.tokenType || 'Bearer';
      return {
        'Authorization': `${prefix} ${cached.accessToken}`
      };
    }

    return {};
  }

  private async resolveOAuth2ClientCredentialsAsync(config: OAuth2ClientCredentialsConfig): Promise<Record<string, string>> {
    const cacheKey = this.getOAuth2CacheKey(config);
    const cached = this.tokenCache.get(cacheKey);

    if (cached && !this.isTokenExpiring(cached)) {
      const prefix = config.header_prefix || cached.tokenType || 'Bearer';
      return {
        'Authorization': `${prefix} ${cached.accessToken}`
      };
    }

    return await this.fetchOAuth2Token(config, cacheKey);
  }

  private getOAuth2CacheKey(config: OAuth2ClientCredentialsConfig): string {
    return `${config.token_url}|${config.client_id}|${config.scope || ''}`;
  }

  private isTokenExpiring(cached: TokenCache): boolean {
    const now = Date.now() / 1000;
    return cached.expiresAt - now <= this.oauth2RefreshBuffer;
  }

  private async fetchOAuth2Token(
    config: OAuth2ClientCredentialsConfig,
    cacheKey: string
  ): Promise<Record<string, string>> {
    const resolvedTokenUrl = this.variableResolver.resolve(config.token_url);
    const resolvedClientId = this.variableResolver.resolve(config.client_id);
    const resolvedClientSecret = this.variableResolver.resolve(config.client_secret);
    const resolvedScope = config.scope ? this.variableResolver.resolve(config.scope) : undefined;

    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('client_id', resolvedClientId);
    body.append('client_secret', resolvedClientSecret);
    if (resolvedScope) {
      body.append('scope', resolvedScope);
    }

    const response = await fetch(resolvedTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OAuth2 client_credentials 认证失败: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const tokenResponse = await response.json();

    if (!tokenResponse.access_token) {
      throw new Error(`OAuth2 响应中缺少 access_token: ${JSON.stringify(tokenResponse)}`);
    }

    const expiresIn = tokenResponse.expires_in || 3600;
    const tokenType = tokenResponse.token_type || 'Bearer';
    const prefix = config.header_prefix || tokenType;

    const cached: TokenCache = {
      accessToken: tokenResponse.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      tokenType: tokenType,
      rawResponse: tokenResponse
    };

    this.tokenCache.set(cacheKey, cached);

    this.variableResolver.addExtractedVar('oauth2_access_token', tokenResponse.access_token);
    this.variableResolver.addExtractedVar('oauth2_token_type', tokenType);
    this.variableResolver.addExtractedVar('oauth2_expires_in', expiresIn);
    if (tokenResponse.refresh_token) {
      this.variableResolver.addExtractedVar('oauth2_refresh_token', tokenResponse.refresh_token);
    }
    this.variableResolver.addExtractedVar('oauth2_response', tokenResponse);

    return {
      'Authorization': `${prefix} ${tokenResponse.access_token}`
    };
  }

  mergeAuthHeaders(
    requestConfig: RequestConfig,
    envAuth?: AuthConfig,
    suiteAuth?: AuthConfig,
    caseAuth?: AuthConfig
  ): Record<string, string> {
    let effectiveAuth: AuthConfig | undefined;

    if (caseAuth) {
      effectiveAuth = caseAuth;
    } else if (suiteAuth) {
      effectiveAuth = suiteAuth;
    } else if (envAuth) {
      effectiveAuth = envAuth;
    }

    return this.resolveAuthHeader(effectiveAuth);
  }

  async mergeAuthHeadersAsync(
    requestConfig: RequestConfig,
    envAuth?: AuthConfig,
    suiteAuth?: AuthConfig,
    caseAuth?: AuthConfig
  ): Promise<Record<string, string>> {
    let effectiveAuth: AuthConfig | undefined;

    if (caseAuth) {
      effectiveAuth = caseAuth;
    } else if (suiteAuth) {
      effectiveAuth = suiteAuth;
    } else if (envAuth) {
      effectiveAuth = envAuth;
    }

    return await this.resolveAuthHeaderAsync(effectiveAuth);
  }

  clearCache(): void {
    this.tokenCache.clear();
  }
}
