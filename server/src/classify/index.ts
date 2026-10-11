/**
 * Classifier composition (contract in ./types.ts). Builds the deterministic pipeline, the
 * product lookup adapters that config enables (all off by default), the outbound budgets
 * (ruling 25) and the disabled re-ranker.
 */
import type { Classifier, ClassifierDeps } from './types.js';
import { ClassifierPipeline } from './pipeline.js';
import { OutboundHttpClient } from '../adapters/httpClient.js';
import { OpenFactsAdapter } from '../adapters/openFoodFacts.js';
import type { ProductLookup } from '../adapters/productLookup.js';
import { CallBudget } from '../adapters/budget.js';
import { DisabledReranker, type Reranker } from './rerank.js';

export interface ClassifierOverrides {
  adapters?: readonly ProductLookup[];
  reranker?: Reranker;
}

const OFF_HOST = 'world.openfoodfacts.org';
const OBF_HOST = 'world.openbeautyfacts.org';

/** Adapters are built only if the kill switch, the per-adapter flag and the allow-list all permit. */
export function buildAdapters(config: ClassifierDeps['config'], now: () => number = Date.now): ProductLookup[] {
  if (!config.adaptersEnabled) return [];
  const allow = config.outboundAllowlist;
  const wantOff = config.offEnabled && allow.includes(OFF_HOST);
  const wantObf = config.obfEnabled && allow.includes(OBF_HOST);
  if (!wantOff && !wantObf) return [];
  const ua = config.offUserAgent;
  if (ua === null || ua.length === 0) return [];
  const http = new OutboundHttpClient({
    allowlist: [...(wantOff ? [OFF_HOST] : []), ...(wantObf ? [OBF_HOST] : [])],
    userAgent: ua,
    maxConcurrent: config.outbound.queueMax,
    // ruling 25 / SA-K-06: Open Food Facts publishes 15 product reads/min/IP
    hostPerMin: { [OFF_HOST]: config.outbound.offPerMin, [OBF_HOST]: config.outbound.obfPerMin },
    now,
  });
  const out: ProductLookup[] = [];
  if (wantOff) out.push(new OpenFactsAdapter('open_food_facts', http));
  if (wantObf) out.push(new OpenFactsAdapter('open_beauty_facts', http));
  return out;
}

export function createClassifier(deps: ClassifierDeps, overrides: ClassifierOverrides = {}): Classifier {
  const now = (): number => deps.clock.now().getTime();
  return new ClassifierPipeline({
    hsn: deps.hsn,
    synonyms: deps.synonyms,
    products: deps.products,
    clock: deps.clock,
    log: deps.log,
    adapters: overrides.adapters ?? buildAdapters(deps.config, now),
    // No LLM provider is implemented in v1; enabling HSN_LLM_ENABLED still yields the disabled re-ranker.
    reranker: overrides.reranker ?? new DisabledReranker(),
    llmBudget: new CallBudget(deps.config.llm.callsPerMin, deps.config.llm.callsPerDay, now),
    perKeyDailyLookups: deps.config.outbound.perKeyDaily,
    ...(deps.datasetVersion ? { datasetVersion: deps.datasetVersion } : {}),
  });
}
