import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_PROCESS_QUEUE, VideoProcessJob } from './videos.queue';

@Injectable()
export class VideosQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESS_QUEUE)
    private readonly queue: Queue<VideoProcessJob>,
  ) {}

  async addProcessJob(videoId: string): Promise<void> {
    await this.queue.add(
      'process',
      { videoId },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        // Keep the queue lean: retain a bounded history for observability
        // and let BullMQ evict the rest.
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
  }
}
