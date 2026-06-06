# Telegram S3

Telegram S3 is an S3-compatible HTTP server that stores object data in Telegram using a bot. It is useful for small/private backup storage where you want S3-compatible clients to write files, while the actual bytes are stored as Telegram document messages.

The server exposes an S3-like API, validates AWS Signature V4 requests, stores file parts in Telegram, and keeps S3 metadata in a local JSON file.

## Quick start with Docker

### 1. Create a Telegram bot

1. Open Telegram and message `@BotFather`.
2. Create a bot and copy its token.
3. Add the bot to a private group/channel, or send a message to the bot directly.
4. Get the chat ID and use it as `TELEGRAM_CHAT_ID`.

### 2. Create `.env`

```bash
mkdir telegram-s3
cd telegram-s3
curl -o docker-compose.yml https://raw.githubusercontent.com/dmytrobaida/telegram-s3/main/docker-compose.yml
curl -o .env.example https://raw.githubusercontent.com/dmytrobaida/telegram-s3/main/.env.example
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-telegram-chat-id

S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1

METADATA_FILE=./data/metadata.json
TELEGRAM_PART_SIZE=19922944
MAX_OBJECT_SIZE=500mb
```

### 3. Run

```bash
docker compose up -d
```

The compose file uses:

```txt
ghcr.io/dmytrobaida/telegram-s3:latest
```

and persists metadata in a Docker volume.

### 4. Configure your S3 client

Use these values with any S3-compatible client:

| Field | Value |
| --- | --- |
| Provider | Custom / S3-compatible provider |
| Endpoint | `http://your-server:3000` or your HTTPS domain |
| Access Key Id | value of `S3_ACCESS_KEY_ID` |
| Secret Access Key | value of `S3_SECRET_ACCESS_KEY` |
| Bucket | value of `S3_BUCKET` |
| Region | value of `S3_REGION`, for example `us-east-1` |

The server supports path-style URLs like:

```txt
/bucket/key
```

## Run with Docker directly

```bash
cp .env.example .env
# edit .env
docker run \
  --env-file .env \
  -p 3000:3000 \
  -v telegram-s3-data:/data \
  ghcr.io/dmytrobaida/telegram-s3:latest
```

For `docker run`, pass `.env` explicitly with `--env-file .env`.

## Run locally for development

The app loads `.env` automatically when running with Node/Nest locally.

```bash
npm install
cp .env.example .env
# edit .env
npm run start:dev
```

For local runs, use:

```env
METADATA_FILE=./data/metadata.json
```

Do not use `/data/metadata.json` locally unless that directory exists. `/data` is intended for Docker containers with a mounted volume.

## Run local Docker build

Use this when you want to build the image from the local `Dockerfile` instead of pulling GHCR.

```bash
cp .env.example .env
# edit .env
npm run docker:local
```

Stop it:

```bash
npm run docker:local:down
```

## Environment variables

Required:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from `@BotFather` |
| `TELEGRAM_CHAT_ID` | Chat, group, or channel ID where files are sent |
| `S3_ACCESS_KEY_ID` | S3 access key clients must use |
| `S3_SECRET_ACCESS_KEY` | S3 secret key clients must use |
| `S3_BUCKET` | Single bucket name exposed by this server |
| `S3_REGION` | S3 region string, for example `us-east-1` |

Optional:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `METADATA_FILE` | `/data/metadata.json` in app defaults | Metadata JSON path |
| `TELEGRAM_PART_SIZE` | `19922944` | Telegram chunk size. Keep below 20 MiB for downloads. |
| `MAX_OBJECT_SIZE` | `200mb` | Max incoming single-request object size |

## Metadata persistence is critical

Telegram stores the bytes, but `metadata.json` maps S3 object keys to Telegram `file_id`s and message IDs.

If `metadata.json` is lost, the app cannot reliably reconstruct S3 objects from Telegram. Always persist and back up this file/volume.

Docker examples persist it in a volume mounted at:

```txt
/data/metadata.json
```

## Supported S3 operations

Implemented:

- `PUT Object`
- `GET Object`
- `HEAD Object`
- `DELETE Object`
- `CopyObject` for copy/rename workflows
- `ListObjectsV1`
- `ListObjectsV2`
- multipart upload:
  - initiate
  - upload part
  - list uploads
  - list parts
  - complete
  - abort
- AWS Signature V4 header authentication
- AWS Signature V4 presigned query authentication

## Limitations

This is not a full S3 implementation.

Important limitations:

- Only one configured bucket is supported.
- No bucket creation/deletion API.
- No ACLs, policies, IAM, users, or permissions beyond one access/secret key pair.
- No object versioning.
- No server-side encryption API.
- No object tagging API.
- No lifecycle rules.
- No storage classes beyond returning `STANDARD` in responses.
- No range requests yet. `GET Object` returns the full object.
- Large single `PUT Object` uploads are buffered in memory before upload to Telegram.
- Telegram Bot API can upload larger documents than it can download with `getFile`; parts are capped to 19 MiB by default so downloads/restores work.
- Telegram deletion depends on Bot API permissions and Telegram limits.
- Objects uploaded before message IDs were stored in metadata cannot be deleted from Telegram automatically.
- This is intended for private backup/storage use, not public multi-tenant object storage.

## Large files

For large files, prefer clients that use S3 multipart upload.

Single `PUT Object` uploads are accepted, but the request body is buffered before it is split into Telegram parts. During a large upload, logs show raw body progress first; Telegram upload starts after the HTTP body is fully received.

Objects uploaded with old `TELEGRAM_PART_SIZE` values above 20 MiB may be stored in Telegram but cannot be downloaded through the Bot API. Delete and re-upload them with:

```env
TELEGRAM_PART_SIZE=19922944
```

## Docker image publishing

The public image is available at:

```txt
ghcr.io/dmytrobaida/telegram-s3:latest
```

Version tags are also published, for example:

```txt
ghcr.io/dmytrobaida/telegram-s3:0.3.0
```

The GitHub Actions workflow publishes:

- `ghcr.io/dmytrobaida/telegram-s3:<package.json version>`
- `ghcr.io/dmytrobaida/telegram-s3:latest`

On normal `main` pushes, Docker publishing is skipped if the `package.json` version did not change.

## Build locally

```bash
docker build -t telegram-s3 .
docker run --env-file .env -p 3000:3000 -v telegram-s3-data:/data telegram-s3
```
