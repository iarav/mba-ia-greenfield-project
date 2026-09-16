import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
  bucket: process.env.S3_BUCKET || 'streamtube',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  presignedUrlExpires: parseInt(
    process.env.S3_PRESIGNED_URL_EXPIRES || '3600',
    10,
  ),
}));
