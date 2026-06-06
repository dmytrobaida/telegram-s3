import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import FormData from 'form-data';
import { isNotDefined } from '../../common/assertions';
import { requiredEnv } from '../../common/env';
import { ObjectPart } from '../../s3/types';

@Injectable()
export class TelegramStorage {
  private readonly logger = new Logger(TelegramStorage.name);
  private readonly token = requiredEnv('TELEGRAM_BOT_TOKEN');
  private readonly chatId = requiredEnv('TELEGRAM_CHAT_ID');
  private readonly api = `https://api.telegram.org/bot${this.token}`;
  private readonly fileApi = `https://api.telegram.org/file/bot${this.token}`;
  private readonly maxDownloadablePartSize = 19 * 1024 * 1024;
  private readonly partSize = Math.min(Number(process.env.TELEGRAM_PART_SIZE ?? this.maxDownloadablePartSize), this.maxDownloadablePartSize);

  async put(buffer: Buffer, filename: string, contentType = 'application/octet-stream'): Promise<{ parts: ObjectPart[]; etag: string }> {
    this.logger.log(`Telegram upload started filename=${filename} bytes=${buffer.length} contentType=${contentType} partSize=${this.partSize}`);
    const startedAt = Date.now();
    const etag = createHash('md5').update(buffer).digest('hex');

    if (buffer.length === 0) {
      this.logger.log(`Telegram upload skipped for empty object filename=${filename} etag=${etag} durationMs=${Date.now() - startedAt}`);
      return { parts: [], etag };
    }

    const parts: ObjectPart[] = [];
    for (let offset = 0, index = 1; offset < buffer.length; offset += this.partSize, index++) {
      const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + this.partSize));
      this.logger.debug(`Telegram upload part started filename=${filename} part=${index} bytes=${chunk.length}`);
      const part = await this.sendDocument(chunk, `${filename}.part${index}`, contentType);
      parts.push({ ...part, size: chunk.length });
      this.logger.debug(`Telegram upload part completed filename=${filename} part=${index} bytes=${chunk.length}`);
    }

    this.logger.log(`Telegram upload completed filename=${filename} bytes=${buffer.length} parts=${parts.length} durationMs=${Date.now() - startedAt}`);
    return { parts, etag };
  }

  async read(parts: ObjectPart[]): Promise<Buffer> {
    this.logger.log(`Telegram download started parts=${parts.length}`);
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    for (const [index, part] of parts.entries()) {
      this.logger.debug(`Telegram download part started part=${index + 1} bytes=${part.size}`);
      if (part.size > this.maxDownloadablePartSize) {
        throw new Error(`Telegram part is too large to download: part=${index + 1} bytes=${part.size} maxBytes=${this.maxDownloadablePartSize}. Re-upload this object with TELEGRAM_PART_SIZE <= ${this.maxDownloadablePartSize}.`);
      }

      chunks.push(await this.download(part.fileId));
      this.logger.debug(`Telegram download part completed part=${index + 1} expectedBytes=${part.size}`);
    }

    const data = Buffer.concat(chunks);
    this.logger.log(`Telegram download completed bytes=${data.length} parts=${parts.length} durationMs=${Date.now() - startedAt}`);
    return data;
  }

  async delete(parts: ObjectPart[]) {
    this.logger.log(`Telegram delete started parts=${parts.length}`);
    const startedAt = Date.now();

    for (const [index, part] of parts.entries()) {
      if (isNotDefined(part.messageId)) {
        this.logger.warn(`Telegram delete skipped part=${index + 1} reason=missing-message-id`);
        continue;
      }

      await this.deleteMessage(part.messageId);
      this.logger.debug(`Telegram delete part completed part=${index + 1} messageId=${part.messageId}`);
    }

    this.logger.log(`Telegram delete completed parts=${parts.length} durationMs=${Date.now() - startedAt}`);
  }

  private async sendDocument(buffer: Buffer, filename: string, contentType: string) {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('disable_notification', 'true');
    form.append('caption', filename);
    form.append('document', buffer, { filename, contentType });

    try {
      const res = await axios.post(`${this.api}/sendDocument`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (res.data?.ok !== true) {
        this.logger.error(`Telegram sendDocument failed filename=${filename} response=${JSON.stringify(res.data)}`);
        throw new Error(`Telegram sendDocument failed: ${JSON.stringify(res.data)}`);
      }

      const fileId = res.data.result?.document?.file_id;
      const messageId = res.data.result?.message_id;
      if (isNotDefined(fileId)) {
        this.logger.error(`Telegram sendDocument missing file_id filename=${filename}`);
        throw new Error('Telegram did not return document.file_id');
      }

      if (isNotDefined(messageId)) {
        this.logger.error(`Telegram sendDocument missing message_id filename=${filename}`);
        throw new Error('Telegram did not return message_id');
      }

      return { fileId: fileId as string, messageId: Number(messageId) };
    } catch (error) {
      this.logger.error(`Telegram sendDocument request failed filename=${filename} bytes=${buffer.length} details=${axiosErrorDetails(error)}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  private async deleteMessage(messageId: number) {
    try {
      const res = await axios.post(`${this.api}/deleteMessage`, {
        chat_id: this.chatId,
        message_id: messageId,
      });

      if (res.data?.ok !== true) {
        this.logger.warn(`Telegram deleteMessage failed messageId=${messageId} response=${JSON.stringify(res.data)}`);
      }
    } catch (error) {
      this.logger.warn(`Telegram deleteMessage request failed messageId=${messageId} details=${axiosErrorDetails(error)}`);
    }
  }

  private async download(fileId: string): Promise<Buffer> {
    try {
      const file = await axios.get(`${this.api}/getFile`, { params: { file_id: fileId } });
      const filePath = file.data?.result?.file_path;
      if (file.data?.ok !== true || isNotDefined(filePath)) {
        this.logger.error(`Telegram getFile failed response=${JSON.stringify(file.data)}`);
        throw new Error(`Telegram getFile failed: ${JSON.stringify(file.data)}`);
      }

      const res = await axios.get(`${this.fileApi}/${filePath}`, { responseType: 'arraybuffer' });
      return Buffer.from(res.data);
    } catch (error) {
      this.logger.error(`Telegram download request failed details=${axiosErrorDetails(error)}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }
}

function axiosErrorDetails(error: unknown) {
  if (axios.isAxiosError(error)) {
    return JSON.stringify({ status: error.response?.status, data: error.response?.data });
  }

  return '';
}
