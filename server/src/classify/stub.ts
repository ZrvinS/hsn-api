import { AppError } from '../lib/problem.js';
import type { Classifier } from './types.js';

/** Used only when no classifier implementation is injected/available: always 503. */
export const unavailableClassifier: Classifier = {
  async classify() {
    throw new AppError('classifier_unavailable', 'Product classification is not available on this deployment. Use GET /v1/hsn/search instead.');
  },
};
