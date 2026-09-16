import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { StorageException } from './exceptions/video.exceptions';

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly presignedUrlExpires: number;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.presignedUrlExpires = config.presignedUrlExpires;

    // Internal client reaches storage inside the Compose network.
    this.internalClient = this.buildClient(config.endpoint, config);
    // Presign client signs URLs for the publicly reachable endpoint (browser).
    this.presignClient = this.buildClient(config.publicEndpoint, config);
  }

  private buildClient(
    endpoint: string,
    config: ConfigType<typeof storageConfig>,
  ): S3Client {
    return new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.presignClient.destroy();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      // BucketAlreadyOwnedByYou / BucketAlreadyExists are not errors here.
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw new StorageException(
          `Failed to ensure bucket: ${(err as Error).message}`,
        );
      }
    }
  }

  async createMultipartUpload(key: string): Promise<string> {
    try {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.UploadId) {
        throw new StorageException('Storage did not return an UploadId');
      }
      return result.UploadId;
    } catch (err) {
      if (err instanceof StorageException) throw err;
      throw new StorageException(
        `Failed to create multipart upload: ${(err as Error).message}`,
      );
    }
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    try {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      return await getSignedUrl(this.presignClient, command, {
        expiresIn: this.presignedUrlExpires,
      });
    } catch (err) {
      throw new StorageException(
        `Failed to presign upload part: ${(err as Error).message}`,
      );
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      throw new StorageException(
        `Failed to complete multipart upload: ${(err as Error).message}`,
      );
    }
  }

  async presignGetObject(
    key: string,
    options: { asAttachment?: boolean } = {},
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.asAttachment
          ? {
              ResponseContentDisposition: `attachment; filename="${key.split('/').pop() ?? 'video'}"`,
            }
          : {}),
      });
      return await getSignedUrl(this.presignClient, command, {
        expiresIn: this.presignedUrlExpires,
      });
    } catch (err) {
      throw new StorageException(
        `Failed to presign get object: ${(err as Error).message}`,
      );
    }
  }

  async downloadObject(key: string, destinationPath: string): Promise<void> {
    try {
      const result = await this.internalClient.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      await pipeline(
        result.Body as Readable,
        createWriteStream(destinationPath),
      );
    } catch (err) {
      throw new StorageException(
        `Failed to download object: ${(err as Error).message}`,
      );
    }
  }

  async uploadObject(key: string, sourcePath: string): Promise<void> {
    try {
      const body = await readFile(sourcePath);
      await this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
        }),
      );
    } catch (err) {
      throw new StorageException(
        `Failed to upload object: ${(err as Error).message}`,
      );
    }
  }
}
