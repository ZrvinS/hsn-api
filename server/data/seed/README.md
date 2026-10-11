# Seed data: provenance and verification status

**Every rate in `rate_rules.json` is UNVERIFIED pending a check against the CBIC notification PDFs.**
The research step could not open any official host (cbic-gst.gov.in, taxinformation.cbic.gov.in,
gstcouncil.gov.in were all blocked from the sandbox). Every rate was therefore transcribed from the
secondary sources listed in `research/sources.md`: KPMG, ICAI Navi Mumbai, sjexim, GJEPC, taxmann,
lookuptax, taxguru, cleartax and msassociates. Each row's `research_ref` names the secondary URL that
research cited for that row, and `source_url` names the official CBIC location (see below). No row may be marked `verified` until a named human compares it with the gazette text
through maker-checker review (rule AG-03).

Compiled 2026-10-10 by the data worker agent. The format follows `FORMAT.md`.

| File | Rows | Contents |
|---|---|---|
| `hsn_codes.json` | 356 | All 98 chapters plus `99` (SAC services), 4/6/8-digit goods codes, SAC headings and the SAC group 99972 |
| `rate_rules.json` | 81 | IGST rates in basis points (CGST = SGST = half), all `verification_status: "unverified"` |
| `synonyms.json` | 1323 | Product-name phrases mapped to HSN codes (1310 distinct phrases) |
| `category_map.json` | 79 | Open Food Facts and Open Beauty Facts category tags mapped to HSN headings or chapters |
| `chapter_keywords.json` | 270 | Single tokens mapped to chapters |

## Conventions and caveats

- Following `FORMAT.md` (coordinator ruling 17), every row has `verification_status: "unverified"`
  and **omits** `verified_by` and `last_verified_at`. Rows also omit `rule_id`; the loader derives a
  deterministic id.
- **Citations.** Every `notification_ref` uses the canonical form from data-model §1:
  `<n>/<yyyy>-CT(Rate)[, Schedule <roman>]`, for example `9/2025-CT(Rate), Schedule IV`. The schedule
  serial number belongs in `schedule_serial`. It is left null until a human reads the gazette.
  Amended services entries cite the amending notification (`15/2025-CT(Rate)` or `16/2025-CT(Rate)`);
  the notification they amend is named in `research_ref`.
- **Caveats are not part of the citation.** Every rule has a user-facing `citation_note`. It opens
  with "Transcribed from secondary sources; schedule S.No. and gazette text not yet checked against
  the CBIC PDF.", followed by the notification date and amendment chain. Where they apply it also
  carries the placeholder-date caveat and "Source link is the CBIC notification index". The note is
  served to API users and cleared when a `verify` proposal is approved. `research_ref` keeps the
  maintainer note and the secondary URL; the loader ignores it. Scope caveats that a caller needs in
  order to choose a rule stay in `condition_text`.
- **`source_url` vs `research_ref`.** The loader accepts only official hosts in `source_url`. Rows
  resting on 9/2025-CT(Rate) point to the CBIC PDF that research cited
  (`taxinformation.cbic.gov.in/view-pdf/1010436/...`). All other rows (10/2025, 19/2025, 01/2026,
  11/2017 and 12/2017 as amended, and the history rows) point to the CBIC Central Tax (Rate) index
  page (`cbic-gst.gov.in/central-tax-rate.html`), because research found no official PDF link for
  those notifications. **The secondary source the rate was actually taken from is in each row's
  `research_ref`.** A reviewer should replace the index URL with the specific notification PDF.
- **Historical rows.** These have `effective_from` 2025-09-01 and `effective_to` 2025-09-21. The
  start date 2025-09-01 is a placeholder lower bound meaning "the rate in force immediately before
  22-09-2025". The research states only "was X%" and does not give the true start date.
  - Every history row is `condition_kind: "other"`, and its `condition_text` says the start date is a
    placeholder.
  - The 3004 12% row also says that several 3004 items were at 5% under 1/2017 Schedule I and that the
    specific entry must be checked (validator R15).
  - History rows exist for 3004, 9018, 9025, 0401 (UHT), 0405, 1905, 1806, 330610, 8415 and 2523.
  - Pan masala (21069020) has a real dated split: 28% until 31-01-2026, then 40% from 01-02-2026.
- **3004 nil-rate list (ruling 5).** 3004 has the general 5% rule and a 0% `other` rule with
  `condition_code: "nil_rate_list"`. Its `condition_text` reads "Drugs and medicines on the nil-rate
  list of 10/2025-CT(Rate) (33 specified life-saving drugs; list not yet transcribed)". Lookup of 3004
  therefore returns `ambiguous`, with the 5% rule as `default_rule_id`. **No nil-drug synonyms carry
  `rule_hint: "nil_rate_list"`**, because research names no individual drug on the list. They can be
  added once the 10/2025 list is transcribed from the gazette.
- **7103** is limited to stones that are not strung, mounted or set (validator R14).
- **Beauty and well-being services** use one rule on the SAC group `99972`, which is what research
  cites. Codes 999721–999729 inherit it.
- Rows with `condition_kind: "other"` carry the scope limits that research gave. For example, 9025
  applies to medical thermometers only, 9004 to corrective spectacles only, and 997131/997133 to
  individual policies only. The resolver returns them as applicable, so callers must show
  `condition_text`.
- Chapter titles follow the HS 2022 nomenclature as adopted in the Customs Tariff First Schedule.
  4- and 6-digit descriptions are HS heading and subheading texts. The following were **not**
  verified against the current Indian tariff and the SAC annexure, and need a check:
  - The 8-digit lines 22029100, 22029921/29/31/39/91/99 and 96190030/40/90. Research cites these
    codes but not their official wording, and the descriptions say so.
  - 71131910 and 71131930.
  - The SAC 6-digit descriptions (996311, 996331, 996334, 997131, 997133, 998313, 998314, 998892,
    998893, 999721–999729).

## Synonym policy (round 3)

- Generic single words that occur in several chapters are `strength: "related"`, with a note naming
  the alternatives. Examples are `tablet`, `gel`, `cream`, `drops`, `spray`, `mouse`, `ring`,
  `chain`, `switch` and `soda`.
- Multi-word phrases, and single words that point clearly to one heading, are `primary`.
- Doubtful classifications carry a note saying "confirm", for example:
  - portable SSDs (8471 70 vs 8523 51);
  - webcams (8471 60 vs 8525);
  - hand sanitizer and antiseptic liquid (3808 vs 3004);
  - dishwash bars (3402 vs 3401);
  - hing (asafoetida);
  - popcorn;
  - sarees, which are usually classified as fabric.
- Phrases contain no quantity tokens such as `10g` or `5g`, because the classifier strips those
  before matching.
- Round 3 added 44 HSN codes: HS 2022 headings and subheadings for everyday retail goods. Examples
  are 847160/847170 (computer input and storage units), 852351 (flash drives and memory cards),
  847330 (computer parts), 8544, 8536, 9405, 1103, 1104, 1901 and 4202.
- **None of the new codes carries a rate rule.** Lookups for them return `no_rate_rule`, unless an
  ancestor rule covers them; for example, 8471 at 18% covers 847160 and 847170.
- These synonyms were written from tariff knowledge without looking at `test/eval/`.

## Rates in research that are NOT seeded (gaps)

This table and `known_gaps.json` are generated from the same source, `scripts/seedgen/gaps.mjs`. The API serves `known_gaps.json` as `known_data_gaps[]`. `validate.mjs` fails if a gap prefix is missing from this table.

| Item | Reason |
|---|---|
| (resolved) 0.25% rows | Rough diamonds (710210/710221/710231) and 7103 at 25 bp (Sch V, from 2025-09-22) are now seeded, after code-worker-core allowed odd bp (CGST/SGST = 12.5 bp each). |
| 7104 synthetic / lab-grown stones | Sources disagree (0.25% vs 1.5%). Omitted. |
| 7117 imitation jewellery | 3% under the old 1/2017. Its place in 9/2025 was not confirmed. Omitted. |
| SAC 9988 job work on diamonds (1.5%) | No distinct SAC code. One `other` rule on 9988 would collide with every other job-work type. Jewellery job work (998892) at 5% *is* seeded. |
| 33 specified life-saving drugs (Nil) | Exemption is per drug, so HSN 3004 alone cannot express it. Needs name-level lookup. |
| Glucometers (5%) | Research gives no HSN. Synonyms point to 9027 (primary) and 9018 (related). 9027 has no rule. |
| 3926 / 4014 feeding bottles and nipples (5%) | These broad headings mostly carry other rates, and no specific tariff line was researched. |
| 8703 cars (18% small / 40% large) | Depends on several attributes (cc, fuel, length). Two `other` rules on one prefix would overlap, and the 6-digit cc splits do not match the thresholds. |
| 9404 cotton quilts (Rs 2500 threshold) | A price rule on 9404 would also catch mattresses. No quilt-specific line was researched. |
| 2403 biris (18% from 01-02-2026) | The 8-digit biri code is not in research. 2403 is seeded as "other than biris" at 40%. |
| Tobacco and pan masala compensation cess before 01-02-2026 | Cess rates are not in research. The 28% pan masala row has a condition note saying cess also applied. |
| 7114 silver articles and utensils, 7118 coin, 7110 platinum | Not in research for 9/2025. Synonyms exist, and lookup returns `no_rate_rule`. |
| Sanitary pads (9619), wheelchairs (8713), protein powder (210610), sanitizer (3808), bandages (3005) | Not in research. Synonyms only. |

There are no seeded rules for the period between 22-09-2025 and 30-04-2026 for the re-mapped 2202 99
and 2202 91 tariff items. Research gives only the rates from 01-05-2026 onward. 2202 10 (40% from
22-09-2025) is seeded.

## Verify first (highest traffic)

Rows are identified here by `hsn_prefix` and `effective_from`.

**Sunarone (jewellery billing)**
1. 7113 at 3% (Sch IV). Also confirm that making charges within a jewellery sale fall in the same supply.
2. 7108 and 7106 at 3% (gold and silver, Sch IV).
3. 710239 at 1.5% (cut and polished diamonds, Sch VI).
4. 998892 at 5% (jewellery job work). Also confirm the SAC code and the 11/2017 S.No. 26 wording.
5. 7101 and 7107 at 3%.
6. Decide 7104, 7117, 7114, 7118. Also verify the 0.25% rows: 710210, 710221, 710231 (rough diamonds) and 7103.

**Health app**
1. 3004 at 5% from 2025-09-22, and the 12% history row: medicaments, including Ayurvedic.
2. 3822 at 5%: diagnostic kits and test strips.
3. 9018, 9019, 9020, 9021 and 9022 at 5%: medical devices. Also confirm the entry wording.
4. 9025 at 5% (thermometers). Optical goods: 900130, 900140, 900150, 9003 and 9004 at 5%.
5. 96190030, 96190040 and 96190090 at 5% (diapers). Also confirm the 8-digit codes and their wording.
6. 9993, 997133 and 997131 at Nil: health-care and insurance exemptions.
7. 3305, 330610 and 340111 at 5%: personal care.
8. 3004 at 0% (`nil_rate_list`): transcribe the 33-drug list from 10/2025, then add the named-drug synonyms with `rule_hint`.

**Everyone**
- The price-threshold pairs on chapters 61, 62, 63 and 64, and on 996311 (hotel).
- 2202 beverages (01/2026 and its corrigendum).
- Replace each index-page `source_url` with the specific notification PDF.

## Regenerating

The JSON files are generated by `scripts/seedgen/gen.mjs`, which builds them from `codes.mjs`,
`rules.mjs` and `syn.mjs`. Edit those source files and do not hand-edit the JSON. To regenerate and
check:

```
node scripts/seedgen/gen.mjs && node scripts/seedgen/validate.mjs
```

`validate.mjs` checks that every file parses and that every referenced code exists. It also checks
parents, allowed slabs, official source hosts, rule overlaps and synonym uniqueness.
