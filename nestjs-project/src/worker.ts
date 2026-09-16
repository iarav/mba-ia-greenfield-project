import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './video-worker/video-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  await app.init();
}

void bootstrap();
