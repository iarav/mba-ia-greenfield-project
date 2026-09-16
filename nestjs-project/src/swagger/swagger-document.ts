import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from '../videos/dto/complete-upload-response.dto';
import {
  CreateVideoResponseDto,
  UploadPartDto,
} from '../videos/dto/create-video-response.dto';
import { VideoMetadataResponseDto } from '../videos/dto/video-metadata-response.dto';

export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('StreamTube API')
    .setDescription('API REST do StreamTube')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();
}

export function buildSwaggerDocument(app: INestApplication) {
  return SwaggerModule.createDocument(app, buildSwaggerConfig(), {
    extraModels: [
      ApiErrorEnvelope,
      CreateVideoResponseDto,
      UploadPartDto,
      CompleteUploadResponseDto,
      VideoMetadataResponseDto,
    ],
  });
}
