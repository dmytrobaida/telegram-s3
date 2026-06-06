import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import path from 'path';
import { isDefined } from '../../common/assertions';
import { DbSchema, MultipartUpload, objectId, StoredObject } from '../../s3/types';

@Injectable()
export class MetadataStore implements OnModuleInit {
  private readonly logger = new Logger(MetadataStore.name);
  private readonly file = process.env.METADATA_FILE ?? '/data/metadata.json';
  private db: DbSchema = { objects: {}, uploads: {} };
  private writeQueue = Promise.resolve();

  async onModuleInit() {
    this.logger.log(`Metadata store initializing file=${this.file}`);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.db = JSON.parse(await fs.readFile(this.file, 'utf8')) as DbSchema;
      this.db.objects ??= {};
      this.db.uploads ??= {};
      this.logger.log(`Metadata store loaded objects=${Object.keys(this.db.objects).length} uploads=${Object.keys(this.db.uploads).length}`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.error(`Metadata store failed to load file=${this.file}`, error instanceof Error ? error.stack : String(error));
        throw error;
      }

      this.logger.warn(`Metadata file not found, creating new metadata store file=${this.file}`);
      await this.persist();
    }
  }

  getObject(bucket: string, key: string) {
    const object = this.db.objects[objectId(bucket, key)];
    this.logger.debug(`Metadata getObject bucket=${bucket} key=${key} found=${isDefined(object)}`);
    return object;
  }

  putObject(object: StoredObject) {
    this.logger.debug(`Metadata putObject bucket=${object.bucket} key=${object.key} bytes=${object.size} parts=${object.parts.length}`);
    this.db.objects[objectId(object.bucket, object.key)] = object;
    return this.persist();
  }

  deleteObject(bucket: string, key: string) {
    this.logger.debug(`Metadata deleteObject bucket=${bucket} key=${key}`);
    delete this.db.objects[objectId(bucket, key)];
    return this.persist();
  }

  listObjects(bucket: string, prefix = '', startAfter?: string, maxKeys = 1000) {
    this.logger.debug(`Metadata listObjects bucket=${bucket} prefix=${prefix} startAfter=${startAfter ?? ''} maxKeys=${maxKeys}`);
    const keys = Object.values(this.db.objects)
      .filter((o) => o.bucket === bucket && o.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    const start = isDefined(startAfter) ? Math.max(0, keys.findIndex((o) => o.key === startAfter) + 1) : 0;
    const page = keys.slice(start, start + maxKeys);
    const next = start + maxKeys < keys.length ? page[page.length - 1]?.key : undefined;
    this.logger.debug(`Metadata listObjects completed bucket=${bucket} matched=${keys.length} returned=${page.length} truncated=${isDefined(next)}`);
    return { objects: page, isTruncated: isDefined(next), nextContinuationToken: next };
  }

  putUpload(upload: MultipartUpload) {
    this.logger.debug(`Metadata putUpload bucket=${upload.bucket} key=${upload.key} uploadId=${upload.uploadId} parts=${Object.keys(upload.parts).length}`);
    this.db.uploads[upload.uploadId] = upload;
    return this.persist();
  }

  getUpload(uploadId: string) {
    const upload = this.db.uploads[uploadId];
    this.logger.debug(`Metadata getUpload uploadId=${uploadId} found=${isDefined(upload)}`);
    return upload;
  }

  listUploads(bucket: string, prefix = '') {
    const uploads = Object.values(this.db.uploads)
      .filter((upload) => upload.bucket === bucket && upload.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    this.logger.debug(`Metadata listUploads bucket=${bucket} prefix=${prefix} returned=${uploads.length}`);
    return uploads;
  }

  deleteUpload(uploadId: string) {
    this.logger.debug(`Metadata deleteUpload uploadId=${uploadId}`);
    delete this.db.uploads[uploadId];
    return this.persist();
  }

  private persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      this.logger.debug(`Metadata persist started file=${this.file}`);
      await fs.writeFile(this.file, JSON.stringify(this.db, null, 2));
      this.logger.debug(`Metadata persist completed file=${this.file} objects=${Object.keys(this.db.objects).length} uploads=${Object.keys(this.db.uploads).length}`);
    });
    return this.writeQueue;
  }
}
