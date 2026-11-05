import { z } from 'zod';

import { EMAIL_STATUSES } from './emailJob.model.js';

/** Request DTO for POST /emails. */
export const CreateEmailRequestSchema = z.strictObject({
  to: z
    .string()
    .trim()
    .max(320, 'to must be at most 320 characters')
    .pipe(z.email({ error: 'to must be a valid email address' })),
  subject: z
    .string({ error: 'subject is required' })
    .trim()
    .min(1, 'subject must not be empty')
    .max(998, 'subject must be at most 998 characters')
    // A line break in a subject could be used to inject extra email headers.
    .regex(/^[^\r\n]*$/, 'subject must not contain line breaks'),
  body: z
    .string({ error: 'body is required' })
    .refine((value) => value.trim().length > 0, 'body must not be empty')
    .refine((value) => value.length <= 100_000, 'body must be at most 100000 characters'),
});
export type CreateEmailRequest = z.infer<typeof CreateEmailRequestSchema>;

/** Path parameters for GET /emails/:id. */
export const EmailIdParamsSchema = z.object({
  id: z.uuid({ error: 'id must be a valid UUID' }),
});

/** Query string for GET /emails. */
export const ListEmailsQuerySchema = z.object({
  status: z
    .enum(EMAIL_STATUSES, { error: 'status must be one of: pending, sent, failed' })
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListEmailsQuery = z.infer<typeof ListEmailsQuerySchema>;
