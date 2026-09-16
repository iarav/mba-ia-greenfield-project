---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-31
scope_description: "Backend for video upload and processing: object storage (MinIO/S3), background processing queue, worker with FFmpeg, large-file upload without blocking the API, automatic thumbnail generation, unique URLs, streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (entity, upload orchestration, storage, queue, worker), plus the new Docker Compose services (object storage, queue, worker).
- `next-frontend/` — out of scope for this phase. The video interface (upload UI, player) starts in a later phase; decisions here that shape the upload/streaming contract are marked `Cross-layer` so the future frontend consumes a stable handshake without being built now.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram marks the queue as "TBD" — this is the phase's main open stack decision. Video processing (FFmpeg on files up to 10GB) is CPU-bound, long-running (seconds to minutes), and must not block the HTTP request. The queue must support: at-least-once delivery, retries with backoff, per-job data payload, and a worker that runs in a separate process/container. The project currently has only PostgreSQL, Mailpit, and the API in Docker Compose — no message broker is provisioned yet.

**Options:**

### Option A: BullMQ (Redis-backed)
- NestJS-first queue built on Redis. Official integration via `@nestjs/bullmq` (`@Processor`, `@InjectQueue`, `WorkerHost`). Rich feature set: retries with exponential backoff, job priorities, concurrency, stalled-job detection, parent-child dependencies, repeatable jobs.
- **Pros:** Native NestJS integration with minimal boilerplate; the de-facto standard for NestJS background work; robust retry/stall semantics built in; Redis is a small, familiar sidecar that the worker and API share for the queue handle.
- **Cons:** Introduces a new infrastructure dependency (Redis) to Docker Compose; Redis is in-memory-first (data is durable via AOF/RDB but requires config for production-grade durability).

### Option B: RabbitMQ (AMQP)
- General-purpose message broker with routing (exchanges/queues/bindings), ack/nack delivery semantics, and DLX for dead-lettering.
- **Pros:** Battle-tested, language-agnostic, strong delivery guarantees, first-class dead-letter queues.
- **Cons:** Heavier operational footprint (Erlang runtime, larger image); NestJS integration (`@nestjs/microservices`) is transport-generic and lower-level than a purpose-built queue lib; more moving parts than this phase needs (a single queue with one consumer).

### Option C: pg-boss (PostgreSQL-backed)
- Job queue that lives inside PostgreSQL, reusing the existing `db` service. No new infrastructure.
- **Pros:** Zero new services — the queue is a set of tables in the existing PostgreSQL; transactional enqueue (a video row + its job in the same DB).
- **Cons:** Puts long-running CPU-bound processing load's coordination on the transactional database; polling-based (higher latency, less elegant for high-throughput); less featureful for stalled/priority semantics than BullMQ.

### Option D: AWS SQS
- Fully-managed cloud queue.
- **Pros:** Zero ops in production, durable, scales elastically.
- **Cons:** Cloud coupling (not runnable locally in Docker without emulation); the project targets a self-contained Docker Compose stack; introduces provider-specific APIs early.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the native NestJS choice with the least boilerplate (`@nestjs/bullmq`), provides the exact retry/stall/concurrency semantics a video worker needs, and the cost is one small Redis service added to Compose. RabbitMQ/SQS are overkill for a single queue with one consumer; pg-boss avoids new infra but couples a CPU-heavy background workload to the transactional DB, which the project's layering rules discourage.

**Decision:** A (BullMQ + Redis)

**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-02: Upload Strategy for Large Files (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must never pass through the NestJS API (that would block the Node event loop and exhaust memory — the automatic-rejection criterion). The upload must also be resumable ("permitir retomar em caso de falha de conexão" in project-plan § Pontos de Atenção). The client is a browser (future frontend), so the handshake must be HTTP-native. The chosen strategy defines a contract the frontend will later consume.

**Options:**

### Option A: Presigned single PUT direct to storage
- The API creates a video draft row, generates a presigned `PutObject` URL scoped to the target object key, and returns it. The client uploads the raw bytes directly to MinIO/S3 in one PUT. The API never touches the file body.
- **Pros:** Simplest correct approach; API stays out of the data path; one presigned URL round-trip.
- **Cons:** No resumability — a connection drop means restarting the whole 10GB upload; a single 10GB PUT is fragile on unstable networks.

### Option B: Presigned multipart upload direct to storage
- The API orchestrates an S3 multipart upload: `CreateMultipartUpload`, issue one presigned URL per part (e.g., 100MB parts), client uploads parts in parallel, then `CompleteMultipartUpload`. The client can retry a failed part without resending completed ones.
- **Pros:** Resumable at part granularity; parallelizes the upload (faster on high-bandwidth links); standard S3 API the frontend can implement; API remains out of the data path.
- **Cons:** More orchestration (multipart session state, part list, completion); slightly more complex client handshake.

### Option C: tus protocol (resumable upload server)
- Run a tus server (`@tus/server`) that accepts resumable uploads and writes to storage; the client uses `tus-js-client`.
- **Pros:** Purpose-built resumable protocol; client lib handles chunking/retry transparently.
- **Cons:** Adds a dedicated upload service (more infra, another moving part) and a protocol layer the API must proxy to; heavier than this phase requires given S3's native multipart already provides resumability.

### Option D: Stream the file through the API (multipart/form-data)
- The client posts the file to NestJS; the API buffers/streams it to storage.
- **Pros:** Trivially simple client.
- **Cons:** **Rejected** — a 10GB body through the Node event loop blocks the API and is exactly the "travar o sistema" the acceptance criteria forbid (automatic rejection).

**Recommendation:** **Option B (presigned multipart upload)** — it keeps the API out of the data path (satisfying the no-blocking requirement) while delivering the resumability that a 10GB upload needs, using the S3-compatible multipart API that both MinIO and production S3 already implement. Option A is the acceptable MVP fallback if multipart orchestration proves larger than budgeted, but multipart is the correct target for the "10GB" requirement.

**Decision:** B (Presigned multipart upload)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Object Storage Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is not an open choice — the project already points to S3-compatible storage, run locally as MinIO (same API as S3) and swappable for S3 in production. What is open is *which client SDK* to use to talk to it. The SDK must support: presigned URLs (PutObject, GetObject), multipart upload orchestration, and object streaming.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`
- The official AWS SDK v3, modular and TypeScript-first. Works against MinIO by pointing the `S3Client` at the MinIO endpoint with `forcePathStyle: true`. The presigner generates presigned URLs; `lib-storage` provides the `Upload` abstraction for multipart.
- **Pros:** Production-proven; a drop-in swap from MinIO to real S3 (change endpoint + credentials only); first-class TypeScript types; `Upload` abstracts multipart complexity; presigned URLs via `getSignedUrl`.
- **Cons:** Larger dependency surface (three packages); endpoint/path-style config for MinIO is a one-time gotcha to get right.

### Option B: `minio` (MinIO JavaScript SDK)
- The MinIO-native client, S3-compatible.
- **Pros:** Simpler single-package API; direct MinIO idioms; built-in presigned URL helpers.
- **Cons:** Couples the codebase to MinIO idioms (migration to real S3 in production is less transparent than the AWS SDK); smaller ecosystem and weaker TypeScript story than the AWS SDK.

**Recommendation:** **Option A (`@aws-sdk/*`)** — because the project's stated trajectory is "MinIO locally, S3 in production", the AWS SDK makes that swap a configuration change rather than a code rewrite, and its TypeScript-first modular design matches the project's strict-typing rules. The MinIO SDK optimizes for the local case but raises friction exactly when the project moves to production S3.

**Decision:** A (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner + @aws-sdk/lib-storage)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

---

## TD-04: Video Processing (Worker Runtime + FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After upload, the worker must (1) extract duration and metadata from the file, and (2) generate a thumbnail from a single frame. Both are FFmpeg-family operations (`ffprobe` for metadata, `ffmpeg` for frame extraction) and are CPU-bound. The worker runs as a separate process/container consuming the queue (per TD-01). The open decision is *how the Node worker invokes FFmpeg*.

**Options:**

### Option A: `fluent-ffmpeg` (wrapper library)
- A fluent Node API over the `ffmpeg`/`ffprobe` CLI, with built-in `ffprobe` metadata parsing and `screenshots()` for thumbnail extraction.
- **Pros:** Readable fluent API; robust `ffprobe` output parsing (format/streams/duration); `screenshots()` handles seek + single-frame extraction concisely.
- **Cons:** Adds a dependency whose maintenance pace has slowed (Medium reputation); wraps the CLI so the ffmpeg binary path must still be configured; occasionally lagging behind newer FFmpeg flags.

### Option B: Direct `child_process` spawn of `ffmpeg`/`ffprobe`
- A thin internal service that `execFile`s `ffprobe -print_format json` and `ffmpeg -ss <t> -i <in> -frames:v 1`, parsing JSON/stdout directly.
- **Pros:** Zero runtime dependencies; full control over flags and error handling; trivially testable by asserting the exact CLI invocation.
- **Cons:** More verbose; hand-rolled JSON parsing of `ffprobe` output; reinvents what `fluent-ffmpeg` already provides.

**Recommendation:** **Option A (`fluent-ffmpeg`)** — for this project's emphasis on readability and maintainability, the fluent API and its battle-tested `ffprobe` parsing outweigh the extra dependency. The FFmpeg binary itself is provided by the worker's Docker image (a dedicated `Dockerfile` on an image that ships `ffmpeg`), which `fluent-ffmpeg` invokes by path. If the dependency's maintenance becomes a concern, the operations are narrow enough (probe + one frame) that Option B is a low-cost fallback.

**Decision:** A (fluent-ffmpeg)

**Libraries:** fluent-ffmpeg

---

## TD-05: Unique Video URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, unique, URL-safe identifier that never collides. This identifier is the public-facing slug (e.g., `GET /videos/<slug>`), distinct from the internal UUID primary key. It must be unique across all videos and cheap to generate at draft-creation time.

**Options:**

### Option A: nanoid (short random ID)
- Generate a compact (e.g., 11–21 char) URL-safe random ID using `nanoid` with a custom alphabet; enforce uniqueness with a DB unique constraint (retry on the vanishingly rare collision).
- **Pros:** Short, human-friendly, URL-safe, unambiguous to read; negligible collision probability at 11+ chars; independent of internal UUID.
- **Cons:** Not sortable/sequential (irrelevant here); adds a tiny dependency (or can be inlined with `crypto.randomBytes`).

### Option B: UUID v4 (the internal primary key reused)
- Expose the existing `uuid` primary key as the public identifier.
- **Pros:** Zero new code — reuse `id`.
- **Cons:** Leaks the internal DB key; long and ugly in URLs; couples public identity to storage identity.

### Option C: ULID / KSUID (sortable IDs)
- Sortable, timestamp-prefixed unique IDs.
- **Pros:** Lexicographically sortable (nice for time-ordered listings); URL-safe.
- **Cons:** Longer than nanoid; sortability offers no benefit for this phase's requirement; extra dependency.

**Recommendation:** **Option A (nanoid)** — a short URL-safe slug is exactly what "URL única por vídeo, sem conflito" calls for, without exposing the internal key. Uniqueness is guaranteed by a database unique constraint on the slug column, with a retry-on-collision loop as a safety net.

**Decision:** A (nanoid)

**Libraries:** nanoid

---

## TD-06: Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start before the whole file is downloaded (HTTP Range requests → 206 Partial Content), and the user must be able to download the file. The architecture diagram already shows the frontend streaming **directly from storage** ("Frontend → Object Storage: Streams"), so the API's role is to resolve the public slug to a storage location and hand the client a streamable resource — not to proxy bytes. The open decision is *how* that hand-off works.

**Options:**

### Option A: Presigned GET redirect to storage
- `GET /videos/:slug` resolves the slug → storage key, generates a short-lived presigned `GetObject` URL, and responds with 302 to it. MinIO/S3 natively supports `Range` on GetObject, so the browser's `<video>` element streams with 206 responses directly from storage. Download uses the same URL with `Content-Disposition: attachment` (a query flag or a distinct endpoint).
- **Pros:** Keeps 10GB streams off the API; storage handles Range/206 natively; trivial API logic (lookup + presign + redirect); matches the architecture diagram.
- **Cons:** Presigned URL expiration must be tuned (short TTL fine for playback); the redirect adds one hop per stream start.

### Option B: API proxies the stream (pipe storage bytes through NestJS)
- The API streams the object body from storage to the client, forwarding Range headers.
- **Pros:** Single stable URL without redirects; the API controls access at the HTTP layer.
- **Cons:** **Puts 10GB streams through the Node API** — the same anti-pattern the upload decision avoids; adds load and memory pressure; reinvents Range handling that storage already does for free.

**Recommendation:** **Option A (presigned GET redirect)** — it honors the architecture's "frontend streams from storage directly" and keeps large-file traffic out of the API. Range-based streaming and the 206 responses are handled natively by MinIO/S3; download is the same presigned mechanism with an attachment disposition, keeping the contract simple and symmetric with the upload side.

**Decision:** A (Presigned GET redirect)

**Libraries:** @aws-sdk/s3-request-presigner

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A video row is pre-created as a draft the moment an upload begins, and it moves through a lifecycle as the worker processes it. The acceptance criteria require the status to be reflected in the database ("rascunho → processando → pronto/erro"). The open decision is the exact state machine and what happens when processing fails.

**Options:**

### Option A: Explicit enum status (draft → processing → ready | error) with BullMQ retries
- A PostgreSQL enum `video_status` with values `draft`, `processing`, `ready`, `error`. Flow: upload start → `draft`; multipart completion enqueues a job and sets `processing`; worker sets `ready` (with duration/metadata/thumbnail) or `error` (with a reason) on failure. BullMQ retries with exponential backoff; after N attempts, the job is marked failed and the row stays `error` for operator/retry handling.
- **Pros:** Clear, observable state per the acceptance criteria; retries are handled by the queue (per TD-01) rather than hand-rolled; a terminal `error` state is explicit and debuggable.
- **Cons:** Needs a documented transition table so every transition is single-writer (API vs worker).

### Option B: Minimal two-state flag + soft-delete on failure
- Only `draft` and `ready` (plus a boolean `is_failed`).
- **Pros:** Simpler schema.
- **Cons:** Loses the explicit `processing` and `error` states the acceptance criteria name; harder to distinguish "in flight" from "stuck".

### Option C: Status derived implicitly from queue job state (no DB status)
- The DB holds only `draft`/`published`; processing state lives only in the queue.
- **Pros:** No status synchronization between queue and DB.
- **Cons:** The acceptance criteria explicitly require the status reflected **in the database** — deriving it from queue state violates that; a crashed worker leaves rows stuck in an ambiguous state.

**Recommendation:** **Option A (explicit enum + BullMQ retries)** — it directly satisfies "rascunho → processando → pronto/erro refletido no banco", keeps the transition single-writer, and delegates retry semantics to the queue chosen in TD-01 rather than reinventing them. A documented transition table (API owns `draft`; worker owns `processing`/`ready`/`error`) prevents write conflicts.

**Decision:** A (Explicit enum + BullMQ retries)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ + Redis) | A |
| TD-02 | Cross-layer | Upload Strategy for Large Files | B (Presigned multipart upload) | B |
| TD-03 | Backend | Object Storage Client SDK | A (@aws-sdk/*) | A |
| TD-04 | Backend | Video Processing (Worker + FFmpeg) | A (fluent-ffmpeg) | A |
| TD-05 | Backend | Unique Video URL | A (nanoid) | A |
| TD-06 | Cross-layer | Streaming and Download | A (Presigned GET redirect) | A |
| TD-07 | Backend | Video Status Lifecycle | A (Explicit enum + retries) | A |
