import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Thrown when a request's body, params or query does not match its schema (-> HTTP 400). */
export class RequestValidationError extends Error {
  override readonly name = 'RequestValidationError';

  constructor(
    readonly location: 'body' | 'params' | 'query',
    readonly issues: ValidationIssue[],
  ) {
    super(`Invalid request ${location}`);
  }
}

/** Validates request input and returns it typed, or throws RequestValidationError. */
export function parseRequest<S extends z.ZodType>(
  schema: S,
  input: unknown,
  location: RequestValidationError['location'],
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(
      location,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || location,
        message: issue.message,
      })),
    );
  }
  return result.data;
}
