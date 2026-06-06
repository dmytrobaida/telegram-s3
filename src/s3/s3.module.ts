import { Module } from '@nestjs/common';
import { MetadataModule } from '../storage/metadata/metadata.module';
import { TelegramModule } from '../storage/telegram/telegram.module';
import { S3AuthService } from './s3-auth.service';
import { S3Controller } from './s3.controller';

@Module({
  imports: [MetadataModule, TelegramModule],
  controllers: [S3Controller],
  providers: [S3AuthService],
})
export class S3Module {}
