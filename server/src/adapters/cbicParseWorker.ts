/**
 * Worker-thread entry for parseCbicListing (SA-C2-01). The listing page is untrusted: parsing it off the
 * main thread means a pathological page can at worst burn this worker until the caller's hard timeout
 * terminates it; the API listeners keep serving.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseCbicListing, type CbicPage, type ParseOptions } from './cbicWatcher.js';

interface Job {
  html: string;
  page: CbicPage;
  opts: ParseOptions;
  /** test seam: spin this long before parsing, to exercise the caller's timeout */
  testOnlyBusyMs?: number;
}

const job = workerData as Job;
parentPort!.postMessage({ ready: true });
if (job.testOnlyBusyMs !== undefined) {
  const end = Date.now() + job.testOnlyBusyMs;
  while (Date.now() < end) {
    // busy wait (test only)
  }
}
parentPort!.postMessage({ result: parseCbicListing(job.html, job.page, job.opts) });
