import fetch, { RequestInit, Response } from 'node-fetch';
import http from 'http';
import https from 'https';
import { RequestConfig } from '../types';
import { VariableResolver } from './variables';

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export interface ReceivedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
  time: number;
  cookies: Record<string, string>;
}

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

export class HttpClient {
  private defaultTimeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(defaultTimeout: number = 30000, defaultHeaders: Record<string, string> = {}) {
    this.defaultTimeout = defaultTimeout;
    this.defaultHeaders = { ...defaultHeaders };
  }

  setDefaultHeaders(headers: Record<string, string>): void {
    this.defaultHeaders = { ...this.defaultHeaders, ...headers };
  }

  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout;
  }

  async send(
    requestConfig: RequestConfig,
    resolver: VariableResolver,
    baseUrl?: string
  ): Promise<{ request: SentRequest; response: ReceivedResponse }> {
    const resolvedConfig = resolver.resolve(requestConfig) as RequestConfig;
    const finalUrl = this.buildUrl(resolvedConfig.url, resolvedConfig.queryParams, baseUrl);

    const finalHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...(resolvedConfig.headers || {})
    };

    let resolvedBody: any = resolvedConfig.body;
    if (resolvedBody !== undefined && resolvedBody !== null) {
      if (typeof resolvedBody === 'string' && (
        finalHeaders['content-type']?.includes('application/json') ||
        finalHeaders['Content-Type']?.includes('application/json')
      )) {
        try {
          resolvedBody = JSON.parse(resolvedBody);
        } catch {
          // Keep as string
        }
      }
    }

    const init: RequestInit = {
      method: resolvedConfig.method,
      headers: this.normalizeHeaders(finalHeaders),
      timeout: resolvedConfig.timeout || this.defaultTimeout,
      follow: resolvedConfig.followRedirects !== false ? 20 : 0,
      agent: (parsedUrl: URL) => {
        return parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent;
      }
    };

    if (resolvedBody !== undefined && resolvedBody !== null) {
      if (resolvedConfig.method === 'GET' || resolvedConfig.method === 'HEAD') {
        // GET/HEAD通常不发送body
      } else if (typeof resolvedBody === 'object' && !Buffer.isBuffer(resolvedBody)) {
        const hasContentType = Object.keys(finalHeaders).some(
          h => h.toLowerCase() === 'content-type'
        );
        if (!hasContentType) {
          (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
        init.body = JSON.stringify(resolvedBody);
      } else {
        init.body = resolvedBody as any;
      }
    }

    const sentRequest: SentRequest = {
      method: resolvedConfig.method,
      url: finalUrl,
      headers: finalHeaders,
      body: resolvedBody
    };

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(finalUrl, init);
    } catch (error: any) {
      const elapsed = Date.now() - startTime;
      const errorMessage = this.formatFetchError(error);
      throw new HttpRequestError(
        errorMessage,
        sentRequest,
        elapsed,
        error.cause?.code
      );
    }
    const elapsed = Date.now() - startTime;

    const rawBody = await response.text();
    let parsedBody: any = rawBody;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json') || contentType.includes('+json')) {
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // Keep as string if JSON parsing fails
      }
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const cookies = this.parseCookies(responseHeaders);

    const receivedResponse: ReceivedResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: parsedBody,
      rawBody,
      time: elapsed,
      cookies
    };

    return { request: sentRequest, response: receivedResponse };
  }

  private buildUrl(
    url: string,
    queryParams?: Record<string, any>,
    baseUrl?: string
  ): string {
    let finalUrl = url;

    if (baseUrl && !/^https?:\/\//i.test(url)) {
      const cleanedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      const cleanedUrl = url.startsWith('/') ? url : '/' + url;
      finalUrl = cleanedBase + cleanedUrl;
    }

    if (queryParams && Object.keys(queryParams).length > 0) {
      const urlObj = new URL(finalUrl);
      for (const [key, value] of Object.entries(queryParams)) {
        if (value === null || value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const v of value) {
            urlObj.searchParams.append(key, String(v));
          }
        } else {
          urlObj.searchParams.set(key, String(value));
        }
      }
      finalUrl = urlObj.toString();
    }

    return finalUrl;
  }

  private normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === null || value === undefined) {
        continue;
      }
      normalized[key] = String(value);
    }
    return normalized;
  }

  private parseCookies(headers: Record<string, string>): Record<string, string> {
    const cookies: Record<string, string> = {};
    const setCookieHeader = headers['set-cookie'] || headers['Set-Cookie'];

    if (!setCookieHeader) {
      return cookies;
    }

    const cookieStrings = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : [setCookieHeader];

    for (const cookieStr of cookieStrings) {
      const parts = cookieStr.split(';');
      const firstPart = parts[0].trim();
      const eqIndex = firstPart.indexOf('=');
      if (eqIndex > 0) {
        const name = firstPart.slice(0, eqIndex).trim();
        const value = firstPart.slice(eqIndex + 1).trim();
        cookies[name] = value;
      }
    }

    return cookies;
  }

  private formatFetchError(error: any): string {
    if (!error) {
      return '未知的请求错误';
    }

    const code = error.cause?.code || error.code;
    const message = error.message || String(error);

    switch (code) {
      case 'ETIMEDOUT':
      case 'ECONNRESET':
      case 'ECONNREFUSED':
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return `网络连接失败 [${code}]: ${message}`;
      case 'ESOCKETTIMEDOUT':
        return `请求超时 [${code}]: ${message}`;
      case 'ERR_TLS_CERT_ALTNAME_INVALID':
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
        return `TLS证书错误 [${code}]: ${message}`;
      default:
        return `请求失败: ${message}${code ? ` [${code}]` : ''}`;
    }
  }
}

export class HttpRequestError extends Error {
  request: SentRequest;
  duration: number;
  code?: string;

  constructor(message: string, request: SentRequest, duration: number, code?: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.request = request;
    this.duration = duration;
    this.code = code;
  }
}
