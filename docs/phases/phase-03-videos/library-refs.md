---
libs:
  bullmq:
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-31T21:55:00-0300"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-08-31T21:55:00-0300"
  ioredis:
    version: "^5.4.x"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-08-31T21:55:00-0300"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T21:55:00-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T21:55:00-0300"
  "@aws-sdk/lib-storage":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T21:55:00-0300"
  fluent-ffmpeg:
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-08-31T21:55:00-0300"
  nanoid:
    version: "^3.3.19"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-08-31T21:55:00-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T21:52:41-0300"
---

# Library References — Phase 03 (Videos)

Documentação destilada (via Context7) das bibliotecas decididas na fase, focada nas superfícies que a implementação usa.

## bullmq

Fila Redis com suporte a retry, backoff, concurrency e stalled-job detection.

- **Worker** (consome a fila): `new Worker(queueName, async (job) => {...}, { connection, concurrency })`. O `connection` é um `IORedis` com `maxRetriesPerRequest: null`.
- **Retry/backoff**: no `JobOptions` ao adicionar — `attempts: 5`, `backoff: { type: 'exponential', delay: 1000 }`.
- **WorkerOptions**: `concurrency` (paralelismo), `maxStalledCount`, `lockDuration` (30s default), `stalledInterval`.

## @nestjs/bullmq

Wrapper NestJS para o BullMQ.

- **Registro global**: `BullModule.forRootAsync({ imports: [ConfigModule], inject: [...], useFactory: (cfg) => ({ connection: { host, port } }) })`.
- **Registrar fila**: `BullModule.registerQueue({ name: 'videos' })` no módulo produtor/consumidor.
- **Produtor**: `constructor(@InjectQueue('videos') private videosQueue: Queue) {}` → `await this.videosQueue.add('process-video', { videoId }, { attempts, backoff })`.
- **Consumidor**: `@Processor('videos') export class VideoProcessor extends WorkerHost { async process(job: Job) {...} }`.

## ioredis

Client Redis robusto (o BullMQ o usa por baixo).

- `const connection = new IORedis({ maxRetriesPerRequest: null })` — o `maxRetriesPerRequest: null` é obrigatório para o BullMQ.

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner + @aws-sdk/lib-storage

SDK AWS v3 para falar com MinIO (endpoint local, `forcePathStyle: true`) e S3 em produção.

- **Cliente**: `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`.
- **Presigned URL**: `import { getSignedUrl } from '@aws-sdk/s3-request-presigner'; await getSignedUrl(client, new PutObjectCommand({Bucket, Key}), { expiresIn })`.
- **Multipart upload** (`lib-storage`): `new Upload({ client, params: { Bucket, Key, Body }, partSize: 5MB, queueSize: 4 })` com evento `httpUploadProgress`.
- **Range/streaming**: o `GetObjectCommand` nativo do storage responde a `Range` com 206; a API só gera a URL presigned de `GetObject`.

## fluent-ffmpeg

API fluente sobre o CLI `ffmpeg`/`ffprobe` (binário na imagem do worker).

- **Metadados**: `ffmpeg.ffprobe(path, (err, metadata) => {...})` — `metadata.format.duration`, `metadata.streams[]` (codec, resolução, bitrate).
- **Thumbnail**: `ffmpeg(path).screenshots({ timemarks: ['00:00:01'], filename: 'thumb.jpg', size: '640x?' })` — emite `filenames` com o arquivo gerado.

## nanoid

Gerador de ID curto e URL-safe.

- `import { customAlphabet } from 'nanoid'; const videoSlug = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 11)()`.
- Unicidade garantida por constraint `unique` na coluna de slug + retry em colisão.
