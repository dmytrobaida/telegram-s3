import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import FormData from 'form-data';
import { isNotDefined } from '../../common/assertions';
import { requiredEnv } from '../../common/env';
import { ObjectPart } from '../../s3/types';

@Injectable()
export class TelegramStorage {
  private readonly token = requiredEnv('TELEGRAM_BOT_TOKEN');
  private readonly chatId = requiredEnv('TELEGRAM_CHAT_ID');
  private readonly api = `https://api.telegram.org/bot${this.token}`;
  private readonly fileApi = `https://api.telegram.org/file/bot${this.token}`;
  private readonly partSize = Number(process.env.TELEGRAM_PART_SIZE ?? 45 * 1024 * 1024);

  async put(buffer: Buffer, filename: string, contentType = 'application/octet-stream'): Promise<{ parts: ObjectPart[]; etag: string }> {
    const parts: ObjectPart[] = [];
    for (let offset = 0, index = 1; offset < buffer.length || (buffer.length === 0 && index === 1); offset += this.partSize, index++) {
      const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + this.partSize));
      const fileId = await this.sendDocument(chunk, `${filename}.part${index}`, contentType);
      parts.push({ fileId, size: chunk.length });

      if (buffer.length === 0) {
        break;
      }
    }

    return { parts, etag: createHash('md5').update(buffer).digest('hex') };
  }

  async read(parts: ObjectPart[]): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (const part of parts) {
      chunks.push(await this.download(part.fileId));
    }

    return Buffer.concat(chunks);
  }

  private async sendDocument(buffer: Buffer, filename: string, contentType: string) {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('disable_notification', 'true');
    form.append('caption', filename);
    form.append('document', buffer, { filename, contentType });

    const res = await axios.post(`${this.api}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (res.data?.ok !== true) {
      throw new Error(`Telegram sendDocument failed: ${JSON.stringify(res.data)}`);
    }

    const fileId = res.data.result?.document?.file_id;
    if (isNotDefined(fileId)) {
      throw new Error('Telegram did not return document.file_id');
    }

    return fileId as string;
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = await axios.get(`${this.api}/getFile`, { params: { file_id: fileId } });
    const filePath = file.data?.result?.file_path;
    if (file.data?.ok !== true || isNotDefined(filePath)) {
      throw new Error(`Telegram getFile failed: ${JSON.stringify(file.data)}`);
    }

    const res = await axios.get(`${this.fileApi}/${filePath}`, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  }
}
