import { readFileSync } from "node:fs";
const DIR = new URL("../../data/seed/", import.meta.url).pathname;
const errs = [];
const load = (f) => { const j = JSON.parse(readFileSync(DIR + f, "utf8")); return Array.isArray(j) ? j : j.items; };
const codes = load("hsn_codes.json"), rules = load("rate_rules.json"), syn = load("synonyms.json"), cat = load("category_map.json"), ck = load("chapter_keywords.json");
const set = new Set();
for (const c of codes) {
  if (!/^(\d{2}|\d{4}|99\d{3}|\d{6}|\d{8})$/.test(c.code)) errs.push("bad code " + c.code);
  if (set.has(c.code)) errs.push("dup code " + c.code);
  set.add(c.code);
  if (!c.description || c.description.length > 2000) errs.push("bad desc " + c.code);
  const exp = c.code.startsWith("99") ? "service" : "goods";
  if (c.type !== exp) errs.push("type " + c.code);
  for (const k of Object.keys(c)) if (!["code", "type", "description", "keywords"].includes(k)) errs.push("unknown field " + k);
}
for (const c of codes) {
  if (c.code.length === 2) continue;
  const p = [6, 5, 4, 2].filter((n) => n < c.code.length).map((n) => c.code.slice(0, n)).find((x) => set.has(x));
  if (!p) errs.push("no parent " + c.code);
  if (!set.has(c.code.slice(0, 2))) errs.push("no chapter " + c.code);
}
const chs = codes.filter((c) => c.code.length === 2 && c.code !== "99").length;
if (chs !== 98) errs.push("chapters " + chs);
const ruleFields = ["citation_note", "condition_code", "source_pdf_sha256", "schedule_serial", "rule_id", "hsn_prefix", "igst_rate_bp", "cess_rate_bp", "cess_specific_paise", "cess_specific_unit", "condition_kind", "condition_text", "min_unit_price_paise", "max_unit_price_paise", "effective_from", "effective_to", "notification_ref", "source_url", "verified_by", "last_verified_at", "verification_status", "research_ref"];
const ids = new Set();
const dre = /^\d{4}-\d{2}-\d{2}$/;
for (const r of rules) {
  for (const k of Object.keys(r)) if (!ruleFields.includes(k)) errs.push("unknown rule field " + k);
  if ("rule_id" in r) errs.push("rule_id present");
  const key = [r.hsn_prefix, r.effective_from, r.condition_kind ?? "none", r.min_unit_price_paise, r.max_unit_price_paise].join("|");
  if (ids.has(key)) errs.push("dup derived id key " + key); ids.add(key);
  r.rule_id = key;
  if (!set.has(r.hsn_prefix)) errs.push("rule code missing " + r.hsn_prefix);
  if (!Number.isInteger(r.igst_rate_bp) || r.igst_rate_bp < 0 || r.igst_rate_bp > 10000) {
    errs.push("bp " + r.rule_id);
  }
  const kind = r.condition_kind ?? "none";
  const hasP = r.min_unit_price_paise !== undefined || r.max_unit_price_paise !== undefined;
  if ((kind === "price") !== hasP) errs.push("price kind " + r.rule_id);
  if (kind !== "none" && !r.condition_text) errs.push("cond text " + r.rule_id);
  if (!dre.test(r.effective_from) || r.effective_from < "2017-07-01") errs.push("from " + r.rule_id);
  if (r.effective_to != null && (!dre.test(r.effective_to) || r.effective_to < r.effective_from)) errs.push("to " + r.rule_id);
  if (!r.source_url.startsWith("https://")) errs.push("url " + r.rule_id);
  if (r.verification_status !== "unverified") errs.push("status " + r.rule_id);
  if (!/^[1-9]\d{0,2}\/\d{4}-(CT|IT|UTT|Cess)\(Rate\)(, Schedule [IVX]+)?$/.test(r.notification_ref)) errs.push("citation not canonical " + r.notification_ref);
  if (/not verified|not read|placeholder/i.test(r.notification_ref)) errs.push("caveat in citation " + r.rule_id);
  if (r.condition_text && r.condition_text.length > 500) errs.push("cond text too long " + r.rule_id);
  if (typeof r.citation_note !== "string" || r.citation_note.length < 1 || r.citation_note.length > 1000) errs.push("citation_note " + r.rule_id);
  if ((r.research_ref ?? "").length > 500) errs.push("research_ref too long " + r.rule_id);
  if (r.condition_code != null && (r.condition_kind !== "other" || r.condition_code !== "nil_rate_list")) errs.push("condition_code " + r.rule_id);
  if (r.verified_by != null || r.last_verified_at != null) errs.push("verified fields set " + r.rule_id);
  if (!/^https:\/\/(www\.)?(cbic-gst\.gov\.in|taxinformation\.cbic\.gov\.in|cbic\.gov\.in|egazette\.gov\.in|gstcouncil\.gov\.in)\//.test(r.source_url)) errs.push("host " + r.rule_id);
  if (![0, 10, 25, 100, 150, 300, 500, 600, 1200, 1800, 2800, 4000].includes(r.igst_rate_bp)) errs.push("slab " + r.rule_id);
}
// overlap check
const ov = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
  const a = rules[i], b = rules[j];
  if (a.hsn_prefix !== b.hsn_prefix) continue;
  const dOv = ov(a.effective_from, a.effective_to ?? "9999-12-31", b.effective_from, b.effective_to ?? "9999-12-31");
  // mirrors src/services/proposals.ts rulesOverlap: an "other" rule only collides with an "other" rule of identical text
  if (a.condition_kind === "other" || b.condition_kind === "other") {
    if (dOv && a.condition_kind === "other" && b.condition_kind === "other" && a.condition_text === b.condition_text) errs.push(`overlap ${a.rule_id} ${b.rule_id}`);
    continue;
  }
  const pr = (r) => r.condition_kind === "price" ? [r.min_unit_price_paise ?? 0, r.max_unit_price_paise ?? Infinity] : [0, Infinity];
  const [a1, a2] = pr(a), [b1, b2] = pr(b);
  if (dOv && ov(a1, a2, b1, b2)) errs.push(`overlap ${a.rule_id} ${b.rule_id}`);
}
const sp = new Set();
for (const s of syn) {
  if (!set.has(s.hsn_code)) errs.push("syn code missing " + s.phrase + " " + s.hsn_code);
  const k = s.phrase + "|" + s.hsn_code; if (sp.has(k)) errs.push("dup syn " + k); sp.add(k);
  if (s.phrase !== s.phrase.toLowerCase().normalize("NFKC") || /\s{2}/.test(s.phrase) || s.phrase.trim() !== s.phrase) errs.push("syn norm " + s.phrase);
  if (/(^|\s)\d+(\.\d+)?\s?(g|kg|mg|ml|l|pcs|pack)(\s|$)/.test(s.phrase)) errs.push("quantity token in phrase " + s.phrase);
  for (const k2 of Object.keys(s)) if (!["phrase", "hsn_code", "strength", "note", "rule_hint", "created_by"].includes(k2)) errs.push("syn field " + k2);
}
const ckk = new Set();
for (const c of cat) { if (!set.has(c.hsn_prefix)) errs.push("cat code missing " + c.hsn_prefix); const k = c.source + c.category; if (ckk.has(k)) errs.push("dup cat " + k); ckk.add(k); }
const kk = new Set();
for (const c of ck) { if (!/^[a-z0-9-]+$/.test(c.keyword)) errs.push("kw " + c.keyword); if (!set.has(c.chapter)) errs.push("kw ch " + c.chapter); const k = c.keyword + c.chapter; if (kk.has(k)) errs.push("dup kw " + k); kk.add(k); }
const prim = syn.filter((s) => s.strength !== "related");
const multi = {}; for (const s of prim) (multi[s.phrase] ??= new Set()).add(s.hsn_code);
const contested = Object.entries(multi).filter(([, v]) => v.size > 1).map(([k, v]) => k + "→" + [...v].join("/"));
// known gaps: format + in step with README gap section
const gaps = load("known_gaps.json");
const readme = readFileSync(DIR + "README.md", "utf8");
const gapSection = readme.slice(readme.indexOf("## Rates in research that are NOT seeded"), readme.indexOf("## Verify first"));
if (gapSection.length < 50) errs.push("README gap section not found");
if (gaps.length > 200) errs.push("too many gaps");
for (const g of gaps) {
  for (const k of Object.keys(g)) if (!["prefix", "kind", "reason"].includes(k)) errs.push("gap field " + k);
  if (!["disputed", "not_researched", "not_transcribed", "not_expressible", "period_gap"].includes(g.kind)) errs.push("gap kind " + g.kind);
  if (typeof g.reason !== "string" || g.reason.length < 5 || g.reason.length > 500) errs.push("gap reason " + g.prefix);
  if (g.prefix !== null) {
    if (!set.has(g.prefix)) errs.push("gap prefix not in hsn_codes " + g.prefix);
    if (!gapSection.includes(g.prefix)) errs.push("gap prefix missing from README gap section " + g.prefix);
  }
}
console.log({ gaps: gaps.length, codes: codes.length, chapters: chs, rules: rules.length, syn: syn.length, uniquePhrases: Object.keys(multi).length, cat: cat.length, ck: ck.length, contestedPrimary: contested });
console.log(errs.length ? errs : "OK");
