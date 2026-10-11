// Known data gaps -> data/seed/known_gaps.json (served as known_data_gaps[] by /v1/meta/dataset).
// Single source for the README "Rates in research that are NOT seeded" table: validate.mjs checks that
// every prefix here is mentioned in that README section and that it exists in hsn_codes.json.
// kinds: disputed | not_researched | not_transcribed | not_expressible | period_gap
export const knownGaps = [
  { prefix: "7104", kind: "disputed", reason: "Synthetic / lab-grown stones: sources disagree (0.25% vs 1.5%); no rule seeded." },
  { prefix: "7117", kind: "disputed", reason: "Imitation jewellery: 3% under 1/2017; its place in 9/2025 is not confirmed; no rule seeded." },
  { prefix: "7114", kind: "not_researched", reason: "Silver articles and utensils: not in research for 9/2025; lookups return no_rate_rule." },
  { prefix: "7118", kind: "not_researched", reason: "Coin: not in research for 9/2025; lookups return no_rate_rule." },
  { prefix: "7110", kind: "not_researched", reason: "Platinum: not in research for 9/2025; lookups return no_rate_rule." },
  { prefix: "3004", kind: "not_transcribed", reason: "Nil-rate list of 33 life-saving drugs (10/2025-CT(Rate)) is not transcribed: the 0% rule needs a per-drug choice (rule_id)." },
  { prefix: "9027", kind: "not_researched", reason: "Glucometers (5%): research gives no HSN; synonyms point to 9027 / 9018, and 9027 has no rule." },
  { prefix: "4014", kind: "not_expressible", reason: "Feeding-bottle nipples (5%) and feeding bottles (3926): no specific tariff line researched; the broad headings carry other rates." },
  { prefix: "2202", kind: "period_gap", reason: "Re-mapped 2202 91 / 2202 99 items: no rules between 22-09-2025 and 30-04-2026 (research gives rates from 01-05-2026)." },
  { prefix: "2403", kind: "not_researched", reason: "Biris (18% from 01-02-2026): 8-digit code not in research; 2403 is seeded as 'other than biris' at 40%." },
  { prefix: "9988", kind: "not_expressible", reason: "Job work on diamonds (1.5%): no distinct SAC code; only jewellery job work (998892, 5%) is seeded." },
  { prefix: "8703", kind: "not_expressible", reason: "Cars (18% / 40%): depends on cc, fuel and length; not expressible as one prefix rule." },
  { prefix: "9404", kind: "not_expressible", reason: "Cotton quilts (Rs 2,500 threshold): a price rule on 9404 would also catch mattresses." },
  { prefix: "9619", kind: "not_researched", reason: "Sanitary towels/pads and tampons: rate not in research; only the diaper lines 9619 00 30/40/90 are seeded." },
  { prefix: "8713", kind: "not_researched", reason: "Wheelchairs (carriages for disabled persons): rate not in research." },
  { prefix: "210610", kind: "not_researched", reason: "Protein concentrates (protein powder): rate not in research." },
  { prefix: "3808", kind: "not_researched", reason: "Hand sanitizer / disinfectants: rate and classification (3808 vs 3004) not in research." },
  { prefix: "3005", kind: "not_researched", reason: "Bandages, gauze and dressings: rate not in research." },
  { prefix: null, kind: "not_researched", reason: "Compensation cess on tobacco and pan masala before 01-02-2026 is not in research." },
];
