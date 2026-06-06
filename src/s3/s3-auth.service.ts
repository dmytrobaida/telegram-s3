import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { isNotDefined } from '../common/assertions';
import { requiredEnv } from '../common/env';

@Injectable()
export class S3AuthService {
  private readonly logger = new Logger(S3AuthService.name);
  private readonly accessKey = requiredEnv('S3_ACCESS_KEY_ID');
  private readonly secretKey = requiredEnv('S3_SECRET_ACCESS_KEY');

  verify(req: Request, body: Buffer) {
    if (req.path === '/health') {
      this.logger.debug('Skipping auth for health check');
      return;
    }

    const auth = req.header('authorization');
    if (auth?.startsWith('AWS4-HMAC-SHA256 ') === true) {
      this.logger.debug(`Verifying AWS SigV4 header auth method=${req.method} path=${req.path} bytes=${body.length}`);
      return this.verifyHeaderAuth(req, body, auth);
    }

    if (typeof req.query['X-Amz-Signature'] === 'string') {
      this.logger.debug(`Verifying AWS SigV4 query auth method=${req.method} path=${req.path} bytes=${body.length}`);
      return this.verifyQueryAuth(req, body);
    }

    this.logger.warn(`Missing AWS SigV4 authorization method=${req.method} path=${req.path}`);
    throw new UnauthorizedException('Missing AWS Signature v4 Authorization');
  }

  private verifyHeaderAuth(req: Request, body: Buffer, auth: string) {
    const fields = parseAuthHeader(auth);
    const credential = fields.Credential?.split('/');
    if (isNotDefined(credential) || credential.length !== 5 || credential[0] !== this.accessKey) {
      this.logger.warn(`Invalid header auth access key method=${req.method} path=${req.path}`);
      throw new UnauthorizedException('Invalid access key');
    }

    const [, date, region, service, terminal] = credential;
    if (service !== 's3' || terminal !== 'aws4_request') {
      this.logger.warn(`Invalid credential scope method=${req.method} path=${req.path} service=${service} terminal=${terminal}`);
      throw new UnauthorizedException('Invalid credential scope');
    }

    const signedHeaders = fields.SignedHeaders;
    const signature = fields.Signature;
    if (isNotDefined(signedHeaders) || isNotDefined(signature)) {
      this.logger.warn(`Invalid Authorization header method=${req.method} path=${req.path}`);
      throw new UnauthorizedException('Invalid Authorization header');
    }

    const amzDate = req.header('x-amz-date');
    if (isNotDefined(amzDate)) {
      this.logger.warn(`Missing x-amz-date method=${req.method} path=${req.path}`);
      throw new UnauthorizedException('Missing x-amz-date');
    }

    const canonicalRequest = this.canonicalRequest(req, body, signedHeaders.split(';'), false);
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${date}/${region}/${service}/${terminal}`, sha256(canonicalRequest)].join('\n');
    const expected = hmacHex(signingKey(this.secretKey, date, region, service), stringToSign);
    if (safeEqualHex(expected, signature) === false) {
      this.logger.warn(`Header signature mismatch method=${req.method} path=${req.path} region=${region}`);
      throw new UnauthorizedException('Signature mismatch');
    }

    this.logger.debug(`Header auth verified method=${req.method} path=${req.path} region=${region}`);
  }

  private verifyQueryAuth(req: Request, body: Buffer) {
    const algorithm = String(req.query['X-Amz-Algorithm'] ?? '');
    if (algorithm !== 'AWS4-HMAC-SHA256') {
      this.logger.warn(`Invalid presign algorithm method=${req.method} path=${req.path} algorithm=${algorithm}`);
      throw new UnauthorizedException('Invalid presign algorithm');
    }

    const credential = String(req.query['X-Amz-Credential'] ?? '').split('/');
    if (credential.length !== 5 || credential[0] !== this.accessKey) {
      this.logger.warn(`Invalid query auth access key method=${req.method} path=${req.path}`);
      throw new UnauthorizedException('Invalid access key');
    }

    const [, date, region, service, terminal] = credential;
    const signedHeaders = String(req.query['X-Amz-SignedHeaders'] ?? '').split(';').filter(Boolean);
    const signature = String(req.query['X-Amz-Signature'] ?? '');
    const amzDate = String(req.query['X-Amz-Date'] ?? '');
    const canonicalRequest = this.canonicalRequest(req, body, signedHeaders, true);
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${date}/${region}/${service}/${terminal}`, sha256(canonicalRequest)].join('\n');
    const expected = hmacHex(signingKey(this.secretKey, date, region, service), stringToSign);
    if (safeEqualHex(expected, signature) === false) {
      this.logger.warn(`Query signature mismatch method=${req.method} path=${req.path} region=${region}`);
      throw new UnauthorizedException('Signature mismatch');
    }

    this.logger.debug(`Query auth verified method=${req.method} path=${req.path} region=${region}`);
  }

  private canonicalRequest(req: Request, body: Buffer, signedHeaders: string[], presigned: boolean) {
    const method = req.method.toUpperCase();
    const path = canonicalUri(req);
    const query = canonicalQuery(req, presigned);
    const headers = signedHeaders.map((h) => `${h}:${normalizeHeader(req.header(h) ?? '')}`).join('\n');
    const payloadHash = presigned ? 'UNSIGNED-PAYLOAD' : req.header('x-amz-content-sha256') || sha256Buffer(body);
    return [method, path, query, `${headers}\n`, signedHeaders.join(';'), payloadHash].join('\n');
  }
}

function parseAuthHeader(auth: string) {
  const out: Record<string, string> = {};
  for (const part of auth.replace('AWS4-HMAC-SHA256 ', '').split(/,\s*/)) {
    const [k, ...v] = part.split('=');
    out[k] = v.join('=');
  }
  return out;
}

function canonicalUri(req: Request) {
  const rawPath = req.originalUrl.split('?')[0] ?? '/';
  return rawPath
    .split('/')
    .map((segment) => awsEncode(safeDecodeURIComponent(segment)))
    .join('/');
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalQuery(req: Request, presigned: boolean) {
  const url = new URL(req.originalUrl, 'http://localhost');
  const params: [string, string][] = [];
  url.searchParams.forEach((value, key) => {
    if (presigned && key === 'X-Amz-Signature') {
      return;
    }

    params.push([awsEncode(key), awsEncode(value)]);
  });
  return params
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function normalizeHeader(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Buffer(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: Buffer, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function signingKey(secret: string, date: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
