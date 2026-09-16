import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VIDEO_PROCESS_QUEUE, VideoProcessJob } from '../videos/videos.queue';

@Processor(VIDEO_PROCESS_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJob>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(
        `video ${videoId} not found — job ${job.id} dropped (row deleted after enqueue?)`,
      );
      return;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
    const videoPath = join(tempDir, 'input');

    try {
      await this.storageService.downloadObject(
        video.object_key as string,
        videoPath,
      );
      const { duration, metadata } = await this.probe(videoPath);
      const thumbnailPath = await this.generateThumbnail(videoPath, tempDir);

      const thumbnailKey = `videos/${video.slug}/thumbnail.jpg`;
      await this.storageService.uploadObject(thumbnailKey, thumbnailPath);

      video.status = VideoStatus.READY;
      video.duration_seconds = duration;
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      await this.videoRepository.save(video);
    } catch (err) {
      video.status = VideoStatus.ERROR;
      video.failure_reason = (err as Error).message;
      await this.videoRepository.save(video);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private probe(
    filePath: string,
  ): Promise<{ duration: number; metadata: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err as Error);
          return;
        }
        const videoStream = metadata.streams?.find(
          (s) => s.codec_type === 'video',
        );
        const result: Record<string, unknown> = {
          codec_name: videoStream?.codec_name,
          width: videoStream?.width,
          height: videoStream?.height,
          bit_rate: metadata.format?.bit_rate,
        };
        resolve({
          duration: Math.round(metadata.format?.duration ?? 0),
          metadata: result,
        });
      });
    });
  }

  private generateThumbnail(
    filePath: string,
    outputDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let generated: string | undefined;
      ffmpeg(filePath)
        .screenshots({
          count: 1,
          timemarks: ['00:00:01'],
          filename: 'thumbnail.jpg',
          folder: outputDir,
          size: '640x?',
        })
        .on('filenames', (filenames: string[]) => {
          if (filenames.length > 0) {
            generated = join(outputDir, filenames[0]);
          }
        })
        .on('end', () => {
          if (generated) resolve(generated);
          else reject(new Error('No thumbnail generated'));
        })
        .on('error', (err) => reject(err));
    });
  }
}
