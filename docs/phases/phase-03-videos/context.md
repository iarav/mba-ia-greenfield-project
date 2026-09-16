---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-31T20:16:09-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T21:52:41-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-31T20:16:09-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-31T20:16:09-0300"
  docs/phases/phase-02-auth/context.md: "2026-08-31T20:16:09-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-31T20:16:09-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-31T20:16:09-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** A interface de vídeo (UI de upload, player) pertence a uma fase futura do frontend; esta fase é backend-only.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (upload e player) fica para uma fase posterior.

**Sequencing notes:** Depends on Fase 01 (configuração base) e Fase 02 (autenticação de usuários; vídeos pertencem a um canal, e o upload exige usuário autenticado).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, login e gerenciamento de conta (usuário + canal).
- **Phase 04:** Gerenciamento de Vídeos e Canal (edição de informações, rascunho→publicação, painel do canal, página pública).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq, ioredis |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Strategy for Large Files | decided | B (Presigned multipart upload) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Client SDK | decided | A (@aws-sdk/*) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage |
| phase-03-videos/TD-04 | phase | Backend | Video Processing (Worker + FFmpeg) | decided | A (fluent-ffmpeg) | fluent-ffmpeg |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL | decided | A (nanoid) | nanoid |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download | decided | A (Presigned GET redirect) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle | decided | A (Explicit enum + retries) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the native NestJS choice with the least boilerplate (`@nestjs/bullmq`), provides the exact retry/stall/concurrency semantics a video worker needs, and the cost is one small Redis service added to Compose. RabbitMQ/SQS are overkill for a single queue with one consumer; pg-boss avoids new infra but couples a CPU-heavy background workload to the transactional DB, which the project's layering rules discourage.
**Libraries:** bullmq, @nestjs/bullmq, ioredis

### phase-03-videos/TD-02

**Recommendation:** it keeps the API out of the data path (satisfying the no-blocking requirement) while delivering the resumability that a 10GB upload needs, using the S3-compatible multipart API that both MinIO and production S3 already implement. Option A is the acceptable MVP fallback if multipart orchestration proves larger than budgeted, but multipart is the correct target for the "10GB" requirement.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** because the project's stated trajectory is "MinIO locally, S3 in production", the AWS SDK makes that swap a configuration change rather than a code rewrite, and its TypeScript-first modular design matches the project's strict-typing rules. The MinIO SDK optimizes for the local case but raises friction exactly when the project moves to production S3.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

### phase-03-videos/TD-04

**Recommendation:** for this project's emphasis on readability and maintainability, the fluent API and its battle-tested `ffprobe` parsing outweigh the extra dependency. The FFmpeg binary itself is provided by the worker's Docker image (a dedicated `Dockerfile` on an image that ships `ffmpeg`), which `fluent-ffmpeg` invokes by path. If the dependency's maintenance becomes a concern, the operations are narrow enough (probe + one frame) that Option B is a low-cost fallback.
**Libraries:** fluent-ffmpeg

### phase-03-videos/TD-05

**Recommendation:** a short URL-safe slug is exactly what "URL única por vídeo, sem conflito" calls for, without exposing the internal key. Uniqueness is guaranteed by a database unique constraint on the slug column, with a retry-on-collision loop as a safety net.
**Libraries:** nanoid

### phase-03-videos/TD-06

**Recommendation:** it honors the architecture's "frontend streams from storage directly" and keeps large-file traffic out of the API. Range-based streaming and the 206 responses are handled natively by MinIO/S3; download is the same presigned mechanism with an attachment disposition, keeping the contract simple and symmetric with the upload side.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-07

**Recommendation:** it directly satisfies "rascunho → processando → pronto/erro refletido no banco", keeps the transition single-writer, and delegates retry semantics to the queue chosen in TD-01 rather than reinventing them. A documented transition table (API owns `draft`; worker owns `processing`/`ready`/`error`) prevents write conflicts.
**Libraries:** —

## Inherited Decisions Detail

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger` + CLI plugin) — preserves `class-validator`/`class-transformer` (phase-02-auth/TD-06); the CLI plugin with `classValidatorShim: true` infers DTO schemas with low boilerplate. Enrichment (operations, per-status response types, error contracts) uses explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`).

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Both) — runtime Swagger UI + `openapi.json` exported via an npm script; the marginal cost over runtime-only is a ~15-line script, and the static artifact enables future FE codegen without losing the interactive UI.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (dev/staging only) — Swagger UI disabled in production via env flag (`SWAGGER_ENABLED`), keeping `openapi.json` committed as the consultable spec.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (`@nestjs/config`) — official, `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — first-class `@nestjs/config` integration via `validationSchema`, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (namespaced `registerAs`) — clear per-domain file boundaries, typed injection via `ConfigType<typeof X>`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (shared `registerAs` factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then the factory.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended; memory-hard.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only (diverged from `@nestjs/passport` during implementation).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation with family tracking and theft detection.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random opaque tokens in DB for email confirmation / password reset.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** `@nestjs-modules/mailer` + Handlebars templates.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** `class-validator` + `class-transformer` for request validation.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom domain exception filter emitting `{ statusCode, error, message }` with machine-readable error codes.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` scoped to auth endpoints.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** JWT refresh tokens (diverged from opaque; reused `@nestjs/jwt`).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Strict `[a-z0-9_]` nickname allowlist with `user_<random>` fallback.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`) with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning `{ autoLoadEntities: true, synchronize: false }`. _(from phase 01)_
- Each domain feature gets its own module registered in `AppModule`; controllers handle HTTP routing, services hold business logic. _(from phase 01/02)_
- REST conventions: standard HTTP methods, proper status codes, plural resource nouns, consistent URL structure. _(from phase 02)_
- Error response format `{ statusCode, error, message }` where `error` is a machine-readable domain code; validation errors use `VALIDATION_ERROR` with an array of field messages. _(from phase 02)_
- Services throw domain exceptions (never NestJS HTTP exceptions); exception filters map them to HTTP. _(from phase 02)_
- OpenAPI: `@nestjs/swagger` documents the API; `openapi.json` exported as a static artifact; Swagger UI disabled in production via env flag. _(from openapi-docs-nestjs)_
- Docker: use the Compose service name as host (`db`), never `localhost`; all npm/test/tsc commands run inside the `nestjs-api` container. _(from phase 01/02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` not initialized; UI surfaces start later. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | UI surfaces start later. |
| Interface de vídeo (upload + player) | deferred | phase-03-videos | Frontend fora do escopo desta fase (backend-only). |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service (branching + DB) | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service (DB only, no branching) | Integration (DB contract) |
| Service (configured lib — JWT, cache, queue) | Unit (real lib with test config) |
| Service (side-effect dep — email, storage) | Integration (real capture service / local adapter) |
| Module (configured imports) | Unit (compilation test) |
| Controller | E2E only |
| DTO | E2E (one validation wiring test per endpoint) |
| Guard | E2E (+ Unit if complex internal logic) |
| Exception Filter | Unit + E2E |

Notes: integration and e2e suites share a single test DB and must run with `--runInBand`; suffix `*.spec.ts` (unit), `*.integration-spec.ts` (integration), `*.e2e-spec.ts` (e2e). Queue/storage external systems are exercised against the real Compose services where feasible (do not mock what can run for real).
