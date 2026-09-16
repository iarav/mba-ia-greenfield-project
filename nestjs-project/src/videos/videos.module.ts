import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { StorageModule } from './storage.module';
import { VideosController } from './videos.controller';
import { VIDEO_PROCESS_QUEUE } from './videos.queue';
import { VideosQueueService } from './videos-queue.service';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESS_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService, VideosQueueService],
  exports: [TypeOrmModule, VideosService, VideosQueueService],
})
export class VideosModule {}
