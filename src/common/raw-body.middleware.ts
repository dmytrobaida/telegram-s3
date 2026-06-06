import { Logger, PayloadTooLargeException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('RawBodyMiddleware');

export function createRawBodyMiddleware(limit: string) {
  const maxBytes = parseByteSize(limit);

  return (req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    const contentLength = Number(req.header('content-length') ?? 0);
    const progressStepBytes = 10 * 1024 * 1024;
    let totalBytes = 0;
    let nextProgressBytes = progressStepBytes;

    logger.debug(`Raw body read started method=${req.method} path=${req.path} contentLength=${Number.isFinite(contentLength) ? contentLength : 0} limit=${maxBytes}`);

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;

      if (totalBytes >= nextProgressBytes) {
        logger.log(`Raw body read progress method=${req.method} path=${req.path} bytes=${totalBytes} contentLength=${Number.isFinite(contentLength) ? contentLength : 0}`);
        nextProgressBytes += progressStepBytes;
      }

      if (totalBytes > maxBytes) {
        logger.warn(`Request body too large method=${req.method} path=${req.path} bytes=${totalBytes} limit=${maxBytes}`);
        req.destroy(new PayloadTooLargeException(`Request body too large. Limit is ${limit}`));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      req.body = Buffer.concat(chunks, totalBytes);
      logger.debug(`Raw body collected method=${req.method} path=${req.path} bytes=${totalBytes}`);
      next();
    });

    req.on('error', (error) => {
      logger.error(`Raw body read failed method=${req.method} path=${req.path}`, error instanceof Error ? error.stack : String(error));
      next(error);
    });
  };
}

function parseByteSize(value: string) {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(normalized);
  if (match === null) {
    throw new Error(`Invalid byte size: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
  };

  return Math.floor(amount * multipliers[unit]);
}
