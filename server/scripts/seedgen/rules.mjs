// Rate rules transcribed from research/sources.md (secondary sources; CBIC text not read).
const U = {
  SJ: "https://sjexim.services/2025/10/10/new-comprehensive-gst-rate-schedules-notified-by-cbic/",
  CT_DIA: "https://cleartax.in/s/gst-diamond-jewellery",
  GJ: "https://gjepc.org/solitaire/?p=16021",
  ICAI: "https://navimumbai.icai.org/detail/56581.aspx",
  KPMG: "https://www.in.kpmg.com/taxflashnews/KPMG-Flash-News-Recommendations-of-56th-GST-Council-meeting.pdf",
  MSA: "https://www.msassociates.pro/gst/gst-personal-care-and-hygiene.php",
  LT: "https://lookuptax.com/tax-changes/india/cbic-notification-01-2026",
  TMX: "https://www.taxmann.com/post/blog/gst-rate-schedules-amended-for-pan-masala-tobacco",
  CCE: "https://cleartax.in/s/gst-on-electronics",
  TGH: "https://taxguru.in/goods-and-service-tax/gst-health-care-services.html",
  CAC: "https://www.caclubindia.com/articles/gst-notification-no-92025-complete-hsnwise-rate-schedule-effective-from-september-22-2025-54119.asp",
  SC: "https://studycafe.in/summary-of-multiple-gst-rate-notifications-effective-from-22nd-september-2025-393452.html",
};

// Citations: notification_ref uses the canonical form of data-model §1:
//   <n>/<yyyy>-CT(Rate)[, Schedule <roman>]   (serial number belongs in schedule_serial, left null until verified)
// Every caveat ("gazette not read", amendment chain, placeholder dates) lives in `note`, which is written
// to research_ref (not loaded into the DB) so that a verify proposal replacing notification/url leaves no
// stale "not verified" text behind. Served caveats that matter to a caller are in condition_text.
const NR = "gazette not read; schedule S.No. not verified";
const N9 = (sch) => ({ ref: `9/2025-CT(Rate), Schedule ${sch}`, note: `9/2025-Central Tax (Rate) dt 17-09-2025, w.e.f. 22-09-2025 (and IGST (Rate) notification of the same number); ${NR}` });
const N10 = { ref: "10/2025-CT(Rate)", note: `10/2025-Central Tax (Rate) dt 17-09-2025 (goods exemptions), w.e.f. 22-09-2025; ${NR}` };
const N19 = (sch) => ({ ref: `19/2025-CT(Rate), Schedule ${sch}`, note: `19/2025-Central Tax (Rate) dt 31-12-2025, w.e.f. 01-02-2026, amending the schedules of 9/2025-CT(Rate); ${NR}` });
const N0126 = (sch) => ({ ref: `1/2026-CT(Rate), Schedule ${sch}`, note: `1/2026-Central Tax (Rate) dt 30-04-2026 (G.S.R. 328(E)), w.e.f. 01-05-2026, read with corrigendum G.S.R. 339(E) dt 06-05-2026, amending the schedules of 9/2025-CT(Rate); ${NR}` });
const N15 = (entry) => ({ ref: "15/2025-CT(Rate)", note: `15/2025-Central Tax (Rate) (G.S.R. 663(E)), w.e.f. 22-09-2025, amending services rate notification 11/2017-CT(Rate)${entry ? "; research cites " + entry : ""}; gazette not read; S.No. not verified` });
const N16 = (what) => ({ ref: "16/2025-CT(Rate)", note: `16/2025-Central Tax (Rate), w.e.f. 22-09-2025, amending services exemption notification 12/2017-CT(Rate): ${what}; gazette not read; S.No. not verified` });
const HIST = { ref: "1/2017-CT(Rate)", note: "Rate in force immediately before 22-09-2025 per secondary source, under 1/2017-Central Tax (Rate) as amended; schedule/S.No. not verified; the start date 2025-09-01 is a placeholder (the true start date was not researched)" };
const HIST_CAVEAT = "Pre-22-09-2025 rate per secondary source; effective_from 2025-09-01 is a placeholder (true start date not researched)";

const D = "2025-09-22";
const H_FROM = "2025-09-01", H_TO = "2025-09-21";

const raw = [];
const r = (id, prefix, bp, cite, url, extra = {}) => raw.push({ rule_id: `rr_seed_${id}`, hsn_prefix: prefix, igst_rate_bp: bp, ref: cite.ref, note: cite.note, url, ...extra });
const withNote = (cite, extra) => ({ ref: cite.ref, note: `${cite.note}; ${extra}` });
// history rows always carry an "other" caveat (validator R15)
const hist = (text) => ({ from: H_FROM, to: H_TO, condition_kind: "other", condition_text: text ? `${text}. ${HIST_CAVEAT}` : HIST_CAVEAT });
const other = (t) => ({ condition_kind: "other", condition_text: t });

// ---- Chapter 71 (Sunarone) ----
r("7108_300", "7108", 300, N9("IV"), U.SJ);
r("7106_300", "7106", 300, N9("IV"), U.SJ);
r("7107_300", "7107", 300, N9("IV"), U.SJ);
r("7113_300", "7113", 300, N9("IV"), U.SJ);
r("7101_300", "7101", 300, N9("IV"), U.SJ);
const rough = other("Rough diamonds: unworked or simply sawn, cleaved or bruted (mapping of Schedule V entry to this sub-heading not verified)");
r("710210_25", "710210", 25, N9("V"), U.SJ, rough);
r("710221_25", "710221", 25, N9("V"), U.SJ, rough);
r("710231_25", "710231", 25, N9("V"), U.SJ, rough);
r("7103_25", "7103", 25, N9("V"), U.SJ, other("Precious (other than diamonds) and semi-precious stones, not strung, mounted or set (Sch V scope wording not verified)"));
r("710239_150", "710239", 150, withNote(N9("VI"), "cut and polished diamond rate raised from 0.25% w.e.f. 18-07-2022 (47th GST Council)"), U.GJ,
  other("Cut and polished (non-industrial, worked) diamonds; rough diamonds of 7102 10/21/31 are 0.25% under their own rules"));
r("998892_500", "998892", 500, N15("11/2017 S.No. 26 (job work)"), U.ICAI,
  other("Job work in relation to goods of Chapter 71 other than diamonds; job work on diamonds is 1.5% (not seeded - no distinct SAC code)"));

// ---- Health ----
r("3004_500", "3004", 500, N9("I"), U.KPMG);
r("3004_0_nil", "3004", 0, N10, U.SC, { condition_kind: "other", condition_code: "nil_rate_list",
  condition_text: "Drugs and medicines on the nil-rate list of 10/2025-CT(Rate) (33 specified life-saving drugs; list not yet transcribed)" });
r("3004_1200_hist", "3004", 1200, HIST, U.KPMG, hist("Rate for medicaments generally before 22-09-2025; several 3004 items were at 5% under 1/2017 Sch I; check the specific entry"));
r("3822_500", "3822", 500, N9("I"), U.KPMG);
const medThermo = "Medical (clinical) thermometers only; other goods of heading 9025 are not covered by this seed rule";
r("9025_500", "9025", 500, N9("I"), U.KPMG, other(medThermo));
r("9025_1800_hist", "9025", 1800, HIST, U.KPMG, hist(medThermo));
const medInst = "Medical, surgical, dental or veterinary instruments and apparatus (secondary source lists 9018-9022 at 5%); entry wording and exclusions not verified";
for (const h of ["9018", "9019", "9020", "9021", "9022"]) r(`${h}_500`, h, 500, N9("I"), U.KPMG, other(medInst));
r("9018_1200_hist", "9018", 1200, HIST, U.KPMG, hist(medInst));
r("900130_500", "900130", 500, N9("I"), U.KPMG);
r("900140_500", "900140", 500, N9("I"), U.KPMG);
r("900150_500", "900150", 500, N9("I"), U.KPMG);
r("9003_500", "9003", 500, N9("I"), U.KPMG);
r("9004_500", "9004", 500, N9("I"), U.KPMG, other("Spectacles and goggles (corrective); sunglasses and other non-corrective goggles of 9004 may not fall in this entry - verify"));
for (const t of ["96190030", "96190040", "96190090"]) r(`${t}_500`, t, 500, N9("I"), U.MSA, other("Baby and clinical diapers (per secondary source)"));
r("3305_500", "3305", 500, N9("I"), U.MSA, other("Hair oil and shampoo (per secondary source); other hair preparations of 3305 not verified"));
r("330610_500", "330610", 500, N9("I"), U.MSA);
r("330610_1800_hist", "330610", 1800, HIST, U.MSA, hist());
r("340111_500", "340111", 500, N9("I"), U.MSA, other("Toilet soap (per secondary source)"));
r("9993_0", "9993", 0, { ref: "12/2017-CT(Rate)", note: "12/2017-Central Tax (Rate) (services exemptions): research cites entry 74, read with Sch I Sr 437 of 9/2025 per 15/2025; gazette not read; S.No. not verified" }, U.TGH,
  other("Health care services by a clinical establishment, an authorised medical practitioner or para-medics (exempt); other services of 9993 not covered"));
const indivIns = (k) => other(`Individual ${k} insurance policies (exempt); group policies are NOT covered by this exemption`);
r("997131_0", "997131", 0, N16("new exemption for individual life insurance"), U.KPMG, indivIns("life"));
r("997133_0", "997133", 0, N16("new exemption for individual health insurance"), U.KPMG, indivIns("health"));

// ---- Food & beverages ----
const uht = "UHT (ultra-high temperature) milk; other goods of heading 0401 not covered by this seed rule";
r("0401_0", "0401", 0, N10, U.KPMG, other(uht));
r("0401_500_hist", "0401", 500, HIST, U.KPMG, hist(uht));
r("0406_500", "0406", 500, N9("I"), U.KPMG, other("Cheese; paneer (pre-packaged and labelled) is Nil - see rule on 040610"));
r("040610_0", "040610", 0, N10, U.KPMG, other("Paneer (chhena), pre-packaged and labelled - Nil; other fresh cheese/curd of 0406 10 may be 5% - verify"));
r("0405_500", "0405", 500, N9("I"), U.KPMG);
r("0405_1200_hist", "0405", 1200, HIST, U.KPMG, hist());
r("1905_500", "1905", 500, N9("I"), U.KPMG);
r("1905_1800_hist", "1905", 1800, HIST, U.KPMG, hist());
r("1806_500", "1806", 500, N9("I"), U.KPMG);
r("1806_1800_hist", "1806", 1800, HIST, U.KPMG, hist());
r("210690_500", "210690", 500, N9("I"), U.KPMG, other("Namkeen, bhujia, mixture and similar preparations (per secondary source); other preparations of 2106 90 not verified; pan masala 2106 90 20 has its own rule"));
r("220210_4000", "220210", 4000, N9("III"), U.KPMG);
for (const t of ["22029921", "22029929", "22029931", "22029939"])
  r(`${t}_500`, t, 500, N0126("I"), U.LT, { from: "2026-05-01", ...other("Fruit pulp/fruit juice based drinks and milk-based beverages as re-mapped from 01-05-2026 (per secondary sources)") });
for (const t of ["22029100", "22029991", "22029999"])
  r(`${t}_4000`, t, 4000, N0126("III"), U.LT, { from: "2026-05-01", ...other("Caffeinated and other non-alcoholic beverages as re-mapped from 01-05-2026 (per secondary sources)") });
r("21069020_2800", "21069020", 2800, N9("VII"), U.TMX,
  { to: "2026-01-31", ...other("Compensation cess was ALSO leviable on pan masala in this period; cess rate not recorded in research - verify before using for historical invoices") });
r("21069020_4000", "21069020", 4000, N19("III"), U.TMX, { from: "2026-02-01", ...other("No GST compensation cess from 01-02-2026; Health Security se National Security Cess applies outside GST") });
r("2402_4000", "2402", 4000, N19("III"), U.TMX, { from: "2026-02-01", ...other("Tobacco products moved to 40% from 01-02-2026; Central Excise duties apply outside GST") });
r("2403_4000", "2403", 4000, N19("III"), U.TMX, { from: "2026-02-01", ...other("Manufactured tobacco OTHER THAN biris; biris are 18% (Schedule II) from 01-02-2026 - 8-digit biri code not recorded in research") });

// ---- Electronics, construction, others ----
r("8517_1800", "8517", 1800, N9("II"), U.CCE, other("Mobile phones (per secondary source); other apparatus of 8517 assumed standard rate but not verified"));
r("8471_1800", "8471", 1800, N9("II"), U.CCE);
r("8528_1800", "8528", 1800, N9("II"), U.KPMG);
r("8415_1800", "8415", 1800, N9("II"), U.KPMG);
r("8415_2800_hist", "8415", 2800, HIST, U.KPMG, hist());
r("2523_1800", "2523", 1800, N9("II"), U.KPMG);
r("2523_2800_hist", "2523", 2800, HIST, U.KPMG, hist());
r("9302_4000", "9302", 4000, N9("III"), U.CAC);

// ---- Apparel / footwear price thresholds ----
for (const ch of ["61", "62", "63"]) {
  r(`${ch}_lo_500`, ch, 500, N9("I"), U.KPMG, { condition_kind: "price", condition_text: "sale value not exceeding Rs 2500 per piece", max_unit_price_paise: 250000 });
  r(`${ch}_hi_1800`, ch, 1800, N9("II"), U.KPMG, { condition_kind: "price", condition_text: "sale value exceeding Rs 2500 per piece", min_unit_price_paise: 250001 });
}
r("64_lo_500", "64", 500, N9("I"), U.KPMG, { condition_kind: "price", condition_text: "sale value not exceeding Rs 2500 per pair", max_unit_price_paise: 250000 });
r("64_hi_1800", "64", 1800, N9("II"), U.KPMG, { condition_kind: "price", condition_text: "sale value exceeding Rs 2500 per pair", min_unit_price_paise: 250001 });

// ---- Services ----
r("996311_lo_500", "996311", 500, N15("hotel accommodation entry"), U.KPMG,
  { condition_kind: "price", condition_text: "value of supply of a unit of accommodation not exceeding Rs 7500 per unit per day; without ITC", max_unit_price_paise: 750000 });
r("996311_hi_1800", "996311", 1800, N15("hotel accommodation entry"), U.KPMG,
  { condition_kind: "price", condition_text: "value of supply of a unit of accommodation exceeding Rs 7500 per unit per day (wording UNVERIFIED)", min_unit_price_paise: 750001 });
r("996331_500", "996331", 500, N15("restaurant service entry"), U.KPMG,
  other("Stand-alone restaurant service; without ITC (cannot opt for 18% with ITC); restaurants in specified premises (hotels) may differ"));
r("99972_500", "99972", 500, N15("11/2017 S.No. 35(i)"), U.ICAI, other("Beauty and physical well-being services (SAC group 99972: hairdressing, cosmetic treatment, salon, gym, yoga, etc.); without ITC"));

const OFFICIAL_9_2025 = "https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications";
const CBIC_INDEX = "https://cbic-gst.gov.in/central-tax-rate.html";

// rule_id omitted: the loader derives a deterministic id (FORMAT.md). The research-cited secondary URL
// goes in research_ref; source_url must be an official host, so it is the 9/2025 PDF (cited by research)
// for rows resting on 9/2025, otherwise the CBIC Central Tax (Rate) index page (also cited by research).
// User-facing caveat (FORMAT.md `citation_note`; cleared on verify). Built from the row's note with the
// generic "not read / not verified" fragments folded into one standard opening sentence.
const BASE = "Transcribed from secondary sources; schedule S.No. and gazette text not yet checked against the CBIC PDF.";
function citationNote(x, url) {
  const specific = x.note
    .split(/;\s*/)
    .map((t) => t.trim())
    .filter((t) => t && !/^(gazette not read|schedule S\.No\. not verified|S\.No\. not verified)$/i.test(t))
    .join("; ")
    .replace(/schedule\/S\.No\. not verified;?\s*/i, "");
  const parts = [BASE];
  if (specific) parts.push(specific.charAt(0).toUpperCase() + specific.slice(1) + ".");
  if (url === CBIC_INDEX) parts.push("Source link is the CBIC notification index; the specific notification PDF is not yet recorded.");
  return parts.join(" ").replace(/\.\./g, ".");
}

export const rules = raw.map((x) => {
  const o = { hsn_prefix: x.hsn_prefix, igst_rate_bp: x.igst_rate_bp };
  if (x.condition_kind) { o.condition_kind = x.condition_kind; o.condition_text = x.condition_text; }
  if (x.condition_code) o.condition_code = x.condition_code;
  if (x.min_unit_price_paise !== undefined) o.min_unit_price_paise = x.min_unit_price_paise;
  if (x.max_unit_price_paise !== undefined) o.max_unit_price_paise = x.max_unit_price_paise;
  o.effective_from = x.from ?? D;
  o.effective_to = x.to ?? null;
  o.notification_ref = x.ref;
  o.source_url = x.ref.startsWith("9/2025-CT(Rate)") ? OFFICIAL_9_2025 : CBIC_INDEX;
  o.verification_status = "unverified";
  o.citation_note = citationNote(x, o.source_url);
  o.research_ref = `NOTE: ${x.note}. Source: research/sources.md, secondary URL ${x.url}`;
  return o;
});
