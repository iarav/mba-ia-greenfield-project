---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T21:55:15-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T21:54:12-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T21:52:41-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-31T20:16:09-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo de vídeos do StreamTube: object storage (MinIO/S3) para arquivos e thumbnails, fila de processamento em segundo plano (BullMQ + Redis) com um worker FFmpeg, upload de vídeos de até 10GB sem impactar a API (presigned multipart direto ao storage), pré-cadastro automático como rascunho, processamento automático (duração/metadados e thumbnail), URL única por vídeo, e reprodução via streaming + download — upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Dependencies e Configuration Namespaces

**Description:** Instalar as dependências da fase (fila, storage, ffmpeg, nanoid) e criar os namespaces de configuração `storage` e `queue` seguindo o padrão `registerAs` das fases anteriores.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `bullmq`, `@nestjs/bullmq`, `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`, `fluent-ffmpeg`, `nanoid`; e devDependency `@types/fluent-ffmpeg` (per `phase-03-videos/TD-01`, `TD-03`, `TD-04`, `TD-05`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (boolean, default `true`), `S3_PRESIGNED_URL_EXPIRES` (number, default `3600`) (per `phase-03-videos/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (number, default `6379`) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` — adicionar as novas variáveis ao schema Joi (`S3_*` e `REDIS_*` com defaults; `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET` obrigatórias) e atualizar `.env.example`

**Tests:** _(empty — Infra/config; comportamento é exercitado pelos SIs que consomem `storageConfig`/`queueConfig`)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npx tsc --noEmit` sai com código 0 após a instalação das dependências
- A aplicação inicia sem erros quando as variáveis `S3_*`/`REDIS_*` são fornecidas (Joi valida)
- A aplicação não inicia quando `S3_BUCKET` está ausente — `ConfigModule.forRoot` lança erro de validação no bootstrap
- `storageConfig` e `queueConfig` são injetáveis via `@Inject(storageConfig.KEY)` / `@Inject(queueConfig.KEY)`

---

### SI-03.2 — Docker Compose Infrastructure (MinIO, Redis, worker)

**Description:** Adicionar os serviços de object storage (MinIO), fila (Redis) e worker (FFmpeg) ao `compose.yaml`, junto com o `Dockerfile` do worker.

**Technical actions:**

1. Adicionar serviço `minio` (imagem `minio/minio`) ao `compose.yaml` — porta `9000` (API) e `9001` (console), volume persistente, credenciais via env, healthcheck (per `phase-03-videos/TD-03`)
2. Adicionar serviço `redis` (imagem `redis:7`) ao `compose.yaml` — porta `6379`, healthcheck (per `phase-03-videos/TD-01`)
3. Criar `worker.Dockerfile` — imagem `node:25.6.0-slim` com `apt install ffmpeg` + dependências do projeto; adicionar serviço `video-worker` que builda essa imagem, monta o código e roda o entrypoint do worker (per `phase-03-videos/TD-04`)
4. Atualizar `depends_on` do `nestjs-api` para aguardar `minio` e `redis` (além de `db` e `mailpit`)

**Tests:** _(empty — Infra; exercitado pelos integration/e2e tests que dependem de MinIO/Redis reais)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `video-worker` junto com a stack existente
- MinIO está acessível em `localhost:9000` (console em `localhost:9001`)
- Redis está acessível em `localhost:6379` e aceita conexões dentro da rede Compose
- A imagem do worker contém o binário `ffmpeg` (`docker compose exec video-worker ffmpeg -version` retorna a versão)

---

### SI-03.3 — Video Entity e Migration

**Description:** Criar a entidade `Video` (per Data Model) e a migration, incluindo o enum de status.

**Technical actions:**

1. Criar `src/videos/video-status.enum.ts` — `enum VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', ERROR = 'error' }` (per `phase-03-videos/TD-07`)
2. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (`id`, `slug` unique, `title`, `description` nullable, `status` enum, `channel_id` FK, `object_key`, `thumbnail_key`, `duration_seconds`, `metadata` jsonb, `failure_reason`, timestamps) e relação `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`
3. Criar `src/videos/videos.module.ts` — `VideosModule` com `TypeOrmModule.forFeature([Video])` em `imports` e `exports`
4. Gerar a migration via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL gerado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique slug, enum de status, FK para channel, defaults/timestamps | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o enum `videos_status_enum` com as colunas/constraints do Data Model
- Inserir um vídeo com `slug` duplicado falha com violação de unique constraint
- Inserir um vídeo com `status` fora do enum (`draft`/`processing`/`ready`/`error`) falha com violação de enum
- A relação `channel_id` referencia `channels.id` (FK válida)

---

### SI-03.4 — Storage Service

**Description:** Criar o `StorageService` que encapsula o `S3Client` e expõe presigned URLs (PUT/GET) e a orquestração multipart.

**Technical actions:**

1. Criar `src/videos/storage.service.ts` — injeta `storageConfig`; instancia `S3Client` com `endpoint`/`region`/`forcePathStyle`/`credentials`; métodos `createMultipartUpload(key)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `presignGetObject(key, { asAttachment })` (per `phase-03-videos/TD-02`, `TD-03`, `TD-06`)
2. Criar `src/videos/storage.module.ts` — provider de `StorageService` (e `S3Client`) exportado para os módulos consumidores
3. Criar `src/videos/exceptions/video.exceptions.ts` — `VideoNotFoundException`, `VideoNotOwnedException`, `VideoNotDraftException`, `VideoNotReadyException`, `StorageException` (subclasses de `DomainException`) para o Error Catalog

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contra MinIO real — presign PUT aceita upload, multipart cria/completa objeto, presign GET baixa o objeto com Range | `src/videos/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `presignUploadPart` gera URL que aceita um `PUT` direto no storage (sem passar pela API)
- `createMultipartUpload` + `presignUploadPart` + `completeMultipartUpload` produzem um objeto íntegro no bucket
- `presignGetObject` gera URL que permite `GET` com suporte a `Range` (206 do storage)
- Uma operação que falha no storage lança `StorageException` (errorCode `STORAGE_ERROR`)

---

### SI-03.5 — Queue Producer

**Description:** Configurar o BullMQ e expor o producer de jobs `video.process`.

**Technical actions:**

1. Criar `src/videos/videos.queue.ts` — constante `VIDEO_PROCESS_QUEUE = 'video.process'` e o tipo `VideoProcessJob = { videoId: string }`
2. Criar `src/videos/videos-queue.service.ts` — injeta `@InjectQueue(VIDEO_PROCESS_QUEUE)`; método `addProcessJob(videoId)` com `attempts`/`backoff` (exponential) (per `phase-03-videos/TD-01`, `TD-07`)
3. Adicionar `BullModule.forRootAsync` (connection a partir de `queueConfig`) e `BullModule.registerQueue({ name: VIDEO_PROCESS_QUEUE })` ao `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosQueueService` | Integration: contra Redis real — `addProcessJob` insere job na fila com payload `{ videoId }` | `src/videos/videos-queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `addProcessJob(videoId)` adiciona um job na fila `video.process` com payload `{ videoId }`
- O job é criado com `attempts`/`backoff` configurados (retry com backoff exponencial, per `TD-07`)
- O job é observável na fila via a API do BullMQ (teste de integração verifica a presença do job)

---

### SI-03.6 — Videos Service e Controller

**Description:** Implementar a criação de rascunho (com multipart presigned), a conclusão do upload (enfileira o processamento) e a consulta de metadados.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` com `title` (`@IsString @MaxLength(255)`), `description` (opcional), `file_size` (`@IsInt @Min(1)`), `part_size` (opcional, default `104857600`)
2. Criar `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` com `upload_id` e `parts: Array<{ part_number: number; etag: string }>`
3. Criar `src/videos/videos.service.ts` — `createDraft(dto, user)`: localiza o canal do usuário, gera `slug` (nanoid, retry em colisão), determina `object_key` (`videos/{slug}/original`), cria `Video` `draft`, chama `storage.createMultipartUpload` e gera URLs presigned por parte; `completeUpload(id, dto, user)`: valida dono e status `draft`, chama `storage.completeMultipartUpload`, seta `status = processing` e chama `videosQueue.addProcessJob`; `findBySlug(slug)` (per `phase-03-videos/TD-02`, `TD-05`, `TD-07`)
4. Criar `src/videos/videos.controller.ts` — `POST /videos` (auth), `POST /videos/:id/complete` (auth + owner), `GET /videos/:slug/metadata` (`@Public()`), extraindo o usuário via `@CurrentUser()`
5. Registrar `VideosModule` em `AppModule` (import)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: slug colisão, validação de dono, transição de status | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: cria rascunho persiste; complete muda status + enfileira | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: POST /videos 201/401, POST complete 200/403/409, GET metadata 200/404 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` com token válido cria um rascunho com `status: draft` e retorna `upload_id` + `parts[]` (URLs presigned)
- `POST /videos` sem token retorna `401`
- `POST /videos/:id/complete` com partes válidas seta `status: processing` e enfileira `video.process`
- `POST /videos/:id/complete` em vídeo de outro dono retorna `403 VIDEO_NOT_OWNED`
- `POST /videos/:id/complete` em vídeo fora de `draft` retorna `409 VIDEO_NOT_DRAFT`
- `GET /videos/:slug/metadata` retorna `200` com `title`/`status`/`duration_seconds`/`metadata`; slug inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.7 — Streaming e Download

**Description:** Adicionar `GET /videos/:slug` que redireciona para a URL presigned (streaming via Range) e suporta download.

**Technical actions:**

1. Adicionar `stream(slug, download)` em `VideosService` — resolve slug, valida `status = ready` (senão `VideoNotReadyException`), chama `storage.presignGetObject(object_key, { asAttachment: download })` (per `phase-03-videos/TD-06`)
2. Adicionar `GET /videos/:slug` em `VideosController` — `@Public()`, `@Query('download')`, retorna `302` (redirect) para a URL presigned

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E: GET /videos/:slug 302 (ready), 409 (não-ready), 404 (slug inexistente), 302 com disposition (download) | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.4

**Acceptance criteria:**

- `GET /videos/:slug` de um vídeo `ready` retorna `302` para a URL presigned de `GetObject`
- `GET /videos/:slug` de um vídeo `draft`/`processing`/`error` retorna `409 VIDEO_NOT_READY`
- `GET /videos/:slug?download=true` redireciona com `Content-Disposition: attachment`
- `GET /videos/:slug` com slug inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.8 — Video Worker (FFmpeg)

**Description:** Implementar o worker que consome `video.process`, extrai duração/metadados via ffprobe e gera a thumbnail via ffmpeg, atualizando o banco.

**Technical actions:**

1. Criar `src/video-worker/video.processor.ts` — `@Processor(VIDEO_PROCESS_QUEUE)` estendendo `WorkerHost`; `process(job)`: carrega `Video`, seta `status = processing`, baixa o objeto do storage para arquivo temporário, `ffprobe` para duração/metadados (codec, resolução, bitrate), `screenshots({ timemarks: ['00:00:01'] })` para thumbnail, faz upload da thumbnail ao storage, atualiza `duration_seconds`/`metadata`/`thumbnail_key` e `status = ready`; no `catch` seta `status = error` + `failure_reason` (per `phase-03-videos/TD-04`, `TD-07`)
2. Criar `src/video-worker/video-worker.module.ts` — importa `ConfigModule`/`TypeOrmModule`/`BullModule`/`VideosModule`/`StorageModule` e registra o `VideoProcessor`
3. Criar `src/worker.ts` — bootstrap standalone (`NestFactory.createApplicationContext`) que sobe o worker
4. Adicionar script `start:worker` ao `package.json` e referenciá-lo no `worker.Dockerfile` (CMD)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: com um vídeo fixture no storage — process() extrai duração, gera thumbnail, seta `ready`; falha seta `error` + `failure_reason` | `src/video-worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5, SI-03.2

**Acceptance criteria:**

- Um job `video.process` em um vídeo válido popula `duration_seconds`, `metadata`, `thumbnail_key` e seta `status: ready`
- A thumbnail existe no storage após o processamento
- Um job `video.process` em um vídeo inválido seta `status: error` e `failure_reason` (não lança para o BullMQ sem controle)
- O worker consome da fila `video.process` e persiste a mudança no banco

---

### SI-03.9 — OpenAPI Documentation

**Description:** Documentar os endpoints de vídeo no OpenAPI e re-exportar o `openapi.json`.

**Technical actions:**

1. Adicionar decorators `@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery` ao `VideosController` e `@ApiProperty` aos DTOs (per `openapi-docs-nestjs/TD-01`)
2. Incluir `Video`/DTOs no `buildSwaggerDocument` (via `@ApiExtraModels` onde necessário)
3. Rodar `npm run openapi:export` e commitar o `openapi.json` atualizado com os paths de vídeo (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Swagger | E2E: openapi.json contém POST /videos, POST /videos/{id}/complete, GET /videos/{slug}, GET /videos/{slug}/metadata | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- `openapi.json` inclui `POST /videos`, `POST /videos/{id}/complete`, `GET /videos/{slug}` e `GET /videos/{slug}/metadata`
- A Swagger UI (dev) exibe o grupo `videos` com os quatro endpoints
- `npm run openapi:export` regenera o `openapi.json` sem erros

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| slug | varchar(11) | unique, not null — URL-safe nanoid (per `phase-03-videos/TD-05`) |
| title | varchar(255) | not null |
| description | text | nullable |
| status | enum | not null, values: `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → channels.id, not null |
| object_key | varchar | nullable — storage key of the video object |
| thumbnail_key | varchar | nullable — storage key of the thumbnail object |
| duration_seconds | int | nullable |
| metadata | jsonb | nullable — ffprobe metadata (codec, resolution, bitrate) |
| failure_reason | text | nullable — populated when status = `error` |
| created_at | timestamptz | not null, auto-generated |
| updated_at | timestamptz | not null, auto-generated |

**Relations:** `Video` belongs to `Channel` (many-to-one)
**Indexes:** unique on `slug`; index on `channel_id`; index on `status`

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- title: string, required — max 255 characters
- description: string, optional
- file_size: number, required — total file size in bytes (to compute the multipart part count)
- part_size: number, optional — per-part size in bytes (default 104857600 / 100MB)

**Response 201:**
- id: string (uuid)
- slug: string — URL-safe unique identifier
- title: string
- status: string — `draft`
- upload_id: string — multipart upload id (for the presigned upload session)
- parts: array of `{ part_number, url }` — presigned PUT URLs per part

**Error responses:**
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- upload_id: string, required — multipart upload id
- parts: array of `{ part_number, etag }`, required — the ETags returned by storage for each uploaded part

**Response 200:**
- id: string (uuid)
- status: string — `processing` (the job was enqueued)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id/slug does not exist
- 403 VIDEO_NOT_OWNED: when the authenticated user does not own the video's channel
- 409 VIDEO_NOT_DRAFT: when the video is not in `draft` status

---

#### GET /videos/:slug (SI-03.7)

**Request query parameters:**
- download: boolean, optional — when `true`, the presigned URL carries `Content-Disposition: attachment`

**Response 302:** redirects to a presigned `GetObject` URL for the video object (supports `Range` → 206 from storage).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug does not exist
- 409 VIDEO_NOT_READY: when the video status is not `ready`

---

#### GET /videos/:slug/metadata (SI-03.6)

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: string
- duration_seconds: number | null
- metadata: object | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug does not exist

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | — |
| POST /videos/:id/complete | ✗ | ✓ | ✓ |
| GET /videos/:slug | ✓ | ✓ | ✓ |
| GET /videos/:slug/metadata | ✓ | ✓ | ✓ |

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | A video id/slug does not exist |
| VIDEO_NOT_OWNED | 403 | The authenticated user is not the owner of the video's channel |
| VIDEO_NOT_DRAFT | 409 | An operation requires the video to be in `draft` status |
| VIDEO_NOT_READY | 409 | Streaming/download requested before the video reached `ready` |
| STORAGE_ERROR | 502 | The object storage interaction failed |

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-04`)
**Trigger:** fired when a multipart upload completes (`POST /videos/:id/complete`) and the video transitions `draft → processing`
**Delivery semantics:** at-least-once, with retries + exponential backoff (per `phase-03-videos/TD-07`)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (config vars antes dos serviços Compose)
├── SI-03.3 — depends on SI-03.1 (nanoid/types antes da entidade)
│   └── SI-03.4 — depends on SI-03.1, SI-03.2 (@aws-sdk + MinIO rodando)
│   └── SI-03.5 — depends on SI-03.1, SI-03.2 (bullmq + Redis rodando)
└── SI-03.6 — depends on SI-03.3, SI-03.4, SI-03.5 (entidade + storage + fila antes do service/controller)
    ├── SI-03.7 — depends on SI-03.6, SI-03.4 (controller + storage presign GET)
    ├── SI-03.8 — depends on SI-03.3, SI-03.4, SI-03.5, SI-03.2 (worker consome fila + storage + entidade)
    └── SI-03.9 — depends on SI-03.6, SI-03.7 (endpoints existem antes da documentação)
```

Ordem de implementação linear: SI-03.1 → SI-03.2, SI-03.3 (paralelo) → SI-03.4, SI-03.5 (paralelo) → SI-03.6 → SI-03.7, SI-03.8 (paralelo) → SI-03.9

---

## Deliverables

- [ ] SI-03.1 — Dependencies e Configuration Namespaces
- [ ] SI-03.2 — Docker Compose Infrastructure (MinIO, Redis, worker)
- [ ] SI-03.3 — Video Entity e Migration
- [ ] SI-03.4 — Storage Service
- [ ] SI-03.5 — Queue Producer
- [ ] SI-03.6 — Videos Service e Controller
- [ ] SI-03.7 — Streaming e Download
- [ ] SI-03.8 — Video Worker (FFmpeg)
- [ ] SI-03.9 — OpenAPI Documentation

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
