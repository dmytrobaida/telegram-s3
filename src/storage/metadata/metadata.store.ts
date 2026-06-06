import { Injectable, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import path from 'path';
import { isDefined } from '../../common/assertions';
import { DbSchema, MultipartUpload, objectId, StoredObject } from '../../s3/types';

@Injectable()
export class MetadataStore implements OnModuleInit {
  private readonly file = process.env.METADATA_FILE ?? '/data/metadata.json';
  private db: DbSchema = { objects: {}, uploads: {} };
  private writeQueue = Promise.resolve();

  async onModuleInit() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.db = JSON.parse(await fs.readFile(this.file, 'utf8')) as DbSchema;
      this.db.objects ??= {};
      this.db.uploads ??= {};
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      await this.persist();
    }
  }

  getObject(bucket: string, key: string) {
    return this.db.objects[objectId(bucket, key)];
  }

  putObject(object: StoredObject) {
    this.db.objects[objectId(object.bucket, object.key)] = object;
    return this.persist();
  }

  deleteObject(bucket: string, key: string) {
    delete this.db.objects[objectId(bucket, key)];
    return this.persist();
  }

  listObjects(bucket: string, prefix = '', continuationToken?: string, maxKeys = 1000) {
    const keys = Object.values(this.db.objects)
      .filter((o) => o.bucket === bucket && o.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
    const start = continuationToken ? Math.max(0, keys.findIndex((o) => o.key === continuationToken) + 1) : 0;
    const page = keys.slice(start, start + maxKeys);
    const next = start + maxKeys < keys.length ? page[page.length - 1]?.key : undefined;
    return { objects: page, isTruncated: isDefined(next), nextContinuationToken: next };
  }

  putUpload(upload: MultipartUpload) {
    this.db.uploads[upload.uploadId] = upload;
    return this.persist();
  }

  getUpload(uploadId: string) {
    return this.db.uploads[uploadId];
  }

  deleteUpload(uploadId: string) {
    delete this.db.uploads[uploadId];
    return this.persist();
  }

  private persist() {
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.file, JSON.stringify(this.db, null, 2)));
    return this.writeQueue;
  }
}
