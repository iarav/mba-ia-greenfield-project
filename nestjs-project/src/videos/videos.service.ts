import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { customAlphabet } from 'nanoid';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import {
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { StorageService } from './storage.service';
import { VideoStatus } from './video-status.enum';
import { VideosQueueService } from './videos-queue.service';

const DEFAULT_PART_SIZE = 104857600; // 100MB
const SLUG_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SLUG_LENGTH = 11;
const generateSlug = customAlphabet(SLUG_ALPHABET, SLUG_LENGTH);

export interface CreateVideoResponse {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  upload_id: string;
  parts: Array<{ part_number: number; url: string }>;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videosQueueService: VideosQueueService,
  ) {}

  async createDraft(
    dto: CreateVideoDto,
    userId: string,
  ): Promise<CreateVideoResponse> {
    const channel = await this.findChannelForUser(userId);
    const slug = await this.generateUniqueSlug();
    const objectKey = `videos/${slug}/original`;

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        slug,
        title: dto.title,
        description: dto.description ?? null,
        status: VideoStatus.DRAFT,
        channel_id: channel.id,
        object_key: objectKey,
      }),
    );

    const uploadId = await this.storageService.createMultipartUpload(objectKey);
    const partSize = dto.part_size ?? DEFAULT_PART_SIZE;
    const partCount = Math.max(1, Math.ceil(dto.file_size / partSize));

    const parts: Array<{ part_number: number; url: string }> = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          objectKey,
          uploadId,
          partNumber,
        ),
      });
    }

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      upload_id: uploadId,
      parts,
    };
  }

  async completeUpload(
    id: string,
    dto: CompleteUploadDto,
    userId: string,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.videoRepository.findOneBy({ id });
    if (!video) throw new VideoNotFoundException();

    const channel = await this.findChannelForUser(userId);
    if (video.channel_id !== channel.id) throw new VideoNotOwnedException();
    if (video.status !== VideoStatus.DRAFT) throw new VideoNotDraftException();

    await this.storageService.completeMultipartUpload(
      video.object_key as string,
      dto.upload_id,
      dto.parts.map((p) => ({ ETag: p.etag, PartNumber: p.part_number })),
    );

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);
    await this.videosQueueService.addProcessJob(video.id);

    return { id: video.id, status: video.status };
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ slug });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async stream(slug: string, download: boolean): Promise<string> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return this.storageService.presignGetObject(video.object_key as string, {
      asAttachment: download,
    });
  }

  private async findChannelForUser(userId: string): Promise<Channel> {
    const channel = await this.channelRepository.findOneBy({ user_id: userId });
    if (!channel) throw new VideoNotOwnedException();
    return channel;
  }

  private async generateUniqueSlug(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = generateSlug();
      const existing = await this.videoRepository.findOneBy({ slug });
      if (!existing) return slug;
    }
    throw new Error('Could not generate a unique video slug after retries');
  }
}
