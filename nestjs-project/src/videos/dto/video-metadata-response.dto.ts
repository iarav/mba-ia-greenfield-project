import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoMetadataResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'abc12345xyz' })
  slug: string;

  @ApiProperty({ example: 'My Video' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({
    nullable: true,
    required: false,
    example: 42,
    description: 'Video duration in seconds; null until processing completes.',
  })
  duration_seconds: number | null;

  @ApiProperty({
    nullable: true,
    required: false,
    type: Object,
    description:
      'ffprobe-derived metadata (codec_name, width, height, bit_rate); null until processing completes.',
  })
  metadata: Record<string, unknown> | null;
}
