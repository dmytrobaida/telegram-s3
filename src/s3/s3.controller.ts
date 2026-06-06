import { All, Controller, HttpException, HttpStatus, Req, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { XMLParser } from 'fast-xml-parser';
import { isDefined, isNotDefined } from '../common/assertions';
import { requiredEnv } from '../common/env';
import { MetadataStore } from '../storage/metadata/metadata.store';
import { TelegramStorage } from '../storage/telegram/telegram.storage';
import { S3AuthService } from './s3-auth.service';
import { MultipartUpload, StoredObject } from './types';

@Controller()
export class S3Controller {
  private readonly bucket = requiredEnv('S3_BUCKET');
  private readonly region = requiredEnv('S3_REGION');
  private readonly xmlParser = new XMLParser({ ignoreAttributes: false });

  constructor(
    private readonly store: MetadataStore,
    private readonly telegram: TelegramStorage,
    private readonly auth: S3AuthService,
  ) {}

  @All('*')
  async handle(@Req() req: Request, @Res() res: Response) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    this.auth.verify(req, body);

    if (req.path === '/health') {
      return res.type('text/plain').send('ok');
    }

    const target = this.parseTarget(req);
    if (target.bucket.length === 0) {
      return this.listBuckets(res);
    }

    if (target.bucket !== this.bucket) {
      throw new HttpException('NoSuchBucket', HttpStatus.NOT_FOUND);
    }

    if (req.method === 'GET' && target.key.length === 0) {
      return this.listObjects(req, res, target.bucket);
    }

    if (req.method === 'HEAD' && target.key.length === 0) {
      return res.status(200).end();
    }

    if (req.method === 'GET' && req.query.location !== undefined) {
      return this.bucketLocation(res);
    }

    if (target.key.length === 0) {
      throw new HttpException('Not implemented for bucket root', HttpStatus.NOT_IMPLEMENTED);
    }

    if (req.method === 'PUT' && isDefined(req.query.partNumber) && isDefined(req.query.uploadId)) {
      return this.uploadPart(req, res, target.bucket, target.key, body);
    }

    if (req.method === 'POST' && req.query.uploads !== undefined) {
      return this.createMultipart(req, res, target.bucket, target.key);
    }

    if (req.method === 'POST' && isDefined(req.query.uploadId)) {
      return this.completeMultipart(req, res, target.bucket, target.key, body);
    }

    if (req.method === 'DELETE' && isDefined(req.query.uploadId)) {
      return this.abortMultipart(res, String(req.query.uploadId));
    }

    if (req.method === 'PUT') {
      return this.putObject(req, res, target.bucket, target.key, body);
    }

    if (req.method === 'GET') {
      return this.getObject(req, res, target.bucket, target.key);
    }

    if (req.method === 'HEAD') {
      return this.headObject(res, target.bucket, target.key);
    }

    if (req.method === 'DELETE') {
      return this.deleteObject(res, target.bucket, target.key);
    }

    throw new HttpException('MethodNotAllowed', HttpStatus.METHOD_NOT_ALLOWED);
  }

  private async putObject(req: Request, res: Response, bucket: string, key: string, body: Buffer) {
    const stored = await this.createStoredObject(req, bucket, key, body);
    await this.store.putObject(stored);
    return res.set('ETag', quote(stored.etag)).status(200).end();
  }

  private async getObject(_req: Request, res: Response, bucket: string, key: string) {
    const object = this.mustGet(bucket, key);
    const data = await this.telegram.read(object.parts);
    return res
      .set('Content-Type', object.contentType)
      .set('Content-Length', String(object.size))
      .set('ETag', quote(object.etag))
      .set('Last-Modified', new Date(object.lastModified).toUTCString())
      .send(data);
  }

  private headObject(res: Response, bucket: string, key: string) {
    const object = this.mustGet(bucket, key);
    return res
      .set('Content-Type', object.contentType)
      .set('Content-Length', String(object.size))
      .set('ETag', quote(object.etag))
      .set('Last-Modified', new Date(object.lastModified).toUTCString())
      .status(200)
      .end();
  }

  private async deleteObject(res: Response, bucket: string, key: string) {
    await this.store.deleteObject(bucket, key);
    return res.status(204).end();
  }

  private listObjects(req: Request, res: Response, bucket: string) {
    const prefix = String(req.query.prefix ?? '');
    const maxKeys = Math.min(Number(req.query['max-keys'] ?? 1000), 1000);
    const continuation = isDefined(req.query['continuation-token']) ? String(req.query['continuation-token']) : undefined;
    const { objects, isTruncated, nextContinuationToken } = this.store.listObjects(bucket, prefix, continuation, maxKeys);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${objects.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${isDefined(nextContinuationToken) ? `<NextContinuationToken>${esc(nextContinuationToken)}</NextContinuationToken>` : ''}${objects.map((o) => `<Contents><Key>${esc(o.key)}</Key><LastModified>${o.lastModified}</LastModified><ETag>${quote(o.etag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}</ListBucketResult>`;
    return res.type('application/xml').send(xml);
  }

  private async createMultipart(req: Request, res: Response, bucket: string, key: string) {
    const upload: MultipartUpload = {
      bucket,
      key,
      uploadId: randomUUID(),
      initiated: new Date().toISOString(),
      contentType: req.header('content-type') ?? 'application/octet-stream',
      metadata: userMetadata(req),
      parts: {},
    };
    await this.store.putUpload(upload);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${upload.uploadId}</UploadId></InitiateMultipartUploadResult>`);
  }

  private async uploadPart(req: Request, res: Response, _bucket: string, key: string, body: Buffer) {
    const uploadId = String(req.query.uploadId);
    const partNumber = String(req.query.partNumber);
    const upload = this.store.getUpload(uploadId);
    if (isNotDefined(upload)) {
      throw new HttpException('NoSuchUpload', HttpStatus.NOT_FOUND);
    }

    const saved = await this.telegram.put(body, `${safeName(key)}.${uploadId}.${partNumber}`);
    upload.parts[partNumber] = { etag: saved.etag, size: body.length, parts: saved.parts };
    await this.store.putUpload(upload);
    return res.set('ETag', quote(saved.etag)).status(200).end();
  }

  private async completeMultipart(req: Request, res: Response, bucket: string, key: string, body: Buffer) {
    const uploadId = String(req.query.uploadId);
    const upload = this.store.getUpload(uploadId);
    if (isNotDefined(upload)) {
      throw new HttpException('NoSuchUpload', HttpStatus.NOT_FOUND);
    }

    const requested = this.parseCompletedParts(body);
    const numbers = requested.length > 0 ? requested : Object.keys(upload.parts).map(Number).sort((a, b) => a - b);
    const uploadedParts: Array<{ etag: string; size: number; parts: StoredObject['parts'] }> = [];

    for (const number of numbers) {
      const part = upload.parts[String(number)];
      if (isNotDefined(part)) {
        throw new HttpException('InvalidPart', HttpStatus.BAD_REQUEST);
      }

      uploadedParts.push(part);
    }

    const size = uploadedParts.reduce((sum, p) => sum + p.size, 0);
    const etag = `${uploadedParts.map((p) => p.etag).join('-')}-${uploadedParts.length}`;
    const object: StoredObject = {
      bucket,
      key,
      size,
      etag,
      lastModified: new Date().toISOString(),
      contentType: upload.contentType,
      parts: uploadedParts.flatMap((p) => p.parts),
      metadata: upload.metadata,
    };
    await this.store.putObject(object);
    await this.store.deleteUpload(uploadId);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><ETag>${quote(etag)}</ETag></CompleteMultipartUploadResult>`);
  }

  private async abortMultipart(res: Response, uploadId: string) {
    await this.store.deleteUpload(uploadId);
    return res.status(204).end();
  }

  private listBuckets(res: Response) {
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets><Bucket><Name>${esc(this.bucket)}</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`);
  }

  private bucketLocation(res: Response) {
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${esc(this.region)}</LocationConstraint>`);
  }

  private async createStoredObject(req: Request, bucket: string, key: string, body: Buffer): Promise<StoredObject> {
    const contentType = req.header('content-type') ?? 'application/octet-stream';
    const saved = await this.telegram.put(body, safeName(key), contentType);
    return { bucket, key, size: body.length, etag: saved.etag, lastModified: new Date().toISOString(), contentType, parts: saved.parts, metadata: userMetadata(req) };
  }

  private mustGet(bucket: string, key: string) {
    const object = this.store.getObject(bucket, key);
    if (isNotDefined(object)) {
      throw new HttpException('NoSuchKey', HttpStatus.NOT_FOUND);
    }

    return object;
  }

  private parseTarget(req: Request) {
    const clean = req.path.replace(/^\/+/, '');

    const hostBucket = req.hostname.split('.')[0];
    if (hostBucket === this.bucket) {
      return { bucket: this.bucket, key: clean.split('/').map(decodeURIComponent).join('/') };
    }

    if (clean.length === 0) {
      return { bucket: '', key: '' };
    }

    const [bucket, ...rest] = clean.split('/');
    return { bucket: decodeURIComponent(bucket), key: rest.map(decodeURIComponent).join('/') };
  }

  private parseCompletedParts(body: Buffer) {
    if (body.length === 0) {
      return [];
    }

    const parsed = this.xmlParser.parse(body.toString('utf8'));
    const raw = parsed?.CompleteMultipartUpload?.Part ?? [];
    const parts = Array.isArray(raw) ? raw : [raw];
    return parts
      .map((p) => Number(p.PartNumber))
      .filter((partNumber) => Number.isFinite(partNumber) && partNumber > 0)
      .sort((a, b) => a - b);
  }
}

function esc(value: string) {
  const escaped = value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);
  return escaped;
}

function quote(value: string) {
  return `"${value}"`;
}

function safeName(value: string) {
  const name = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120);
  if (name.length === 0) {
    return 'object';
  }

  return name;
}

function userMetadata(req: Request) {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-amz-meta-')) {
      metadata[key.slice('x-amz-meta-'.length)] = Array.isArray(value) ? value.join(',') : String(value);
    }
  }

  return metadata;
}
