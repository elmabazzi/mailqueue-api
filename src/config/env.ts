import { z } from 'zod';

/**
 * Every environment variable the application understands, with its rules and defaults.
 * New variables (e.g. RESEND_API_KEY) are added here in the stage that needs them.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce
    .number({ error: 'PORT must be a number' })
    .int('PORT must be a whole number')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'DATABASE_URL must be a postgres:// or postgresql:// connection URL',
  }),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates a set of environment variables and returns a typed, read-only config.
 *
 * - Empty values (`PORT=`) are treated as "not set", so defaults still apply.
 * - Error messages name the broken variable but never print its value,
 *   because values such as DATABASE_URL contain passwords.
 */
export function parseConfig(source: Readonly<Record<string, string | undefined>>): Config {
  const provided = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = EnvSchema.safeParse(provided);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }

  return Object.freeze(result.data);
}

let cachedConfig: Config | undefined;

/** Returns the validated config for this process (parsed once, on first use). */
export function getConfig(): Config {
  cachedConfig ??= parseConfig(process.env);
  return cachedConfig;
}
