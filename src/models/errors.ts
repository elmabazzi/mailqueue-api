/**
 * Domain errors: thrown by services and the data layer, and translated into
 * HTTP responses only by the api layer. They carry no HTTP status codes.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class EmailJobNotFoundError extends DomainError {
  readonly code = 'EMAIL_JOB_NOT_FOUND';
  override readonly name = 'EmailJobNotFoundError';

  constructor(readonly emailJobId: string) {
    super(`Email job ${emailJobId} was not found`);
  }
}

/** The email provider refused or failed to send an email. */
export class EmailDeliveryError extends DomainError {
  readonly code = 'EMAIL_DELIVERY_FAILED';
  override readonly name = 'EmailDeliveryError';

  constructor(
    message: string,
    /** true when trying again later might succeed (e.g. rate limit, provider outage). */
    readonly retryable: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}
