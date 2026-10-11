import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { currentSchemaVersion, SCHEMA_VERSION } from '../db/migrate.js';
import { PROBLEM_BASE, PROBLEMS } from '../lib/problem.js';

/**
 * /healthz: liveness. /readyz: readiness from cheap checks only (SA-C-20): a read query, the schema
 * version, the dataset pointer, plus results computed once at boot (FTS5 available, dataset content
 * hash re-verified, SA-C-11). Publicly it returns only a status (SA-D-25); details go to the log.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/healthz',
    { config: { scope: 'public' }, schema: { response: { 200: { type: 'object', properties: { status: { type: 'string' } } } } } },
    async () => ({ status: 'ok' }),
  );

  app.get('/readyz', { config: { scope: 'public' } }, async (request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {
      db: 'fail',
      migrations: 'fail',
      fts5: ctx.boot.fts5 ? 'ok' : 'fail',
      dataset: 'fail',
      dataset_integrity: ctx.boot.datasetIntegrity ? 'ok' : 'fail',
      audit_integrity: ctx.boot.auditIntegrity ? 'ok' : 'fail',
      state_continuity: ctx.boot.stateContinuity ? 'ok' : 'fail',
    };
    try {
      ctx.storage.readDb.prepare('SELECT 1 AS one').get();
      checks.db = 'ok';
      checks.migrations = currentSchemaVersion(ctx.storage.readDb) === SCHEMA_VERSION ? 'ok' : 'fail';
      checks.dataset = ctx.storage.read.dataset.current() !== null ? 'ok' : 'fail';
    } catch {
      // leave remaining checks as 'fail'; never echo the error
    }
    reply.header('Cache-Control', 'no-store');
    if (Object.values(checks).every((v) => v === 'ok')) return { status: 'ready' };
    request.log.warn({ event: 'readyz.not_ready', checks }, 'not ready');
    return reply
      .code(503)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: PROBLEM_BASE + PROBLEMS.not_ready.slug,
        title: PROBLEMS.not_ready.title,
        status: 503,
        detail: 'Service not ready.',
        instance: '/readyz',
        request_id: request.id,
        code: 'not_ready',
      });
  });
}
