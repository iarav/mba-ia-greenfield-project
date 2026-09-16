import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './exceptions/video.exceptions';
import { StorageService } from './storage.service';
import { VideoStatus } from './video-status.enum';
import { VideosQueueService } from './videos-queue.service';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let channelRepository: jest.Mocked<Repository<Channel>>;
  let storageService: jest.Mocked<StorageService>;
  let videosQueueService: jest.Mocked<VideosQueueService>;

  const channel = { id: 'channel-1', user_id: 'user-1' } as Channel;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOneBy: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: { findOneBy: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn(),
            presignUploadPart: jest.fn(),
            completeMultipartUpload: jest.fn(),
          },
        },
        {
          provide: VideosQueueService,
          useValue: { addProcessJob: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    channelRepository = module.get(getRepositoryToken(Channel));
    storageService = module.get(StorageService);
    videosQueueService = module.get(VideosQueueService);
  });

  it('creates a draft with a presigned URL per part', async () => {
    channelRepository.findOneBy.mockResolvedValue(channel);
    videoRepository.findOneBy.mockResolvedValue(null);
    videoRepository.create.mockImplementation((v) => v as Video);
    videoRepository.save.mockImplementation((v) => Promise.resolve(v as Video));
    storageService.createMultipartUpload.mockResolvedValue('upload-1');
    storageService.presignUploadPart.mockResolvedValue('https://presigned/1');

    const dto: CreateVideoDto = { title: 'Hello', file_size: 1000 };
    const result = await service.createDraft(dto, 'user-1');

    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.upload_id).toBe('upload-1');
    expect(result.parts).toHaveLength(1);
    expect(result.slug).toMatch(/^[a-z0-9]{11}$/);
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${result.slug}/original`,
    );
  });

  it('retries slug generation on collision', async () => {
    channelRepository.findOneBy.mockResolvedValue(channel);
    videoRepository.findOneBy
      .mockResolvedValueOnce({ id: 'existing' } as Video)
      .mockResolvedValueOnce(null);
    videoRepository.create.mockImplementation((v) => v as Video);
    videoRepository.save.mockImplementation((v) => Promise.resolve(v as Video));
    storageService.createMultipartUpload.mockResolvedValue('upload-1');
    storageService.presignUploadPart.mockResolvedValue('https://presigned/1');

    const dto: CreateVideoDto = { title: 'Hello', file_size: 1000 };
    await service.createDraft(dto, 'user-1');

    expect(videoRepository.findOneBy).toHaveBeenCalledTimes(2);
  });

  it('throws VideoNotFoundException when completing a missing video', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      service.completeUpload(
        'missing',
        { upload_id: 'u', parts: [] },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('throws VideoNotOwnedException when the video belongs to another channel', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'v1',
      channel_id: 'other-channel',
      status: VideoStatus.DRAFT,
      object_key: 'videos/x/original',
    } as Video);
    channelRepository.findOneBy.mockResolvedValue(channel);

    await expect(
      service.completeUpload('v1', { upload_id: 'u', parts: [] }, 'user-1'),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
  });

  it('throws VideoNotDraftException when the video is not a draft', async () => {
    videoRepository.findOneBy.mockResolvedValue({
      id: 'v1',
      channel_id: 'channel-1',
      status: VideoStatus.PROCESSING,
      object_key: 'videos/x/original',
    } as Video);
    channelRepository.findOneBy.mockResolvedValue(channel);

    await expect(
      service.completeUpload('v1', { upload_id: 'u', parts: [] }, 'user-1'),
    ).rejects.toBeInstanceOf(VideoNotDraftException);
  });

  it('completes the upload, transitions to processing, and enqueues', async () => {
    const video = {
      id: 'v1',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      object_key: 'videos/x/original',
    } as Video;
    videoRepository.findOneBy.mockResolvedValue(video);
    channelRepository.findOneBy.mockResolvedValue(channel);
    videoRepository.save.mockResolvedValue(video);
    storageService.completeMultipartUpload.mockResolvedValue(undefined);

    const result = await service.completeUpload(
      'v1',
      { upload_id: 'upload-1', parts: [{ part_number: 1, etag: 'e1' }] },
      'user-1',
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/x/original',
      'upload-1',
      [{ ETag: 'e1', PartNumber: 1 }],
    );
    expect(videosQueueService.addProcessJob).toHaveBeenCalledWith('v1');
  });
});
