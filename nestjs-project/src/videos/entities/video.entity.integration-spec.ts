import { DataSource, Repository } from 'typeorm';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../video-status.enum';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidchan${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function videoPayload(channel: Channel, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      slug: 'abc123def45',
      title: 'My Video',
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      ...overrides,
    });
  }

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(videoPayload(channel, { slug: 'dupeslug123' }));

    await expect(
      videoRepository.save(videoPayload(channel, { slug: 'dupeslug123' })),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'enumtest123',
          title: 'Video',
          status: 'bogus' as VideoStatus,
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default nullable fields to null', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(videoPayload(channel));

    expect(video.description).toBeNull();
    expect(video.object_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.failure_reason).toBeNull();
  });

  it('should enforce FK to channel (rejects missing channel)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'nofkchannel',
          title: 'Video',
          status: VideoStatus.DRAFT,
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should persist metadata jsonb and duration', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoPayload(channel, {
        duration_seconds: 125,
        metadata: { codec_name: 'h264', width: 1920, height: 1080 },
      }),
    );

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found?.duration_seconds).toBe(125);
    expect(found?.metadata).toEqual({
      codec_name: 'h264',
      width: 1920,
      height: 1080,
    });
  });
});
