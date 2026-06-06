import { All, Controller, HttpException, HttpStatus, Logger, Req, Res } from '@nestjs/common';
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
  private readonly logger = new Logger(S3Controller.name);
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
    const startedAt = Date.now();
    this.logger.debug(`S3 request started method=${req.method} path=${req.path} query=${safeQuery(req)} bytes=${body.length}`);

    try {
      const result = await this.route(req, res, body, startedAt);
      this.logger.debug(`S3 request completed method=${req.method} path=${req.path} status=${res.statusCode} durationMs=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      this.logRequestError(req, error, startedAt);
      throw error;
    }
  }

  private async route(req: Request, res: Response, body: Buffer, startedAt: number) {
    this.auth.verify(req, body);

    if (req.path === '/health') {
      this.logger.debug(`Health check completed durationMs=${Date.now() - startedAt}`);
      return res.type('text/plain').send('ok');
    }

    const target = this.parseTarget(req);
    this.logger.debug(`S3 target resolved bucket=${target.bucket} key=${target.key}`);

    if (target.bucket.length === 0) {
      return this.listBuckets(res);
    }

    if (target.bucket !== this.bucket) {
      throw new HttpException('NoSuchBucket', HttpStatus.NOT_FOUND);
    }

    if (req.method === 'GET' && req.query.location !== undefined) {
      return this.bucketLocation(res);
    }

    if (req.method === 'GET' && req.query.uploads !== undefined && target.key.length === 0) {
      return this.listMultipartUploads(req, res, target.bucket);
    }

    if (req.method === 'GET' && target.key.length === 0) {
      return this.listObjects(req, res, target.bucket);
    }

    if (req.method === 'HEAD' && target.key.length === 0) {
      this.logger.log(`HEAD bucket bucket=${target.bucket}`);
      return res.status(200).end();
    }

    if (target.key.length === 0) {
      throw new HttpException('Not implemented for bucket root', HttpStatus.NOT_IMPLEMENTED);
    }

    if (req.method === 'PUT' && isDefined(req.query.partNumber) && isDefined(req.query.uploadId)) {
      return this.uploadPart(req, res, target.bucket, target.key, body);
    }

    if (req.method === 'PUT' && isDefined(req.header('x-amz-copy-source'))) {
      return this.copyObject(req, res, target.bucket, target.key);
    }

    if (req.method === 'GET' && isDefined(req.query.uploadId)) {
      return this.listParts(req, res, target.bucket, target.key);
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
    this.logger.log(`PUT object started bucket=${bucket} key=${key} bytes=${body.length}`);
    const previous = this.store.getObject(bucket, key);
    const stored = await this.createStoredObject(req, bucket, key, body);
    await this.store.putObject(stored);

    if (isDefined(previous) && previous.parts.length > 0) {
      this.logger.log(`PUT object deleting replaced Telegram messages bucket=${bucket} key=${key} oldTelegramParts=${previous.parts.length}`);
      await this.telegram.delete(previous.parts);
    }

    this.logger.log(`PUT object completed bucket=${bucket} key=${key} bytes=${stored.size} etag=${stored.etag} telegramParts=${stored.parts.length}`);
    return res.set('ETag', quote(stored.etag)).status(200).end();
  }

  private async copyObject(req: Request, res: Response, bucket: string, key: string) {
    const source = parseCopySource(req.header('x-amz-copy-source') ?? '');
    this.logger.log(`COPY object started sourceBucket=${source.bucket} sourceKey=${source.key} targetBucket=${bucket} targetKey=${key}`);

    if (source.bucket !== this.bucket) {
      throw new HttpException('NoSuchBucket', HttpStatus.NOT_FOUND);
    }

    const sourceObject = this.mustGet(source.bucket, source.key);
    const previous = this.store.getObject(bucket, key);
    const data = await this.telegram.read(sourceObject.parts);
    const saved = await this.telegram.put(data, safeName(key), sourceObject.contentType);
    const copied: StoredObject = {
      bucket,
      key,
      size: sourceObject.size,
      etag: saved.etag,
      lastModified: new Date().toISOString(),
      contentType: sourceObject.contentType,
      parts: saved.parts,
      metadata: sourceObject.metadata,
    };
    await this.store.putObject(copied);

    if (isDefined(previous) && previous.parts.length > 0) {
      this.logger.log(`COPY object deleting replaced Telegram messages bucket=${bucket} key=${key} oldTelegramParts=${previous.parts.length}`);
      await this.telegram.delete(previous.parts);
    }

    this.logger.log(`COPY object completed sourceBucket=${source.bucket} sourceKey=${source.key} targetBucket=${bucket} targetKey=${key} bytes=${copied.size} telegramParts=${copied.parts.length}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${copied.lastModified}</LastModified><ETag>${quote(copied.etag)}</ETag></CopyObjectResult>`;
    return res.set('ETag', quote(copied.etag)).type('application/xml').send(xml);
  }

  private async getObject(_req: Request, res: Response, bucket: string, key: string) {
    this.logger.log(`GET object started bucket=${bucket} key=${key}`);
    const object = this.mustGet(bucket, key);
    this.logger.debug(`GET object metadata found bucket=${bucket} key=${key} bytes=${object.size} telegramParts=${object.parts.length}`);
    const data = await this.telegram.read(object.parts);
    this.logger.log(`GET object completed bucket=${bucket} key=${key} bytes=${data.length}`);
    return res
      .set('Content-Type', object.contentType)
      .set('Content-Length', String(object.size))
      .set('ETag', quote(object.etag))
      .set('Last-Modified', new Date(object.lastModified).toUTCString())
      .send(data);
  }

  private headObject(res: Response, bucket: string, key: string) {
    this.logger.log(`HEAD object bucket=${bucket} key=${key}`);
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
    this.logger.log(`DELETE object started bucket=${bucket} key=${key}`);
    const object = this.store.getObject(bucket, key);
    await this.store.deleteObject(bucket, key);

    if (isDefined(object) && object.parts.length > 0) {
      this.logger.log(`DELETE object deleting Telegram messages bucket=${bucket} key=${key} telegramParts=${object.parts.length}`);
      await this.telegram.delete(object.parts);
    }

    this.logger.log(`DELETE object completed bucket=${bucket} key=${key}`);
    return res.status(204).end();
  }

  private listObjects(req: Request, res: Response, bucket: string) {
    const prefix = queryValue(req.query.prefix) ?? '';
    const delimiter = queryValue(req.query.delimiter);
    const maxKeys = Math.min(Number(queryValue(req.query['max-keys']) ?? '1000'), 1000);
    const listType = queryValue(req.query['list-type']);
    const continuation = queryValue(req.query['continuation-token']) ?? queryValue(req.query.marker) ?? queryValue(req.query['start-after']);
    this.logger.log(`LIST objects started bucket=${bucket} prefix=${prefix} delimiter=${delimiter ?? ''} maxKeys=${maxKeys} continuation=${continuation ?? ''} listType=${listType ?? ''}`);
    const { objects, isTruncated, nextContinuationToken } = this.store.listObjects(bucket, prefix, continuation, maxKeys);
    const listed = applyDelimiter(objects, prefix, delimiter);
    const isV2 = listType === '2';
    const keyCount = listed.contents.length + listed.commonPrefixes.length;
    const tokenXml = isDefined(nextContinuationToken) ? `<NextContinuationToken>${esc(nextContinuationToken)}</NextContinuationToken><NextMarker>${esc(nextContinuationToken)}</NextMarker>` : '';
    this.logger.log(`LIST objects completed bucket=${bucket} prefix=${prefix} contents=${listed.contents.length} commonPrefixes=${listed.commonPrefixes.length} truncated=${isTruncated}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>${isDefined(delimiter) ? `<Delimiter>${esc(delimiter)}</Delimiter>` : ''}${isV2 ? '<ListType>2</ListType>' : ''}<KeyCount>${keyCount}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${tokenXml}${listed.contents.map((o) => `<Contents><Key>${esc(o.key)}</Key><LastModified>${o.lastModified}</LastModified><ETag>${quote(o.etag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}${listed.commonPrefixes.map((commonPrefix) => `<CommonPrefixes><Prefix>${esc(commonPrefix)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;
    return res.type('application/xml').send(xml);
  }

  private listMultipartUploads(req: Request, res: Response, bucket: string) {
    const prefix = queryValue(req.query.prefix) ?? '';
    const uploads = this.store.listUploads(bucket, prefix);
    this.logger.log(`LIST multipart uploads bucket=${bucket} prefix=${prefix} uploads=${uploads.length}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${esc(bucket)}</Bucket><Prefix>${esc(prefix)}</Prefix><KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker><NextKeyMarker></NextKeyMarker><NextUploadIdMarker></NextUploadIdMarker><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>${uploads.map((upload) => `<Upload><Key>${esc(upload.key)}</Key><UploadId>${esc(upload.uploadId)}</UploadId><Initiator><ID>telegram-s3</ID><DisplayName>telegram-s3</DisplayName></Initiator><Owner><ID>telegram-s3</ID><DisplayName>telegram-s3</DisplayName></Owner><StorageClass>STANDARD</StorageClass><Initiated>${upload.initiated}</Initiated></Upload>`).join('')}</ListMultipartUploadsResult>`;
    return res.type('application/xml').send(xml);
  }

  private listParts(req: Request, res: Response, bucket: string, key: string) {
    const uploadId = String(req.query.uploadId);
    const upload = this.store.getUpload(uploadId);
    if (isNotDefined(upload)) {
      this.logger.warn(`LIST multipart parts failed missing upload bucket=${bucket} key=${key} uploadId=${uploadId}`);
      throw new HttpException('NoSuchUpload', HttpStatus.NOT_FOUND);
    }

    const parts = Object.entries(upload.parts)
      .map(([partNumber, part]) => ({ partNumber: Number(partNumber), etag: part.etag, size: part.size }))
      .sort((a, b) => a.partNumber - b.partNumber);
    this.logger.log(`LIST multipart parts bucket=${bucket} key=${key} uploadId=${uploadId} parts=${parts.length}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${esc(uploadId)}</UploadId><StorageClass>STANDARD</StorageClass><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>0</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><LastModified>${upload.initiated}</LastModified><ETag>${quote(part.etag)}</ETag><Size>${part.size}</Size></Part>`).join('')}</ListPartsResult>`;
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
    this.logger.log(`CREATE multipart upload bucket=${bucket} key=${key} uploadId=${upload.uploadId}`);
    await this.store.putUpload(upload);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${upload.uploadId}</UploadId></InitiateMultipartUploadResult>`);
  }

  private async uploadPart(req: Request, res: Response, _bucket: string, key: string, body: Buffer) {
    const uploadId = String(req.query.uploadId);
    const partNumber = String(req.query.partNumber);
    const upload = this.store.getUpload(uploadId);
    if (isNotDefined(upload)) {
      this.logger.warn(`UPLOAD multipart part failed missing upload key=${key} uploadId=${uploadId} partNumber=${partNumber}`);
      throw new HttpException('NoSuchUpload', HttpStatus.NOT_FOUND);
    }

    this.logger.log(`UPLOAD multipart part started key=${key} uploadId=${uploadId} partNumber=${partNumber} bytes=${body.length}`);
    const saved = await this.telegram.put(body, `${safeName(key)}.${uploadId}.${partNumber}`);
    upload.parts[partNumber] = { etag: saved.etag, size: body.length, parts: saved.parts };
    await this.store.putUpload(upload);
    this.logger.log(`UPLOAD multipart part completed key=${key} uploadId=${uploadId} partNumber=${partNumber} bytes=${body.length} telegramParts=${saved.parts.length}`);
    return res.set('ETag', quote(saved.etag)).status(200).end();
  }

  private async completeMultipart(req: Request, res: Response, bucket: string, key: string, body: Buffer) {
    const uploadId = String(req.query.uploadId);
    const upload = this.store.getUpload(uploadId);
    if (isNotDefined(upload)) {
      this.logger.warn(`COMPLETE multipart upload failed missing upload bucket=${bucket} key=${key} uploadId=${uploadId}`);
      throw new HttpException('NoSuchUpload', HttpStatus.NOT_FOUND);
    }

    this.logger.log(`COMPLETE multipart upload started bucket=${bucket} key=${key} uploadId=${uploadId}`);
    const requested = this.parseCompletedParts(body);
    const numbers = requested.length > 0 ? requested : Object.keys(upload.parts).map(Number).sort((a, b) => a - b);
    const uploadedParts: Array<{ etag: string; size: number; parts: StoredObject['parts'] }> = [];

    for (const number of numbers) {
      const part = upload.parts[String(number)];
      if (isNotDefined(part)) {
        this.logger.warn(`COMPLETE multipart upload failed invalid part bucket=${bucket} key=${key} uploadId=${uploadId} partNumber=${number}`);
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
    const previous = this.store.getObject(bucket, key);
    this.logger.log(`COMPLETE multipart upload storing object bucket=${bucket} key=${key} uploadId=${uploadId} bytes=${size} parts=${uploadedParts.length}`);
    await this.store.putObject(object);
    await this.store.deleteUpload(uploadId);

    if (isDefined(previous) && previous.parts.length > 0) {
      this.logger.log(`COMPLETE multipart upload deleting replaced Telegram messages bucket=${bucket} key=${key} oldTelegramParts=${previous.parts.length}`);
      await this.telegram.delete(previous.parts);
    }
    this.logger.log(`COMPLETE multipart upload completed bucket=${bucket} key=${key} uploadId=${uploadId} etag=${etag}`);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><ETag>${quote(etag)}</ETag></CompleteMultipartUploadResult>`);
  }

  private async abortMultipart(res: Response, uploadId: string) {
    this.logger.log(`ABORT multipart upload uploadId=${uploadId}`);
    const upload = this.store.getUpload(uploadId);
    await this.store.deleteUpload(uploadId);

    if (isDefined(upload)) {
      const parts = Object.values(upload.parts).flatMap((part) => part.parts);
      this.logger.log(`ABORT multipart upload deleting Telegram messages uploadId=${uploadId} telegramParts=${parts.length}`);
      await this.telegram.delete(parts);
    }

    return res.status(204).end();
  }

  private listBuckets(res: Response) {
    this.logger.log(`LIST buckets completed bucket=${this.bucket}`);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets><Bucket><Name>${esc(this.bucket)}</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`);
  }

  private bucketLocation(res: Response) {
    this.logger.log(`GET bucket location bucket=${this.bucket} region=${this.region}`);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${esc(this.region)}</LocationConstraint>`);
  }

  private async createStoredObject(req: Request, bucket: string, key: string, body: Buffer): Promise<StoredObject> {
    const contentType = req.header('content-type') ?? 'application/octet-stream';
    this.logger.debug(`Creating stored object bucket=${bucket} key=${key} contentType=${contentType} bytes=${body.length}`);
    const saved = await this.telegram.put(body, safeName(key), contentType);
    return { bucket, key, size: body.length, etag: saved.etag, lastModified: new Date().toISOString(), contentType, parts: saved.parts, metadata: userMetadata(req) };
  }

  private mustGet(bucket: string, key: string) {
    const object = this.store.getObject(bucket, key);
    if (isNotDefined(object)) {
      this.logger.warn(`Object not found bucket=${bucket} key=${key}`);
      throw new HttpException('NoSuchKey', HttpStatus.NOT_FOUND);
    }

    return object;
  }

  private logRequestError(req: Request, error: unknown, startedAt: number) {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    this.logger.error(`S3 request failed method=${req.method} path=${req.path} status=${status} durationMs=${Date.now() - startedAt} message=${message}`, stack);
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

function parseCopySource(value: string) {
  const clean = value.replace(/^\/+/, '');
  const [bucket, ...keyParts] = clean.split('/');
  return {
    bucket: safeDecodeURIComponent(bucket),
    key: keyParts.map(safeDecodeURIComponent).join('/'),
  };
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
  } catch {
    return value;
  }
}

function queryValue(value: unknown, defaultValue?: string) {
  if (Array.isArray(value)) {
    return queryValue(value[0], defaultValue);
  }

  if (isNotDefined(value)) {
    return defaultValue;
  }

  return String(value);
}

function applyDelimiter(objects: StoredObject[], prefix: string, delimiter?: string) {
  if (isNotDefined(delimiter) || delimiter.length === 0) {
    return { contents: objects, commonPrefixes: [] };
  }

  const contents: StoredObject[] = [];
  const commonPrefixes = new Set<string>();
  for (const object of objects) {
    const rest = object.key.slice(prefix.length);
    const delimiterIndex = rest.indexOf(delimiter);
    if (delimiterIndex === -1) {
      contents.push(object);
      continue;
    }

    commonPrefixes.add(`${prefix}${rest.slice(0, delimiterIndex + delimiter.length)}`);
  }

  return { contents, commonPrefixes: [...commonPrefixes].sort((a, b) => a.localeCompare(b)) };
}

function safeQuery(req: Request) {
  const keys = Object.keys(req.query).filter((key) => key !== 'X-Amz-Signature').sort();
  return keys.join(',');
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
