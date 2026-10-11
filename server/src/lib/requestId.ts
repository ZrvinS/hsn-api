import { newId } from './ids.js';

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Server request ids are always req_<ULID> (SA-C-12); a client X-Request-Id is never adopted. */
export function newRequestId(): string {
  return newId('req');
}

/** A well-formed client X-Request-Id, logged separately as client_request_id; null otherwise. */
export function clientRequestId(header: string | string[] | undefined): string | null {
  return typeof header === 'string' && CLIENT_ID_RE.test(header) ? header : null;
}
