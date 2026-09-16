import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { VideoProcessJob } from './videos.queue';
import { VideosQueueService } from './videos-queue.service';

// Use a dedicated queue name so the production video-worker (which consumes
// `video.process`) does not steal jobs while the test asserts them.
const TEST_QUEUE_NAME = `video.process.test-${process.pid}`;

describe('VideosQueueService (integration)', () => {
  let service: VideosQueueService;
  let queue: Queue<VideoProcessJob>;
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    });
    queue = new Queue<VideoProcessJob>(TEST_QUEUE_NAME, {
      connection: redis,
    });
    service = new VideosQueueService(queue);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    redis.disconnect();
  });

  beforeEach(async () => {
    await queue.drain(true);
  });

  it('enqueues a job with the videoId payload', async () => {
    await service.addProcessJob('video-123');

    const jobs = await queue.getWaiting();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: 'video-123' });
  });

  it('configures retry attempts with exponential backoff', async () => {
    await service.addProcessJob('video-456');

    const job = (await queue.getWaiting())[0];
    expect(job.opts.attempts).toBe(5);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });
});
