import { Module } from '@nestjs/common';
import { TelegramStorage } from './telegram.storage';

@Module({
  providers: [TelegramStorage],
  exports: [TelegramStorage],
})
export class TelegramModule {}
