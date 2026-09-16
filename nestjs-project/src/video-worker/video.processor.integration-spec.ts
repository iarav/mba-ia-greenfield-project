import type { ConfigType } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessor } from './video.processor';

const TEST_CONFIG: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'streamtube-test',
  forcePathStyle: true,
  presignedUrlExpires: 3600,
};

function generateTestVideo(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('color=c=black:s=320x240:d=2')
      .inputFormat('lavfi')
      .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err));
  });
}

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let processor: VideoProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageService = new StorageService(TEST_CONFIG);
    await storageService.ensureBucket();
    processor = new VideoProcessor(videoRepository, storageService);
  });

  afterAll(async () => {
    storageService.onModuleDestroy();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `proc_${++counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `proc${counter}${Date.now()}`,
        user_id: user.id,
      }),
    );
  }

  it('processes a video: extracts duration, generates thumbnail, sets ready', async () => {
    const channel = await createChannel();
    const tempDir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
    const videoPath = join(tempDir, 'input.mp4');

    await generateTestVideo(videoPath);
    const objectKey = `videos/proc-${counter}/original`;
    await storageService.uploadObject(objectKey, videoPath);
    await rm(tempDir, { recursive: true, force: true });

    const video = await videoRepository.save(
      videoRepository.create({
        slug: `procslug${counter}`,
        title: 'Processed',
        status: VideoStatus.DRAFT,
        channel_id: channel.id,
        object_key: objectKey,
      }),
    );

    await processor.process({ data: { videoId: video.id } } as never);

    const processed = await videoRepository.findOneBy({ id: video.id });
    expect(processed!.status).toBe(VideoStatus.READY);
    expect(processed!.duration_seconds).toBe(2);
    expect(processed!.thumbnail_key).toBe(
      `videos/procslug${counter}/thumbnail.jpg`,
    );
    expect(processed!.metadata).toMatchObject({ codec_name: 'h264' });
    expect(processed!.failure_reason).toBeNull();
  });

  it('sets error status with a failure reason when processing fails', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        slug: `bogus${counter}`,
        title: 'Bogus',
        status: VideoStatus.DRAFT,
        channel_id: channel.id,
        object_key: 'videos/does-not-exist/original',
      }),
    );

    await processor.process({ data: { videoId: video.id } } as never);

    const processed = await videoRepository.findOneBy({ id: video.id });
    expect(processed!.status).toBe(VideoStatus.ERROR);
    expect(processed!.failure_reason).toBeTruthy();
  });
});
