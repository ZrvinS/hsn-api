/**
 * SSRF / outbound hardening tests (SEC-33..SEC-36) against a local TLS server.
 * The test certificate is generated at runtime (no key material in the repo, AG-10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboundHttpClient, type OutboundClientOptions, type ResolvedAddress } from '../../src/adapters/httpClient.js';

const HOST = 'products.test';
let dir = '';
let cert = '';
let server: https.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hsn-tls-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' });
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const key = readFileSync(join(dir, 'key.pem'), 'utf8');
  server = https.createServer({ key, cert }, (req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    if (path.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 1, ua: req.headers['user-agent'], cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }));
    } else if (path.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"status":0}');
    } else if (path.startsWith('/redirect')) {
      res.writeHead(302, { location: 'http://127.0.0.1/ok', 'content-type': 'application/json' });
      res.end('{}');
    } else if (path.startsWith('/big-declared')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(300 * 1024) });
      res.end('"' + 'a'.repeat(300 * 1024 - 2) + '"');
    } else if (path.startsWith('/big-chunked')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'a'.repeat(16 * 1024);
      res.write('"');
      for (let i = 0; i < 20; i++) res.write(chunk);
      res.end('"');
    } else if (path.startsWith('/slow')) {
      // never answers within the client's timeout
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }
      }, 2000).unref();
    } else if (path.startsWith('/html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else if (path.startsWith('/badjson')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":');
    } else if (path.startsWith('/500')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    } else if (path.startsWith('/jsonseq')) {
      res.writeHead(200, { 'content-type': 'application/json-seq' });
      res.end('{}');
    } else if (path.startsWith('/gzip')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{"a":1}'));
    } else if (path.startsWith('/drip')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[');
      const iv = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(iv);
        res.write('1,');
      }, 200);
      iv.unref();
    } else if (path.startsWith('/nested')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('['.repeat(100_000) + ']'.repeat(100_000));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function client(over: Partial<OutboundClientOptions> & { resolveTo?: string[]; allowLoopback?: boolean } = {}) {
  const resolverCalls: string[] = [];
  const addrs: ResolvedAddress[] = (over.resolveTo ?? ['127.0.0.1']).map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
  const c = new OutboundHttpClient({
    allowlist: [HOST],
    userAgent: 'hsn-api-test/0.1 (+test)',
    hostPerMin: { [HOST]: 10_000 },
    ...over,
    testOnly: {
      resolver: async (h) => (resolverCalls.push(h), addrs),
      ...(over.allowLoopback === false ? {} : { isAddressAllowed: (ip: string) => ip === '127.0.0.1' }),
      port,
      ca: cert,
    },
  });
  return { c, resolverCalls };
}
const url = (p: string, host = HOST) => `https://${host}:${port}${p}`;

describe('OutboundHttpClient', () => {
  it('fetches allow-listed JSON over TLS with only our User-Agent', async () => {
    const { c } = client();
    const r = await c.getJson(url('/ok'));
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) expect(r.body).toEqual({ status: 1, ua: 'hsn-api-test/0.1 (+test)', cookie: null, auth: null });
  });

  it('returns 404 bodies to the adapter (not-found is not an error)', async () => {
    const { c } = client();
    expect(await c.getJson(url('/missing'))).toMatchObject({ ok: true, status: 404 });
  });

  it('refuses a non-allow-listed host without DNS or a socket', async () => {
    const { c, resolverCalls } = client();
    const before = hits.length;
    expect(await c.getJson(url('/ok', 'evil.test'))).toEqual({ ok: false, error: 'host_not_allowed' });
    expect(await c.getJson(url('/ok', 'products.test.evil.test'))).toEqual({ ok: false, error: 'host_not_allowed' });
    expect(resolverCalls).toEqual([]);
    expect(hits.length).toBe(before);
  });

  it.each([
    [`http://${HOST}/ok`, 'bad_url'],
    [`ftp://${HOST}/ok`, 'bad_url'],
    [`https://user:pw@${HOST}/ok`, 'bad_url'],
    [`https://${HOST}:8443/ok`, 'bad_url'],
    ['not a url', 'bad_url'],
  ])('refuses %s', async (u, error) => {
    const { c, resolverCalls } = client();
    expect(await c.getJson(u)).toEqual({ ok: false, error });
    expect(resolverCalls).toEqual([]);
  });

  it('refuses the cloud metadata IP as a host (not allow-listed)', async () => {
    const { c, resolverCalls } = client();
    expect(await c.getJson(`https://169.254.169.254:${port}/latest/meta-data`)).toEqual({ ok: false, error: 'host_not_allowed' });
    expect(resolverCalls).toEqual([]);
  });

  it.each([['127.0.0.1'], ['10.0.0.5'], ['169.254.169.254'], ['::1'], ['::ffff:127.0.0.1']])(
    'blocks a host that resolves to private address %s (no request reaches the server)',
    async (ip) => {
      const { c } = client({ resolveTo: [ip], allowLoopback: false });
      const before = hits.length;
      expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'blocked_address' });
      expect(hits.length).toBe(before);
    },
  );

  it('blocks when any resolved address is private (rebinding-style mixed answer)', async () => {
    const { c } = client({ resolveTo: ['8.8.8.8', '127.0.0.1'], allowLoopback: false });
    expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'blocked_address' });
  });

  it('blocks an allow-listed IP literal that is private', async () => {
    const c = new OutboundHttpClient({ allowlist: ['127.0.0.1'], userAgent: 'x', testOnly: { port, ca: cert } });
    expect(await c.getJson(`https://127.0.0.1:${port}/ok`)).toEqual({ ok: false, error: 'blocked_address' });
  });

  it('does not follow redirects (one request only)', async () => {
    const { c } = client();
    const before = hits.length;
    expect(await c.getJson(url('/redirect'))).toEqual({ ok: false, error: 'redirect', status: 302 });
    expect(hits.slice(before)).toEqual(['/redirect']);
  });

  it('aborts oversized bodies (declared and streamed) at 256 KiB', async () => {
    const { c } = client();
    expect(await c.getJson(url('/big-declared'))).toEqual({ ok: false, error: 'too_large' });
    expect(await c.getJson(url('/big-chunked'))).toEqual({ ok: false, error: 'too_large' });
  });

  it('times out a slow server', async () => {
    const { c } = client({ timeoutMs: 300 });
    const t0 = Date.now();
    expect(await c.getJson(url('/slow'))).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('never allows a timeout above 3 s or a cap above 256 KiB', async () => {
    const { c } = client({ timeoutMs: 60_000, maxBytes: 10 * 1024 * 1024 });
    expect(await c.getJson(url('/big-chunked'))).toEqual({ ok: false, error: 'too_large' });
  });

  it('rejects non-JSON, malformed JSON and unexpected statuses', async () => {
    const { c } = client();
    expect(await c.getJson(url('/html'))).toEqual({ ok: false, error: 'bad_content_type' });
    expect(await c.getJson(url('/badjson'))).toEqual({ ok: false, error: 'bad_json' });
    expect(await c.getJson(url('/500'))).toEqual({ ok: false, error: 'http_status', status: 500 });
  });

  it('rejects a server whose certificate is not trusted', async () => {
    const c = new OutboundHttpClient({ allowlist: [HOST], userAgent: 'x', testOnly: { resolver: async () => [{ address: '127.0.0.1', family: 4 }], isAddressAllowed: () => true, port } });
    expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'network' });
  });

  it('opens the circuit after consecutive failures', async () => {
    let now = 1_000_000;
    const { c } = client({ breakerThreshold: 3, breakerCooldownMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) expect((await c.getJson(url('/500'))).ok).toBe(false);
    const before = hits.length;
    expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'circuit_open' });
    expect(hits.length).toBe(before);
    now += 61_000;
    expect((await c.getJson(url('/ok'))).ok).toBe(true);
  });

  it('limits concurrency', async () => {
    const { c } = client({ maxConcurrent: 1, timeoutMs: 300 });
    const [a, b] = await Promise.all([c.getJson(url('/slow')), c.getJson(url('/ok'))]);
    expect(a).toEqual({ ok: false, error: 'timeout' });
    expect(b).toEqual({ ok: false, error: 'busy' });
  });

  // ---- round 2 (SA-K-06, SA-K-15, SA-K-18)
  it('SA-K-06: per-host request budget refuses calls without contacting the host', async () => {
    const { c } = client({ hostPerMin: { [HOST]: 2 } });
    const before = hits.length;
    expect((await c.getJson(url('/ok'))).ok).toBe(true);
    expect((await c.getJson(url('/ok'))).ok).toBe(true);
    expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'rate_budget' });
    expect(hits.length - before).toBe(2);
  });

  it('SA-K-06: the default budget is conservative (10/min) when a host has no setting', async () => {
    const c = new OutboundHttpClient({ allowlist: [HOST], userAgent: 'x', testOnly: { resolver: async () => [{ address: '127.0.0.1', family: 4 }], isAddressAllowed: (ip) => ip === '127.0.0.1', port, ca: cert } });
    const res = [];
    for (let i = 0; i < 11; i++) res.push(await c.getJson(url('/ok')));
    expect(res.filter((r) => r.ok)).toHaveLength(10);
    expect(res[10]).toEqual({ ok: false, error: 'rate_budget' });
  });

  it('SA-K2-03: one key cannot take more than its share of a host budget; another key still gets through', async () => {
    const { c } = client({ hostPerMin: { [HOST]: 9 } }); // default share 1/3 → 3 per key per minute
    const before = hits.length;
    const attacker = [];
    for (let i = 0; i < 6; i++) attacker.push(await c.getJson(url('/ok'), 'key_attacker'));
    expect(attacker.filter((r) => r.ok)).toHaveLength(3);
    expect(attacker[5]).toEqual({ ok: false, error: 'rate_budget' });
    const victim = await c.getJson(url('/ok'), 'key_victim');
    expect(victim.ok).toBe(true);
    expect(hits.length - before).toBe(4); // refused partition calls never reach the host nor spend shared tokens
  });

  it('SA-K3-03/06: partitions are capped; an idle LRU partition is evicted, active ones never are', async () => {
    let t = 1_000_000;
    const { c } = client({ hostPerMin: { [HOST]: 30 }, maxPartitions: 2, now: () => t });
    expect((await c.getJson(url('/ok'), 'tenant:a')).ok).toBe(true);
    expect((await c.getJson(url('/ok'), 'tenant:b')).ok).toBe(true);
    // both partitions active: a third is refused (no reset of anyone's budget, no request made)
    const before = hits.length;
    expect(await c.getJson(url('/ok'), 'tenant:c')).toEqual({ ok: false, error: 'rate_budget' });
    expect(hits.length).toBe(before);
    expect(c.partitionCount).toBe(2);
    // a is used again → b becomes least recently used
    t += 30_000;
    expect((await c.getJson(url('/ok'), 'tenant:a')).ok).toBe(true);
    t += 31_000; // b idle for 61 s, a for 31 s
    expect((await c.getJson(url('/ok'), 'tenant:c')).ok).toBe(true);
    expect(c.partitionCount).toBe(2);
    // a was kept (not cleared): its spent tokens still count
    for (let i = 0; i < 20; i++) await c.getJson(url('/ok'), 'tenant:a');
    expect(await c.getJson(url('/ok'), 'tenant:a')).toEqual({ ok: false, error: 'rate_budget' });
  });

  it('SA-K4-03: refused calls do not keep a partition slot alive', async () => {
    let t = 2_000_000;
    // share 1/3 of 3/min → 1 token per partition per minute; a single slot
    const { c } = client({ hostPerMin: { [HOST]: 3 }, maxPartitions: 1, now: () => t });
    expect((await c.getJson(url('/ok'), 'tenant:a')).ok).toBe(true);
    // a hammers its empty bucket every 10 s; the refusals must not refresh its slot
    for (let i = 0; i < 5; i++) {
      t += 10_000;
      expect(await c.getJson(url('/ok'), 'tenant:a')).toEqual({ ok: false, error: 'rate_budget' });
    }
    // 61 s after a's last GRANTED call, a is idle (its bucket is full again): the victim gets the slot
    t += 11_000;
    expect((await c.getJson(url('/ok'), 'tenant:victim')).ok).toBe(true);
    expect(c.partitionCount).toBe(1);
  });

  it('SA-K-15: application/json-seq is not JSON', async () => {
    const { c } = client();
    expect(await c.getJson(url('/jsonseq'))).toEqual({ ok: false, error: 'bad_content_type' });
  });

  it('SA-K-18: compressed responses are refused (cap cannot be bypassed by decompression)', async () => {
    const { c } = client();
    expect(await c.getJson(url('/gzip'))).toEqual({ ok: false, error: 'bad_content_type' });
  });

  it('SA-K-18: a slow-drip body is killed by the 3 s total timeout (no override)', async () => {
    const { c } = client();
    const t0 = Date.now();
    expect(await c.getJson(url('/drip'))).toEqual({ ok: false, error: 'timeout' });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(4000);
  }, 10_000);

  it('SA-K-18: a hanging DNS resolver is killed by the connect timeout', async () => {
    const c = new OutboundHttpClient({ allowlist: [HOST], userAgent: 'x', hostPerMin: { [HOST]: 100 }, testOnly: { resolver: () => new Promise(() => undefined), port, ca: cert } });
    const t0 = Date.now();
    expect(await c.getJson(url('/ok'))).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2600);
  }, 10_000);

  it('SA-K-18: rebinding — the resolver is called exactly once per request and the checked address is used', async () => {
    const { c, resolverCalls } = client();
    await c.getJson(url('/ok'));
    expect(resolverCalls).toEqual([HOST]);
  });

  it('SA-K-18: deeply nested JSON does not crash the client', async () => {
    const { c } = client();
    const r = await c.getJson(url('/nested'));
    expect(r.ok === true || (r.ok === false && r.error === 'bad_json')).toBe(true);
  });

  it('SA-K-18: HTTPS_PROXY in the environment is ignored (no proxy connection)', async () => {
    let proxyConnections = 0;
    const proxy = net.createServer((s) => {
      proxyConnections++;
      s.destroy();
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
    process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    process.env.https_proxy = process.env.HTTPS_PROXY;
    try {
      const { c } = client();
      expect((await c.getJson(url('/ok'))).ok).toBe(true);
      expect(proxyConnections).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });
});
