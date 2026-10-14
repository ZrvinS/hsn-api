// Minimal HSN Rate API client for Node.js 18+ (uses the built-in fetch). No dependencies.
// Run the demo:  HSN_API_URL=http://localhost:3000 HSN_API_KEY=hsk_... node hsn-client.mjs
// Keep the key on your server. Never ship it in a browser or mobile app.

export class HsnApiError extends Error {
  constructor(problem, status) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.status = status;
    this.type = problem.type; // switch on this, never on title or detail
    this.requestId = problem.request_id;
    this.errors = problem.errors ?? [];
  }
}

export class HsnClient {
  constructor({ baseUrl, apiKey, maxRetries = 3 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
  }

  async request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Retry only 429 and 503, honouring Retry-After. Never retry other 4xx.
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        const wait = Number(res.headers.get('retry-after') ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
        continue;
      }
      const data = await res.json();
      if (!res.ok) throw new HsnApiError(data, res.status);
      return data;
    }
  }

  lookup(code, { date, unitPrice } = {}) {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (unitPrice !== undefined) q.set('unit_price', String(unitPrice));
    const qs = q.toString();
    return this.request('GET', `/v1/hsn/${encodeURIComponent(code)}${qs ? `?${qs}` : ''}`);
  }

  search(text, limit = 10) {
    return this.request('GET', `/v1/hsn/search?${new URLSearchParams({ q: text, limit: String(limit) })}`);
  }

  classify({ name, barcode, unitPrice }) {
    return this.request('POST', '/v1/classify', { name, barcode, unit_price: unitPrice });
  }

  calculateTax(invoice) {
    return this.request('POST', '/v1/tax/calculate', invoice);
  }

  changes(since, limit = 500) {
    return this.request('GET', `/v1/rates/changes?since=${since}&limit=${limit}`);
  }
}

// Demo: classify a product, decide whether a person must confirm, then calculate tax.
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = new HsnClient({ baseUrl: process.env.HSN_API_URL, apiKey: process.env.HSN_API_KEY });

  const result = await api.classify({ name: '22K gold ring', unitPrice: 68500 });
  const top = result.candidates[0];
  if (!top) {
    console.log(result.message); // nothing matched: ask for a better name or use search
    process.exit(0);
  }
  if (result.needs_review) {
    // In a real app, show the candidates with their reasons and let the user pick before billing.
    console.log('Ask the user to pick a code from:', result.candidates.map((c) => `${c.hsn} (${c.confidence_band})`));
  } else {
    console.log(`Suggested HSN ${top.hsn}, confidence ${top.confidence} (${top.confidence_band})`);
  }

  const tax = await api.calculateTax({
    accept_unverified: true, // only if your business has decided to accept unverified rates
    invoice_rounding: 'nearest_rupee',
    lines: [{ line_id: 'L1', hsn: top.hsn, taxable_value: 68500, supply_type: 'intra' }],
  });
  if (!tax.complete) {
    for (const line of tax.lines.filter((l) => l.needs_input.length)) {
      console.log(`Line ${line.line_id} needs one of: ${line.needs_input.join(', ')}`);
    }
  } else {
    console.log('Tax:', tax.totals, 'Grand total (paise):', tax.grand_total_paise);
  }

  try {
    await api.lookup('71-13');
  } catch (e) {
    if (e instanceof HsnApiError) console.log(`Error ${e.status} ${e.type.split('/').pop()}: ${e.errors[0]?.pointer}`);
  }
}
