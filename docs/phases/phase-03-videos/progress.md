# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed

## Smoke test manual (end-to-end)

Além da suíte automatizada, o fluxo completo foi exercitado contra a stack Compose real via `nestjs-project/scripts/smoke-upload.sh`, que executa a jornada real do usuário:

1. registro + confirmação (token via API do Mailpit) + login
2. `POST /videos` para gerar o draft e as URLs presigned por parte
3. `PUT` binário direto ao MinIO em cada URL (a API nunca vê os bytes)
4. `POST /videos/:id/complete` com os ETags devolvidos pelo storage
5. polling em `/videos/:slug/metadata` até `status: ready`
6. `GET /videos/:slug` (302 → presigned GET) e `GET /videos/:slug?download=true`

Rodada de referência (fixture H.264 de ~22 KB, 1 parte):

- `slug=juaeykzwxsq`, worker preencheu `duration_seconds=2`, `codec_name=h264`, `width=320`, `height=240`, `bit_rate=89204`
- streaming Location contém `X-Amz-Signature` válido; download Location adiciona `response-content-disposition=attachment`
- suporte a 10 GiB: `10 GiB / 100 MiB (default part_size) = 103 partes`, dentro do limite S3 (10 000 partes por objeto). O upload de 10 GiB reais não é exercitado por default por questões de tempo/disco, mas o script aceita `./scripts/smoke-upload.sh path/to/big.mp4` para exercitar arquivos arbitrariamente grandes contra o mesmo pipeline.

## Definition of Done (final run)

- `docker compose exec nestjs-api npx tsc --noEmit` → **exit 0**
- `docker compose exec nestjs-api npm run lint` → **exit 0** (127 warnings pré-existentes; 0 errors)
- `docker compose exec nestjs-api npm test -- --runInBand` → **168/168 passing** (29 suites)
- `docker compose exec nestjs-api npm run test:e2e` → **67/67 passing** (4 suites, incluindo `videos.e2e-spec.ts` com 10 casos)

## Post-review fixes

- `worker.Dockerfile` — CMD passou de `tail -f /dev/null` para `npm run start:worker`; o container video-worker agora consome a fila `video.process` automaticamente ao subir com `docker compose up -d`.
- `CreateVideoDto.file_size` — adicionado `@Max(10 * 1024 * 1024 * 1024)` (constante `MAX_VIDEO_FILE_SIZE`) para respeitar o teto de 10 GiB documentado no plano.
- `VideoProcessor.process` — o `if (!video) return` deixou de ser silencioso: agora loga um `warn` com o id do vídeo e o id do job, atendendo à regra `nestjs-services.md` para background jobs.
- `POST /videos/:id/complete` — decorado com `@HttpCode(200)` para respeitar o contrato do plano (o default do Nest para `@Post` é 201).
- `test/videos.e2e-spec.ts` — adicionados os casos que faltavam: `complete` 200 (feliz), 403 (outro dono), 409 (fora de `draft`); e `GET /videos/:slug` 302 (ready) e `?download=true` com `asAttachment: true`. Os spies em `StorageService`/`VideosQueueService` evitam depender do worker.
- `openapi.json` — re-exportado após o `@HttpCode(200)` para refletir o novo status de sucesso do `complete`.
- `.env.example` — adicionadas `APP_URL`, `SWAGGER_ENABLED`, `S3_*`, `S3_PUBLIC_ENDPOINT` e `REDIS_*` (ficaram fora no SI-03.1 por regra de permissão sobre `.env*`, agora desbloqueada com autorização explícita).
- `VideosService.getBySlug` → `findBySlug` — alinhado ao contrato do plano (SI-03.6 §3); ajustes propagados em `videos.controller.ts`, `videos.service.integration-spec.ts`.
- OpenAPI: respostas de sucesso do `VideosController` extraídas em DTOs (`CreateVideoResponseDto` + `UploadPartDto`, `CompleteUploadResponseDto`, `VideoMetadataResponseDto`) referenciados via `getSchemaPath` + `@ApiExtraModels`, mesmo padrão do `ApiErrorEnvelope`. `buildSwaggerDocument` agora registra os quatro modelos em `extraModels`.
- BullMQ: `addProcessJob` passou a definir `removeOnComplete: { count: 100 }` e `removeOnFail: { count: 500 }` — impede o Redis de acumular jobs terminados indefinidamente.
- `videos-queue.service.integration-spec.ts` isolado em uma fila dedicada por PID (`video.process.test-<pid>`), evitando que o worker de produção consuma o job durante o teste; adicionado `beforeEach` com `queue.drain(true)`.

### SI-03.1 — Dependencies e Configuration Namespaces
- **Status:** completed
- **Tests:** 144/144 unit+integration + 52/52 e2e (suíte existente, sem regressão)
- **Observations:**
  - Versões reais instaladas: `@nestjs/bullmq@12`, `bullmq@6`, `ioredis@5.11` (diferem do `library-refs.md`, que registrou `^11`/`^5` — será alinhado no fechamento).
  - Adicionei `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`) além das vars planejadas — necessário para as URLs presigned serem alcançáveis pelo browser (endpoint interno é `minio:9000`).
  - `.env.example` não pôde ser atualizado (bloqueado por regra de permissão sobre arquivos `.env*`); o `.env` foi atualizado com as novas vars.

### SI-03.2 — Docker Compose Infrastructure (MinIO, Redis, worker)
- **Status:** completed
- **Tests:** no tests (verificado manualmente: redis PONG, minio healthy, worker com ffmpeg 5.1.9)
- **Observations:**
  - A imagem `minio/minio` do Docker Hub está bloqueada/indisponível neste ambiente (pull access denied); troquei para `quay.io/minio/minio` (registro primário atual da MinIO).
  - Adicionei healthcheck no minio (`curl /minio/health/live`) e troquei `depends_on` de `service_started` para `service_healthy` — a imagem do Quay.io tem `curl`.

### SI-03.3 — Video Entity e Migration
- **Status:** completed
- **Tests:** 7/7 passing (video.entity.integration-spec.ts: 5; migrations.integration-spec.ts: 2)
- **Observations:**
  - Migration gerada: `1789513812451-CreateVideos.ts` (tabela `videos` + enum `videos_status_enum` + indexes em `slug`/`status`/`channel_id` + FK).
  - Atualizei `migrations.integration-spec.ts` (fora da lista literal do plano) para cobrir a 3ª migration — sem isso, o teste deixaria a tabela `videos` órfã relativa à tabela `migrations` (estado "synchronize residue").

### SI-03.4 — Storage Service
- **Status:** completed
- **Tests:** 3/3 passing (storage.service.integration-spec.ts)
- **Observations:**
  - `StorageService` usa dois `S3Client`: interno (`minio:9000`) e de presign (`localhost:9000`, endpoint público) — necessário porque a assinatura SigV4 inclui o host; trocar o host depois de assinar quebraria a assinatura.
  - Teste de integração sobrescreve o `publicEndpoint` para `minio:9000` (alcançável de dentro do container).

### SI-03.5 — Queue Producer
- **Status:** completed
- **Tests:** 2/2 passing (videos-queue.service.integration-spec.ts)
- **Observations:**
  - `@nestjs/bullmq@12` é ESM-only (`type: module`), incompatível com Jest/ts-jest CJS → fiz downgrade para `@nestjs/bullmq@11` (CJS).
  - O bullmq v6 não conseguiu carregar o ioredis via dynamic-import no Jest → passei uma instância `new Redis({...})` já construída como `connection` (em vez de options), como o próprio erro do bullmq recomenda.
  - O teste de integração instancia o serviço diretamente (`new VideosQueueService(queue)` com `Queue` real) para evitar o hang do ciclo de vida do BullModule no NestJS module; fecha a conexão Redis explicitamente em `afterAll`.

### SI-03.6 — Videos Service e Controller
- **Status:** completed
- **Tests:** 10/10 unit+integration (videos.service.spec.ts + videos.service.integration-spec.ts); e2e 59/59 (inclui 7 novos de vídeos)
- **Observations:**
  - `nanoid@5` é ESM-only → downgrade para `nanoid@3` (CJS, `customAlphabet`).
  - `bullmq@6` tornou ioredis um peer opcional com load dinâmico (falha no Jest) → downgrade para `bullmq@5` (ioredis é dependência direta). Isso também resolveu o hang do e2e (conexão Redis não fechada).
  - `cleanAllTables` generalizado para limpar as 5 tabelas (videos→tokens→channels→users) com checagem de existência — a tabela `videos` (FK→channels) causava contaminação entre suites no DB compartilhado.
  - Drops do teste de migrations tornados sequenciais (tabelas antes de tipos) para evitar deadlock.

### SI-03.7 — Streaming e Download
- **Status:** completed
- **Tests:** 6/6 integration (stream) + e2e 61/61 (GET /videos/:slug 409/404)
- **Observations:**
  - `GET /videos/:slug` usa `@Redirect()` retornando `{ url, statusCode: 302 }` — redirect dinâmico para a URL presigned.
  - O caso "302 ready" é testado no integration (com storage mockado); o e2e cobre 409 (não-ready) e 404 (slug inexistente) — o 302 real depende do worker (SI-03.8) que ainda não roda no e2e.

### SI-03.8 — Video Worker (FFmpeg)
- **Status:** completed
- **Tests:** 2/2 (video.processor.integration-spec.ts, com ffmpeg real)
- **Observations:**
  - Adicionei `ffmpeg` ao `Dockerfile.dev` (container da API) para o teste do processor rodar na suíte principal.
  - `StorageService.uploadObject` usa `readFile` + `ContentLength` (o SDK rejeita stream sem length no header `x-amz-decoded-content-length`).
  - `generateThumbnail` resolve no evento `end` (não `filenames`), porque o arquivo só existe após o `end`.

### SI-03.9 — OpenAPI Documentation
- **Status:** completed
- **Tests:** e2e 62/62 (inclui novo teste "documents the video endpoints")
- **Observations:**
  - Decorators Swagger já incluídos no controller (SI-03.6/03.7, conforme a regra `nestjs-controllers.md`); SI-03.9 regenerou o `openapi.json` (4 paths de vídeo) + teste no `swagger.e2e-spec.ts`.
