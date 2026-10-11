import type { AppConfig } from './config.js';
import type { Clock } from './lib/clock.js';
import type { Storage } from './repositories/sqlite/index.js';
import type { RateService } from './services/rates.js';
import type { TaxService } from './services/tax.js';
import type { ProposalService } from './services/proposals.js';
import type { Classifier } from './classify/types.js';
import type { Scope } from './lib/apiKey.js';
import type { DatasetState } from './repositories/types.js';

/** Results of one-time boot checks (SA-C-20, SA-C-11). */
export interface BootChecks {
  fts5: boolean;
  /** recomputed content hash equals the stored hash of the current dataset version */
  datasetIntegrity: boolean;
  /** SA-C2-02: audit chain verifies and explains the published state (services/integrity.ts) */
  auditIntegrity: boolean;
  /** SA-C2-06: database not behind the recorded high-water mark (or the restore was acknowledged) */
  stateContinuity: boolean;
  restore: 'disabled' | 'ok' | 'initialised' | 'restore_detected' | 'hwm_invalid' | 'hwm_missing';
}

/** Everything route modules need; built once in buildApp. */
export interface AppContext {
  config: AppConfig;
  clock: Clock;
  storage: Storage;
  rates: RateService;
  tax: TaxService;
  proposals: ProposalService;
  classifier: Classifier;
  boot: BootChecks;
  /** current dataset pointer, or throws 503 dataset-not-loaded */
  dataset(): DatasetState;
}

export interface AuthInfo {
  keyId: string;
  prefix: string;
  tenant: string;
  /** admin actor handle (admin keys only) */
  actor: string | null;
  /** admin_actors.id (admin keys only) */
  actorId: string | null;
  scopes: Scope[];
  llmOptOut: boolean;
}

export type RouteScope = Scope | 'public';

/** One registered route (SA-C-08: the real route table is enumerated in tests). */
export interface RouteEntry {
  method: string;
  url: string;
  scope: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: RouteEntry[];
  }
  interface FastifyRequest {
    auth: AuthInfo | null;
    startNs: bigint;
    /** caller's X-Request-Id when well-formed (SA-C-12), logged separately */
    clientRequestId: string | null;
    /** tokens charged so far (RateLimit-Cost) */
    rateCost: number;
  }
  interface FastifyContextConfig {
    /** required on every route (SEC-05); 'public' only for health probes and CORS preflight */
    scope?: RouteScope;
    /** token-bucket cost (classify = 5, ruling 11) */
    cost?: number;
    /** extra tokens charged after body validation, e.g. tax = floor(lines/50) (ruling 25) */
    extraCost?: (body: unknown) => number;
    /** counts against the per-key daily quota (SEC-22) */
    quota?: boolean;
  }
}
