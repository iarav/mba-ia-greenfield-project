import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  CreateVideoResponseDto,
  UploadPartDto,
} from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoMetadataResponseDto } from './dto/video-metadata-response.dto';
import { CreateVideoResponse, VideosService } from './videos.service';

@ApiTags('videos')
@ApiExtraModels(
  CreateVideoResponseDto,
  UploadPartDto,
  CompleteUploadResponseDto,
  VideoMetadataResponseDto,
)
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft',
    description:
      'Creates a draft video and starts a multipart upload, returning a presigned URL per part. The client uploads parts directly to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created with presigned upload parts',
    schema: { $ref: getSchemaPath(CreateVideoResponseDto) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponse> {
    return this.videosService.createDraft(dto, user.sub);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Completes the multipart upload, transitions the video to processing, and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: { $ref: getSchemaPath(CompleteUploadResponseDto) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video does not belong to the authenticated channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(id, dto, user.sub);
  }

  @Public()
  @Get(':slug')
  @Redirect()
  @ApiOperation({
    summary: 'Stream or download a video',
    description:
      'Redirects to a presigned storage URL. Supports Range-based streaming; pass `download=true` for an attachment disposition.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for streaming',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.stream(slug, download === 'true');
    return { url, statusCode: 302 };
  }

  @Public()
  @Get(':slug/metadata')
  @ApiOperation({
    summary: 'Get video metadata',
    description: "Returns a video's title, status, duration and metadata.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: { $ref: getSchemaPath(VideoMetadataResponseDto) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async metadata(
    @Param('slug') slug: string,
  ): Promise<VideoMetadataResponseDto> {
    const video = await this.videosService.findBySlug(slug);
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
    };
  }
}
