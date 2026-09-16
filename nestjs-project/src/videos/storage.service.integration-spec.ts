import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

// Both endpoints resolve to the Compose service so the test can actually reach
// MinIO from inside the container (the browser-facing public endpoint is only
// meaningful outside the Compose network).
const TEST_CONFIG: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'streamtube-test',
  forcePathStyle: true,
  presignedUrlExpires: 3600,
};

describe('StorageService (integration)', () => {
  let storageService: StorageService;
  let keyCounter = 0;
  const uniqueKey = () => `videos/test/key-${++keyCounter}`;

  beforeAll(async () => {
    storageService = new StorageService(TEST_CONFIG);
    await storageService.ensureBucket();
  });

  afterAll(() => {
    storageService.onModuleDestroy();
  });

  it('creates and completes a multipart upload producing an intact object', async () => {
    const key = uniqueKey();
    const content = 'hello-multipart-streamtube';

    const uploadId = await storageService.createMultipartUpload(key);
    expect(uploadId).toBeTruthy();

    const putUrl = await storageService.presignUploadPart(key, uploadId, 1);
    const putRes = await fetch(putUrl, { method: 'PUT', body: content });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { ETag: etag as string, PartNumber: 1 },
    ]);

    const getUrl = await storageService.presignGetObject(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(content);
  });

  it('presignGetObject with asAttachment adds the content-disposition', async () => {
    const key = uniqueKey();
    const uploadId = await storageService.createMultipartUpload(key);
    const putUrl = await storageService.presignUploadPart(key, uploadId, 1);
    const putRes = await fetch(putUrl, { method: 'PUT', body: 'x' });
    await storageService.completeMultipartUpload(key, uploadId, [
      { ETag: putRes.headers.get('etag') as string, PartNumber: 1 },
    ]);

    const url = await storageService.presignGetObject(key, {
      asAttachment: true,
    });
    expect(url).toContain('response-content-disposition=');
  });

  it('throws StorageException when completing an unknown upload', async () => {
    await expect(
      storageService.completeMultipartUpload(uniqueKey(), 'unknown-upload-id', [
        { ETag: 'bogus', PartNumber: 1 },
      ]),
    ).rejects.toMatchObject({ errorCode: 'STORAGE_ERROR' });
  });
});
