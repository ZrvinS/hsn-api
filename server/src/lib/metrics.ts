/**
 * Minimal Prometheus text-format metrics (ruling 30). No dependency: counters, a histogram and
 * gauges computed at scrape time. Served only on the admin listener (GET /metrics).
 * Label values are bounded by construction (route templates, status codes, bands), never raw input.
 */

type Labels = Record<string, string>;

const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtLabels = (l: Labels): string => {
  const keys = Object.keys(l).sort();
  return keys.length === 0 ? '' : `{${keys.map((k) => `${k}="${esc(l[k]!)}"`).join(',')}}`;
};
const keyOf = (l: Labels): string => fmtLabels(l);
const num = (n: number): string => (Number.isFinite(n) ? String(n) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN');

/** Upper bound on distinct label sets per metric, so a bug can never grow memory without bound. */
const MAX_SERIES = 2000;

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = keyOf(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else if (this.values.size < MAX_SERIES) this.values.set(k, { labels, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels))?.value ?? 0;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) out.push(`${this.name}${fmtLabels(labels)} ${num(value)}`);
    return out;
  }
}

export class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const k = keyOf(labels);
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${fmtLabels(s.labels)} ${num(s.sum)}`);
      out.push(`${this.name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

export interface GaugeSample {
  name: string;
  help: string;
  value: number;
  labels?: Labels;
}

export class Metrics {
  readonly requests = new Counter('hsn_http_requests_total', 'HTTP requests by listener, method, route template and status.');
  readonly latency = new Histogram('hsn_http_request_duration_seconds', 'HTTP request latency by listener and route template.', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);
  readonly classifyBands = new Counter('hsn_classify_top_band_total', 'POST /v1/classify responses by confidence band of the top candidate (none = no candidate).');

  /** Prometheus text exposition (version 0.0.4); gauges are computed by the caller at scrape time. */
  render(gauges: readonly GaugeSample[]): string {
    const lines = [...this.requests.render(), ...this.latency.render(), ...this.classifyBands.render()];
    for (const g of gauges) {
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name}${fmtLabels(g.labels ?? {})} ${num(g.value)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
