import { isNotDefined } from './assertions';

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (isNotDefined(value) || value.length === 0) {
    throw new Error(`${name} env variable is required`);
  }

  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (isNotDefined(value) || value.length === 0) {
    return undefined;
  }

  return value;
}
