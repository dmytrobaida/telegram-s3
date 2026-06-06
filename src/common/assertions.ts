export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function isNotDefined(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function assertDefined<T>(value: T | null | undefined, message = 'Expected value to be defined'): asserts value is T {
  if (isNotDefined(value)) {
    throw new Error(message);
  }
}
