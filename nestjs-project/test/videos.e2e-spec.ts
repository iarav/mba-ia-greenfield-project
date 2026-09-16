import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { AppModule } from '../src/app.module';
import { StorageService } from '../src/videos/storage.service';
import { VideosQueueService } from '../src/videos/videos-queue.service';
import { VideoStatus } from '../src/videos/video-status.enum';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;
  let videosQueueService: VideosQueueService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
    videosQueueService = moduleFixture.get(VideosQueueService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "refresh_tokens"');
    await dataSource.query('DELETE FROM "verification_tokens"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
    throttlerStorage.storage.clear();
  });

  let emailCounter = 0;

  async function registerConfirmAndLogin(
    password = 'password123',
  ): Promise<{ access_token: string }> {
    const email = `video_${++emailCounter}@example.com`;
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as {
        mailService: { sendConfirmationEmail: jest.Mock };
      }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return { access_token: loginRes.body.access_token as string };
  }

  describe('POST /videos', () => {
    it('returns 201 with a draft and presigned parts for an authenticated user', async () => {
      const { access_token } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'My Video', file_size: 1024 })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toMatch(/^[a-z0-9]{11}$/);
      expect(res.body.status).toBe('draft');
      expect(res.body.upload_id).toBeDefined();
      expect(res.body.parts).toHaveLength(1);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'X', file_size: 1024 })
        .expect(401);
    });

    it('returns 400 when file_size is missing', async () => {
      const { access_token } = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'X' })
        .expect(400);
    });
  });

  describe('GET /videos/:slug/metadata', () => {
    it('returns 200 with the video metadata', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Metadata Video', file_size: 1024 });

      const res = await request(app.getHttpServer())
        .get(`/videos/${created.body.slug}/metadata`)
        .expect(200);

      expect(res.body.title).toBe('Metadata Video');
      expect(res.body.status).toBe('draft');
    });

    it('returns 404 for a non-existent slug', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent123/metadata')
        .expect(404);
    });
  });

  describe('GET /videos/:slug', () => {
    it('returns 409 for a video that is not ready', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Not Ready', file_size: 1024 });

      await request(app.getHttpServer())
        .get(`/videos/${created.body.slug}`)
        .expect(409);
    });

    it('returns 404 for a non-existent slug', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent456')
        .expect(404);
    });

    it('redirects with 302 to the presigned URL when the video is ready', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Ready Video', file_size: 1024 });

      await dataSource.query(
        'UPDATE "videos" SET "status" = $1 WHERE "slug" = $2',
        [VideoStatus.READY, created.body.slug],
      );

      const presignSpy = jest
        .spyOn(storageService, 'presignGetObject')
        .mockResolvedValueOnce('https://storage.example/streaming');

      const res = await request(app.getHttpServer())
        .get(`/videos/${created.body.slug}`)
        .expect(302);

      expect(res.header.location).toBe('https://storage.example/streaming');
      expect(presignSpy).toHaveBeenCalledWith(expect.any(String), {
        asAttachment: false,
      });
    });

    it('forwards download=true so the presigned URL carries an attachment disposition', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Download Video', file_size: 1024 });

      await dataSource.query(
        'UPDATE "videos" SET "status" = $1 WHERE "slug" = $2',
        [VideoStatus.READY, created.body.slug],
      );

      const presignSpy = jest
        .spyOn(storageService, 'presignGetObject')
        .mockResolvedValueOnce('https://storage.example/download');

      await request(app.getHttpServer())
        .get(`/videos/${created.body.slug}`)
        .query({ download: 'true' })
        .expect(302);

      expect(presignSpy).toHaveBeenCalledWith(expect.any(String), {
        asAttachment: true,
      });
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/some-id/complete')
        .send({ upload_id: 'u', parts: [] })
        .expect(401);
    });

    it('returns 404 for a non-existent video', async () => {
      const { access_token } = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ upload_id: 'u', parts: [] })
        .expect(404);
    });

    it('returns 200, transitions to processing and enqueues the job on the happy path', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Happy Path', file_size: 1024 });

      const completeSpy = jest
        .spyOn(storageService, 'completeMultipartUpload')
        .mockResolvedValueOnce(undefined);
      const enqueueSpy = jest
        .spyOn(videosQueueService, 'addProcessJob')
        .mockResolvedValueOnce(undefined);

      const res = await request(app.getHttpServer())
        .post(`/videos/${created.body.id}/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          upload_id: created.body.upload_id,
          parts: [{ part_number: 1, etag: 'etag-1' }],
        })
        .expect(200);

      expect(res.body.status).toBe(VideoStatus.PROCESSING);
      expect(completeSpy).toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledWith(created.body.id);
    });

    it('returns 403 when completing a video owned by another user', async () => {
      const owner = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.access_token}`)
        .send({ title: 'Someone Else Video', file_size: 1024 });

      const intruder = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post(`/videos/${created.body.id}/complete`)
        .set('Authorization', `Bearer ${intruder.access_token}`)
        .send({
          upload_id: created.body.upload_id,
          parts: [{ part_number: 1, etag: 'etag-1' }],
        })
        .expect(403);
    });

    it('returns 409 when the video is not in draft anymore', async () => {
      const { access_token } = await registerConfirmAndLogin();
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Already Processing', file_size: 1024 });

      await dataSource.query(
        'UPDATE "videos" SET "status" = $1 WHERE "id" = $2',
        [VideoStatus.PROCESSING, created.body.id],
      );

      await request(app.getHttpServer())
        .post(`/videos/${created.body.id}/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          upload_id: created.body.upload_id,
          parts: [{ part_number: 1, etag: 'etag-1' }],
        })
        .expect(409);
    });
  });
});
