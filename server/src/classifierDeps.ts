/** Wiring of the classifier's dependencies (kept out of main.ts so it can be tested without booting). */
import type { FastifyBaseLogger } from 'fastify';
import type { ClassifierDeps } from './classify/types.js';
import type { Storage } from './repositories/sqlite/index.js';
import type { AppConfig } from './config.js';
import { systemClock } from './lib/clock.js';

/** Classifier deps; `log` is the app's redacting pino child logger (SA-C-13). */
export function classifierDeps(storage: Storage, config: AppConfig, log: FastifyBaseLogger): ClassifierDeps {
  const deps: ClassifierDeps = {
    hsn: storage.read.hsn,
    synonyms: storage.read.synonyms,
    products: storage.cache.products, // SEC-91: cache-writer connection
    config,
    clock: systemClock,
    log,
    datasetVersion: () => storage.read.dataset.current()?.current_version ?? '',
  };
  return deps;
}

