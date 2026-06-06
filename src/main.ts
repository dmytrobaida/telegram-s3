import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { createRawBodyMiddleware } from './common/raw-body.middleware';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const rawBodyLimit = process.env.MAX_OBJECT_SIZE ?? '200mb';

  logger.log(`Configuring raw body middleware limit=${rawBodyLimit}`);
  app.use(createRawBodyMiddleware(rawBodyLimit));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Telegram S3 server listening on port=${port}`);
}

void bootstrap();
