# Telegram S3

Telegram S3 is a small S3-compatible NestJS/Express server that stores object data as Telegram Bot API document messages.

It exposes an S3-like HTTP API, validates AWS Signature V4 requests, and uses a Telegram bot chat/channel/group as the storage backend. S3 object metadata is persisted separately in a local JSON database, so the `/data` volume must be persistent.

## S3 client configuration

Use these values with any S3-compatible client:

- **Provider**: custom / S3-compatible provider
- **Access Key Id**: value of `S3_ACCESS_KEY_ID`
- **Secret Access Key**: value of `S3_SECRET_ACCESS_KEY`
- **Bucket**: value of `S3_BUCKET`
- **Region**: value of `S3_REGION`, for example `us-east-1`
- **Endpoint**: your deployed URL, for example `https://s3.example.com`

The server supports path-style URLs (`/bucket/key`) and virtual-host style when the host starts with the configured bucket.

## Required env vars

See `.env.example`.

Important:

- `TELEGRAM_BOT_TOKEN` is required.
- `TELEGRAM_CHAT_ID` is required because Telegram needs a chat/channel/group where the bot will send stored files.
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `S3_REGION` are required. The app does not provide hardcoded credential or bucket fallbacks.
- Persist metadata. Telegram stores file bytes, but the metadata file maps S3 keys to Telegram `file_id`s. Locally, `.env.example` uses `./data/metadata.json`; Docker examples use `/data/metadata.json` with a persistent volume.

## Supported S3 operations

Enough for common backup tools:

- `PUT Object` with or without `Content-Type`
- `CopyObject` for S3 rename/copy workflows
- `GET Object`
- `HEAD Object`
- `DELETE Object`
- `ListObjectsV2`
- multipart upload: initiate, upload part, list uploads, list parts, complete, abort
- AWS Signature V4 header and presigned-query authentication

## Run locally

The app loads `.env` automatically when running with Node/Nest locally. For local runs, use `METADATA_FILE=./data/metadata.json`; `/data/metadata.json` is intended for Docker containers with a mounted `/data` volume.

```bash
npm install
cp .env.example .env
# edit .env
npm run start:dev
```

## Docker image

Published image:

```txt
ghcr.io/dmytrobaida/telegram-s3:latest
```

Run with Docker:

```bash
cp .env.example .env
# edit .env
docker run --env-file .env -p 3000:3000 -v telegram-s3-data:/data ghcr.io/dmytrobaida/telegram-s3:latest
```

For Docker, pass the file explicitly with `--env-file .env`. Docker itself does not automatically inject `.env` into `docker run` containers.

Or build locally:

```bash
docker build -t telegram-s3 .
docker run --env-file .env -p 3000:3000 -v telegram-s3-data:/data telegram-s3
```

## Docker Compose

`docker-compose.yml` uses `ghcr.io/dmytrobaida/telegram-s3:latest` by default.

Run:

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

The compose file persists metadata in the `telegram-s3-data` Docker volume.

## Local Docker Compose

`docker-compose.local.yml` builds the image from the local `Dockerfile` and persists metadata in the `telegram-s3-local-data` Docker volume.

Run:

```bash
cp .env.example .env
# edit .env
npm run docker:local
```

Stop:

```bash
npm run docker:local:down
```

## GitHub Actions Docker publishing

`.github/workflows/docker.yml` builds and pushes the image to GitHub Container Registry:

- `ghcr.io/<owner>/<repo>:<package.json version>`
- `ghcr.io/<owner>/<repo>:latest`

The workflow uses the built-in `GITHUB_TOKEN` and runs on pushes to `main`, version tags, or manual dispatch. On normal `main` pushes it skips the Docker build when the `package.json` version did not change.

## Notes / limitations

- Telegram Bot API can upload larger documents than it can download through `getFile`. This app caps Telegram parts to 19 MiB by default (`TELEGRAM_PART_SIZE=19922944`) so objects can be restored/downloaded.
- Large single `PUT Object` uploads are buffered before they are sent to Telegram, so logs will show raw-body progress first and Telegram upload starts only after the HTTP request body is fully received. Prefer S3 multipart uploads for very large files when your client supports them.
- Objects uploaded with older/default `TELEGRAM_PART_SIZE` values above 20 MiB may be stored in Telegram but cannot be downloaded via the Bot API. Delete and re-upload those objects with `TELEGRAM_PART_SIZE <= 19922944`.
- Metadata must be backed up/persisted. Losing `/data/metadata.json` loses the S3 key listing even though files still exist in Telegram.
- S3 `DELETE Object`, object overwrites, and multipart aborts try to delete related Telegram messages. Telegram deletion depends on Bot API permissions/limits, and objects uploaded before message IDs were stored in metadata cannot be deleted from Telegram automatically.
- This is intended for private backup storage, not a public multi-tenant S3 service.
