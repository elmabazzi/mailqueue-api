import { describe, expect, it, vi } from 'vitest';

import {
  isRetryableResendError,
  ResendEmailProvider,
  type ResendClient,
} from '../../../src/data/providers/resend.provider.js';
import { EmailDeliveryError } from '../../../src/models/errors.js';

const email = { to: 'a@example.com', subject: 'Hi', text: 'Hello', idempotencyKey: 'email-job-1' };

function providerReturning(send: ReturnType<typeof vi.fn>) {
  const client = { emails: { send } } as unknown as ResendClient;
  return new ResendEmailProvider({ apiKey: 're_unused', from: 'App <app@example.com>', client });
}

describe('ResendEmailProvider', () => {
  it('sends with the configured sender and idempotency key and returns the message id', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ data: { id: 'resend-123' }, error: null, headers: null });

    await expect(providerReturning(send).send(email)).resolves.toEqual({
      providerMessageId: 'resend-123',
    });
    expect(send).toHaveBeenCalledWith(
      { from: 'App <app@example.com>', to: ['a@example.com'], subject: 'Hi', text: 'Hello' },
      { idempotencyKey: 'email-job-1' },
    );
  });

  it('turns a temporary Resend error into a retryable EmailDeliveryError', async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 },
      headers: null,
    });

    const error = await providerReturning(send)
      .send(email)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error).toMatchObject({ retryable: true, providerCode: 'rate_limit_exceeded' });
  });

  it('turns a validation error into a permanent EmailDeliveryError', async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field', statusCode: 422 },
      headers: null,
    });

    await expect(providerReturning(send).send(email)).rejects.toMatchObject({ retryable: false });
  });

  it('treats network errors (the SDK throwing) as retryable', async () => {
    const send = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(providerReturning(send).send(email)).rejects.toMatchObject({
      retryable: true,
      message: 'Could not reach Resend: fetch failed',
    });
  });
});

describe('isRetryableResendError', () => {
  it.each([
    ['rate_limit_exceeded', 429, true],
    ['internal_server_error', 500, true],
    ['application_error', null, true],
    ['validation_error', 422, false],
    ['invalid_api_key', 403, false],
    ['invalid_from_address', 422, false],
  ] as const)('%s (%s) -> retryable=%s', (name, statusCode, expected) => {
    expect(isRetryableResendError({ name, statusCode })).toBe(expected);
  });
});
