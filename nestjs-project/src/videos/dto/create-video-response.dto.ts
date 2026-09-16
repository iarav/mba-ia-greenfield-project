import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class UploadPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    example: 'https://minio.local/streamtube/videos/abc/original?...',
    description: 'Presigned PUT URL for this part.',
  })
  url: string;
}

export class CreateVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'abc12345xyz' })
  slug: string;

  @ApiProperty({ example: 'My Video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    description: 'Multipart upload id for the presigned session.',
  })
  upload_id: string;

  @ApiProperty({ type: [UploadPartDto] })
  parts: UploadPartDto[];
}
