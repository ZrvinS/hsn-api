/**
 * RFC 9457 problem details. One registry maps a short machine `code` to a stable
 * type URI, title and HTTP status. Services throw AppError; the app's error handler
 * renders application/problem+json.
 */
export const PROBLEM_BASE = 'https://hsn-api.example/problems/';

export const PROBLEMS = {
  idempotency_key_required: { slug: 'idempotency-key-required', status: 400, title: 'Idempotency-Key header required' },
  validation_failed: { slug: 'validation-failed', status: 400, title: 'Request validation failed' },
  unauthenticated: { slug: 'unauthenticated', status: 401, title: 'API key missing or invalid' },
  forbidden_scope: { slug: 'insufficient-scope', status: 403, title: 'API key lacks a required scope' },
  forbidden_ip: { slug: 'forbidden-ip', status: 403, title: 'Client address not allowed for admin keys' },
  not_proposer: { slug: 'not-proposer', status: 403, title: 'Only the proposer may withdraw a proposal' },
  maker_checker_violation: { slug: 'maker-checker-violation', status: 403, title: 'Approver must differ from proposer' },
  not_found: { slug: 'not-found', status: 404, title: 'Resource not found' },
  hsn_not_found: { slug: 'hsn-not-found', status: 404, title: 'HSN/SAC code not found' },
  proposal_not_found: { slug: 'proposal-not-found', status: 404, title: 'Rate proposal not found' },
  method_not_allowed: { slug: 'method-not-allowed', status: 405, title: 'Method not allowed' },
  overlapping_rule: { slug: 'overlapping-rule', status: 409, title: 'Overlapping rate rule' },
  proposal_not_pending: { slug: 'proposal-not-pending', status: 409, title: 'Proposal is not pending' },
  idempotency_conflict: { slug: 'idempotency-conflict', status: 409, title: 'Idempotency key reused with a different request' },
  proposal_hash_mismatch: { slug: 'proposal-hash-mismatch', status: 409, title: 'expected_sha256 does not match the proposal' },
  duplicate_notification: { slug: 'duplicate-notification', status: 409, title: 'Notification is already being watched' },
  proposer_disabled: { slug: 'proposer-disabled', status: 409, title: 'Proposal was made by a disabled actor' },
  source_url_not_document: { slug: 'source-url-not-document', status: 400, title: 'The rule cites an index page; verify needs the notification document URL' },
  proposal_stale: { slug: 'proposal-stale', status: 409, title: 'Proposal no longer applies to the published data' },
  rule_not_active: { slug: 'rule-not-active', status: 409, title: 'Referenced rate rule cannot be changed this way' },
  feed_cursor_expired: { slug: 'feed-window-expired', status: 410, title: 'Change feed position expired' },
  payload_too_large: { slug: 'payload-too-large', status: 413, title: 'Request body too large' },
  unsupported_media_type: { slug: 'unsupported-media-type', status: 415, title: 'Content-Type must be application/json' },
  invalid_gtin: { slug: 'invalid-gtin', status: 422, title: 'Barcode is not a valid GTIN' },
  rule_choice_invalid: { slug: 'rule-choice-invalid', status: 422, title: 'Chosen rule does not apply to this line' },
  unknown_hsn: { slug: 'unknown-hsn', status: 422, title: 'Unknown HSN/SAC code' },
  rate_limited: { slug: 'rate-limited', status: 429, title: 'Too many requests' },
  quota_exceeded: { slug: 'quota-exceeded', status: 429, title: 'Daily quota exceeded' },
  internal: { slug: 'internal', status: 500, title: 'Internal error' },
  not_ready: { slug: 'not-ready', status: 503, title: 'Service not ready' },
  dataset_not_loaded: { slug: 'dataset-not-loaded', status: 503, title: 'Rate dataset not loaded' },
  classifier_unavailable: { slug: 'classifier-unavailable', status: 503, title: 'Classifier not available' },
  admin_writes_disabled: { slug: 'admin-writes-disabled', status: 503, title: 'Admin writes are disabled' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

export interface FieldError {
  /** RFC 6901 JSON pointer into the request; path/query params use /<name>. */
  pointer: string;
  code: string;
  message: string;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id: string;
  /** the caller's X-Request-Id, echoed separately (SA-C-12) */
  client_request_id?: string;
  code: ProblemCode;
  errors?: FieldError[];
}

export class AppError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ProblemCode,
    public readonly detail?: string,
    public readonly errors?: FieldError[],
    public readonly headers?: Record<string, string>,
  ) {
    super(detail ?? PROBLEMS[code].title);
    this.name = 'AppError';
    this.status = PROBLEMS[code].status;
  }
}

export function problemBody(err: AppError, requestId: string, instance: string, clientRequestId: string | null = null): ProblemBody {
  const def = PROBLEMS[err.code];
  const body: ProblemBody = {
    type: PROBLEM_BASE + def.slug,
    title: def.title,
    status: def.status,
    instance,
    request_id: requestId,
    code: err.code,
  };
  if (clientRequestId !== null) body.client_request_id = clientRequestId;
  if (err.detail !== undefined) body.detail = err.detail;
  if (err.errors !== undefined && err.errors.length > 0) body.errors = err.errors;
  return body;
}

export function validationError(errors: FieldError[], detail?: string): AppError {
  return new AppError(
    'validation_failed',
    detail ?? `${errors.length} field${errors.length === 1 ? ' is' : 's are'} invalid. See errors[].`,
    errors,
  );
}
