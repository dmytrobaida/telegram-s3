export interface ObjectPart {
  fileId: string;
  size: number;
}

export interface StoredObject {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  lastModified: string;
  contentType: string;
  parts: ObjectPart[];
  metadata: Record<string, string>;
}

export interface MultipartUpload {
  bucket: string;
  key: string;
  uploadId: string;
  initiated: string;
  contentType: string;
  metadata: Record<string, string>;
  parts: Record<string, { etag: string; size: number; parts: ObjectPart[] }>;
}

export interface DbSchema {
  objects: Record<string, StoredObject>;
  uploads: Record<string, MultipartUpload>;
}

export const objectId = (bucket: string, key: string) => `${bucket}/${key}`;
