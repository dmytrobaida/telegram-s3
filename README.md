# Telegram S3

A small S3-compatible NestJS/Express server that stores object bytes in Telegram Bot API messages/documents.

## Dokploy destination values

Use these values in Dokploy:

- **Provider**: Any other S3 compatible provider
- **Access Key Id**: value of `S3_ACCESS_KEY_ID`
- **Secret Access Key**: value of `S3_SECRET_ACCESS_KEY`
- **Bucket**: value of `S3_BUCKET`
- **Region**: value of `S3_REGION`, for example `us-east-1` (S3 clients usually require a region even for custom endpoints)
- **Endpoint**: your deployed URL, for example `https://s3.example.com`

The server supports path-style URLs (`/bucket/key`) and virtual-host style when the host starts with the configured bucket.

## Required env vars

See `.env.example`.

Important:

- `TELEGRAM_BOT_TOKEN` is required.
- `TELEGRAM_CHAT_ID` is required because Telegram needs a chat/channel/group where the bot will send stored files.
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `S3_REGION` are required. The app does not provide hardcoded credential or bucket fallbacks.
- Mount `/data` persistently. Telegram stores file bytes, but `/data/metadata.json` maps S3 keys to Telegram `file_id`s.

## Supported S3 operations

Enough for common backup tools:

- `PUT Object`
- `GET Object`
- `HEAD Object`
- `DELETE Object`
- `ListObjectsV2`
- basic multipart upload: initiate, upload part, complete, abort
- AWS Signature V4 header and presigned-query authentication

## Run locally

```bash
npm install
cp .env.example .env
# edit .env
npm run start:dev
```

## Docker

```bash
docker build -t telegram-s3 .
docker run --env-file .env -p 3000:3000 -v telegram-s3-data:/data telegram-s3
```

## Docker Compose

Edit `docker-compose.yml` and replace:

```txt
ghcr.io/YOUR_GITHUB_OWNER/YOUR_REPOSITORY:latest
```

with your real GHCR image name, then run:

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

The compose file persists metadata in the `telegram-s3-data` Docker volume.

## GitHub Actions Docker publishing

`.github/workflows/docker.yml` builds and pushes the image to GitHub Container Registry:

- `ghcr.io/<owner>/<repo>:<package.json version>`
- `ghcr.io/<owner>/<repo>:latest`

The workflow uses the built-in `GITHUB_TOKEN` and runs on pushes to `main`, version tags, or manual dispatch.

## Notes / limitations

- Telegram Bot API upload limit is about 50 MB per document. This app splits regular `PUT Object` uploads into Telegram-sized parts.
- Metadata must be backed up/persisted. Losing `/data/metadata.json` loses the S3 key listing even though files still exist in Telegram.
- This is intended for private backup storage, not a public multi-tenant S3 service.
