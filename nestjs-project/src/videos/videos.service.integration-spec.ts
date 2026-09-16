import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import {
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { StorageService } from './storage.service';
import { VideoStatus } from './video-status.enum';
import { VideosQueueService } from './videos-queue.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const storageService = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn().mockResolvedValue('https://presigned/1'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    presignGetObject: jest.fn().mockResolvedValue('https://presigned/get'),
  };
  const videosQueueService = {
    addProcessJob: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    service = new VideosService(
      videoRepository,
      channelRepository,
      storageService as unknown as StorageService,
      videosQueueService as unknown as VideosQueueService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserAndChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videosvc_${++counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidsvc${counter}${Date.now()}`,
        user_id: user.id,
      }),
    );
  }

  it('createDraft persists a draft video with a slug and object key', async () => {
    const channel = await createUserAndChannel();

    const result = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      channel.user_id,
    );

    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.slug).toMatch(/^[a-z0-9]{11}$/);

    const persisted = await videoRepository.findOneBy({ slug: result.slug });
    expect(persisted).not.toBeNull();
    expect(persisted!.channel_id).toBe(channel.id);
    expect(persisted!.status).toBe(VideoStatus.DRAFT);
    expect(persisted!.object_key).toBe(`videos/${result.slug}/original`);
  });

  it('completeUpload transitions to processing and enqueues a job', async () => {
    const channel = await createUserAndChannel();
    const { id } = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      channel.user_id,
    );

    const result = await service.completeUpload(
      id,
      { upload_id: 'upload-1', parts: [{ part_number: 1, etag: 'e1' }] },
      channel.user_id,
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const persisted = await videoRepository.findOneBy({ id });
    expect(persisted!.status).toBe(VideoStatus.PROCESSING);
    expect(videosQueueService.addProcessJob).toHaveBeenCalledWith(id);
  });

  it('completeUpload rejects a video owned by another channel', async () => {
    const owner = await createUserAndChannel();
    const other = await createUserAndChannel();
    const { id } = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      owner.user_id,
    );

    await expect(
      service.completeUpload(
        id,
        { upload_id: 'upload-1', parts: [{ part_number: 1, etag: 'e1' }] },
        other.user_id,
      ),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
  });

  it('findBySlug returns the video for an existing slug', async () => {
    const channel = await createUserAndChannel();
    const { slug } = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      channel.user_id,
    );

    const video = await service.findBySlug(slug);
    expect(video.title).toBe('Hello');
  });

  it('stream returns the presigned URL for a ready video', async () => {
    const channel = await createUserAndChannel();
    const { slug } = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      channel.user_id,
    );
    await videoRepository.update(
      { slug },
      { status: VideoStatus.READY, object_key: `videos/${slug}/original` },
    );

    const url = await service.stream(slug, false);
    expect(url).toBe('https://presigned/get');
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      `videos/${slug}/original`,
      { asAttachment: false },
    );
  });

  it('stream throws VideoNotReadyException for a draft video', async () => {
    const channel = await createUserAndChannel();
    const { slug } = await service.createDraft(
      { title: 'Hello', file_size: 1024 },
      channel.user_id,
    );

    await expect(service.stream(slug, false)).rejects.toBeInstanceOf(
      VideoNotReadyException,
    );
  });
});
