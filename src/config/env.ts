import { z } from 'zod';

/**
 * Environment variables, validated with Zod.
 *
 * The API process and the worker process need different variables, so each has its own
 * schema built on a shared base. Each process validates its own variables at startup and
 * stops with a clear message if anything is missing or invalid ("fail fast").
 */

const port = z.coerce
  .number({ error: 'PORT must be a number' })
  .int('PORT must be a whole number')
  .min(1, 'PORT must be between 1 and 65535')
  .max(65535, 'PORT must be between 1 and 65535');

const BaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'DATABASE_URL must be a postgres:// or postgresql:// connection URL',
  }),
  DATABASE_SSL: z.stringbool({ error: 'DATABASE_SSL must be true or false' }).default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  // Retry policy. Shared by both processes because the API creates the queue on startup too.
  EMAIL_MAX_RETRIES: z.coerce
    .number()
    .int()
    .min(3, 'EMAIL_MAX_RETRIES must be at least 3')
    .max(10, 'EMAIL_MAX_RETRIES must be at most 10')
    .default(3),
  EMAIL_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
});

// Variables the email worker needs (in the worker process, or in the API with RUN_WORKER_IN_API).
const resendApiKey = z.string().startsWith('re_', 'RESEND_API_KEY must start with "re_"');
const emailFrom = z
  .string()
  .min(3)
  .refine((value) => value.includes('@'), {
    message: 'EMAIL_FROM must contain an email address, e.g. "MailQueue <onboarding@resend.dev>"',
  });
const workerConcurrency = z.coerce.number().int().min(1).max(20).default(2);

const ApiSchema = BaseSchema.extend({
  PORT: port.default(3000),
  API_KEY: z.string().min(16, 'API_KEY must be at least 16 characters long').optional(),

  // Run the email worker inside the API process too: one service instead of two
  // (e.g. on Render's free plan, which has no background workers).
  RUN_WORKER_IN_API: z
    .stringbool({ error: 'RUN_WORKER_IN_API must be true or false' })
    .default(false),
  RESEND_API_KEY: resendApiKey.optional(),
  EMAIL_FROM: emailFrom.optional(),
  WORKER_CONCURRENCY: workerConcurrency,
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_KEY'],
      message: 'API_KEY is required in production so the email endpoints are not public',
    });
  }
  if (env.RUN_WORKER_IN_API) {
    for (const name of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
      if (!env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} is required when RUN_WORKER_IN_API=true`,
        });
      }
    }
  }
});

const WorkerSchema = BaseSchema.extend({
  RESEND_API_KEY: resendApiKey,
  EMAIL_FROM: emailFrom,
  WORKER_CONCURRENCY: workerConcurrency,
});

export type BaseConfig = Readonly<z.infer<typeof BaseSchema>>;
export type ApiConfig = Readonly<z.infer<typeof ApiSchema>>;
export type WorkerConfig = Readonly<z.infer<typeof WorkerSchema>>;

type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates environment variables against a schema.
 * - Empty values (`PORT=`) count as "not set", so defaults still apply.
 * - Error messages name the variable but never print its value (values may be secrets).
 */
function parseWith<S extends z.ZodType>(schema: S, source: EnvSource): Readonly<z.output<S>> {
  const provided = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = schema.safeParse(provided);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  return Object.freeze(result.data);
}

export const parseBaseConfig = (source: EnvSource): BaseConfig => parseWith(BaseSchema, source);
export const parseApiConfig = (source: EnvSource): ApiConfig => parseWith(ApiSchema, source);
export const parseWorkerConfig = (source: EnvSource): WorkerConfig =>
  parseWith(WorkerSchema, source);
