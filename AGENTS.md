# Project conventions

## Control flow

- Always use braces for conditional blocks, loops, and callbacks with conditional early returns.
- Do not write inline one-line conditionals.

Bad:

```ts
if (condition) return value;
if (condition) doSomething();
```

Good:

```ts
if (condition) {
  return value;
}

if (condition) {
  doSomething();
}
```

## Configuration and environment variables

- Do not use arbitrary hardcoded fallback values for environment-based configuration.
- Secrets and deployment-specific values must be read with `requiredEnv(name)` from `src/common/env.ts`.
- Optional settings may use explicit, documented defaults only when the default is a real application default, not a placeholder credential or random sample value.

Bad:

```ts
const accessKey = process.env.S3_ACCESS_KEY_ID ?? 'example-access-key';
const bucket = process.env.S3_BUCKET ?? 'example-bucket';
```

Good:

```ts
const accessKey = requiredEnv('S3_ACCESS_KEY_ID');
const bucket = requiredEnv('S3_BUCKET');
```

## Defined / undefined checks

- Do not use broad falsy checks for nullable or optional values, e.g. `if (!value)`.
- Use shared assertion utilities from `src/common/assertions.ts`:
  - `isDefined(value)`
  - `isNotDefined(value)`
  - `assertDefined(value, message)`
- Use explicit checks for empty strings, zero, and boolean values.

Bad:

```ts
if (!upload) {
  throw new Error('Missing upload');
}

if (!envValue) {
  throw new Error('Missing env');
}
```

Good:

```ts
if (isNotDefined(upload)) {
  throw new Error('Missing upload');
}

if (isNotDefined(envValue) || envValue.length === 0) {
  throw new Error('Missing env');
}
```

## Project structure

- Divide code into logical modules instead of keeping many unrelated files in one directory.
- Use feature folders and Nest modules for major areas.
- Keep cross-cutting utilities in `src/common`.

Current layout:

```txt
src/common              Shared utilities
src/s3                  S3 API, auth, S3 types
src/storage/telegram    Telegram Bot API storage adapter
src/storage/metadata    Persistent object metadata store
```

## NestJS modules

- Every major logical piece should have its own `*.module.ts`.
- Root `AppModule` should compose feature modules instead of directly registering all providers.
