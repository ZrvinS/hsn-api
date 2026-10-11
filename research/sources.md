# HSN → GST rate API: source research

Compiled 2026-10-10. Every claim links to a URL. **UNVERIFIED** means I could not confirm the claim against a source I fetched. Confidence ratings: **H** = official or several agreeing secondary sources; **M** = one reputable secondary source; **L** = weak or conflicting sources.

> **Access caveat.** This sandbox's egress proxy refused the CONNECT tunnel (`curl: (56) CONNECT tunnel failed, response 403`) for every official host I tried: `tutorial.gst.gov.in`, `services.gst.gov.in`, `cbic-gst.gov.in`, `taxinformation.cbic.gov.in`, `www.cbic.gov.in` and `gstcouncil.gov.in`. WebFetch got `ROBOTS_DISALLOWED` for `taxinformation.cbic.gov.in` and `comtax.wb.gov.in`, and a client error for `cbic-gst.gov.in`. As a result, the actual notification text (gazette PDFs) was **not** read directly. Rates below are taken from reputable secondary summaries such as KPMG, ICAI branches and tax portals. They must be checked against the gazette PDFs before launch. **No official file was downloaded, so `raw/` is empty and there is no sha256 to report.**

---

## 1. Authoritative sources and machine-readable feeds

### 1.1 Legal sources (in order of authority)
| Source | What it is | URL |
|---|---|---|
| Notification 9/2025-Central Tax (Rate), 17-09-2025, in force 22-09-2025 | The goods rate schedule (Schedules I–VII). It **supersedes 1/2017-CT(Rate)**. | CBIC PDF: https://taxinformation.cbic.gov.in/view-pdf/1010436/ENG/Notifications (linked from https://plexconcil.org/public/custom/files/circulars/1758198667.pdf). Supersession: https://www.taxheal.com/?p=104997 |
| 10/2025-CT(Rate) | Goods exemption list. It supersedes 2/2017. | https://studycafe.in/summary-of-multiple-gst-rate-notifications-effective-from-22nd-september-2025-393452.html |
| 11/2017-CT(Rate), as amended by **15/2025-CT(Rate)** (G.S.R. 663(E)) | Services rate notification | https://www.taxheal.com/?p=105314 ; https://navimumbai.icai.org/detail/56581.aspx |
| 12/2017-CT(Rate), as amended by **16/2025** | Services exemptions, including the new exemption for individual life and health insurance | https://studycafe.in/summary-of-multiple-gst-rate-notifications-effective-from-22nd-september-2025-393452.html |
| 13/2025 (handicrafts at 5%), 14/2025 (bricks at 12%), 17/2025 (e-commerce local delivery, s.9(5)) | Companion notifications from the same day | same studycafe URL |
| IGST (Rate) and UTGST (Rate) notifications with the same numbers | IGST rate = CGST rate × 2 | https://www.taxheal.com/?p=104994 |
| Compensation Cess (Rate) 2/2025 | Removes cess on most goods from 22-09-2025 | studycafe URL above |
| 19/2025-CT(Rate), 31-12-2025, in force 01-02-2026 | Tobacco and pan masala move to Schedule III (40%). Schedule VII (14% CGST) is omitted. Biris go to Schedule II (18%). | https://www.taxmann.com/post/blog/gst-rate-schedules-amended-for-pan-masala-tobacco |
| 01/2026-CT(Rate), 30-04-2026 (G.S.R. 328(E)), in force 01-05-2026, plus corrigendum G.S.R. 339(E) of 06-05-2026 | Re-maps tariff items under 2202 (beverages) to follow Finance Act 2026 | https://taxguru.in/?p=1041196 ; https://lookuptax.com/tax-changes/india/cbic-notification-01-2026 |
| CBIC notification index pages | Human-readable lists of notifications | https://cbic-gst.gov.in/hindi/central-tax-rate.html , https://cbic-gst.gov.in/hindi/integrated-tax-rate.html (English: `/central-tax-rate.html`. Could not be fetched from this sandbox.) |
| GST Council meeting outcomes | Recommendations only. They do not change the law until CBIC issues a notification. | https://gstcouncil.gov.in/ (could not be fetched here). KPMG note on the 56th meeting: https://www.in.kpmg.com/taxflashnews/KPMG-Flash-News-Recommendations-of-56th-GST-Council-meeting.pdf |

### 1.2 Is there an official free API or machine-readable rate feed?
- **No official rate API was found.** No source I read describes a public CBIC or GSTN API that returns rates. The GSTN "Search HSN Code" feature is a UI under Services > User Services, searchable by code or description, and returns no rate field (https://tutorial.gst.gov.in/userguide/taxpayersdashboard/Search_HSN_SAC_Tax_Rates.htm). Commercial APIs such as FastGST describe themselves as "aggregating publicly available GST data", with "best effort accuracy" (https://docs.taxlookupapi.fastgst.in/documentations/legal.html). That supports the view that no official feed exists. **Confidence: H that no public official rate API exists. M that no hidden GSP/ASP endpoint exists (UNVERIFIED).**
- Notifications are published only as PDFs, in the e-Gazette and on CBIC's portal (`taxinformation.cbic.gov.in/view-pdf/...`). The schedules are tables inside a PDF, with no XML or CSV version.
- **HSN/SAC master (codes and descriptions only, no rates).** The GST portal offers "Download HSN Directory in Excel Format" (https://tutorial.gst.gov.in/userguide/taxpayersdashboard/Search_HSN_SAC_Tax_Rates.htm). The file commonly referenced is `https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx`. WebFetch received a binary body from that URL, so the file appears to exist and be served. curl was blocked by the proxy (status 000, size 0), so I could not save the file or compute a sha256. Its contents (sheets such as `HSN_MSTR`/`SAC_MSTR` holding code and description, with no rate column) are **UNVERIFIED**.
- GSTR-1 Table 12 uses a portal HSN dropdown that is fed from this master (https://www.taxheal.com/?p=102763).

---

## 2. Rate structure as of 10 Oct 2026

### 2.1 Slabs (Notification 9/2025-CT(Rate) schedules; IGST = 2 × CGST)
| Schedule | CGST | Total (IGST) | Typical scope |
|---|---|---|---|
| I | 2.5% | 5% | Essentials, most food, medicines, apparel/footwear ≤ Rs 2,500 |
| II | 9% | 18% | Standard rate. Since 01-02-2026 it also covers biris. |
| III | 20% | 40% | Demerit and luxury goods: sweetened/aerated drinks, large cars, yachts, revolvers. Since 01-02-2026 it also covers tobacco and pan masala. |
| IV | 1.5% | 3% | Pearls, gold, silver, jewellery (7101, 7106–7108, 7113) |
| V | 0.125% | 0.25% | Rough diamonds (7102), precious and semi-precious stones (7103) |
| VI | 0.75% | 1.5% | Other 7102 (cut and polished diamonds), synthetic stones (7104) |
| VII | 14% | 28% | Tobacco and pan masala until 31-01-2026. **Omitted** from 01-02-2026 by 19/2025. |

Sources: https://www.caclubindia.com/articles/gst-notification-no-92025-complete-hsnwise-rate-schedule-effective-from-september-22-2025-54119.asp ; https://sjexim.services/2025/10/10/new-comprehensive-gst-rate-schedules-notified-by-cbic/ ; https://texprocil.org/circular/1760162881-Eserve-158_of_2025.pdf ; https://www.taxmann.com/post/blog/gst-rate-schedules-amended-for-pan-masala-tobacco . **Confidence: H**

Exemptions (nil rate) are in 10/2025 (goods) and 12/2017 as amended (services). A "0%" result must say which exemption entry applies.

### 2.2 Compensation cess
- Removed on most goods from 22-09-2025 by Comp. Cess (Rate) 2/2025 (https://studycafe.in/summary-of-multiple-gst-rate-notifications-effective-from-22nd-september-2025-393452.html). **H**
- Tobacco and pan masala kept the old structure until the cess loans were repaid (https://www.in.kpmg.com/taxflashnews/KPMG-Flash-News-Recommendations-of-56th-GST-Council-meeting.pdf). Cess on these ends 01-02-2026. From that date tobacco carries Central Excise (Amendment) Act 2025 duties and pan masala carries the Health Security se National Security Cess, both outside GST (https://taxo.online/latest-news/01-01-2026-gst-compensation-cess-on-tobacco-to-end-on-feb-1-orders-govt-new-laws-notified/ ; https://www.outlookbusiness.com/news/additional-excise-duty-on-tobacco-health-cess-on-pan-masala-to-be-effective-feb-1). **H**
- **Design implication:** from 01-02-2026 no GST cess should be returned for any HSN. Store `cess` as a field anyway, because historical queries still need it.

### 2.3 Changes after Sept 2025, up to Oct 2026
1. **19/2025-CT(Rate)** (31-12-2025, in force 01-02-2026): tobacco and pan masala to 40%, biris to 18%, Schedule VII omitted. **H** (taxmann link above)
2. **01/2026-CT(Rate)** (30-04-2026, in force 01-05-2026): 2202 split. Fruit-juice and milk-based drinks (2202 99 21/29/31/39) at 5%. Caffeinated and other beverages (2202 91 00, 2202 99 91/99) at 40%. Corrigendum dated 06-05-2026 (https://taxguru.in/?p=1041196 ; https://lookuptax.com/tax-changes/india/cbic-notification-01-2026). **M** (two secondary sources agree; the gazette was not read)
3. **57th GST Council (08-10-2026): no rate changes.** Rates are to be reviewed once a year at a dedicated meeting. Other decisions cover ITC, refunds and decriminalisation (https://calcguru.in/57th-gst-council-meeting-october-2026/ ; https://a2ztaxcorp.net/important-note-on-the-outcomes-of-the-57th-meeting-of-the-gst-council-held-on-october-08-2026/). **M**
4. Other 2026 corrigenda or rate amendments: **UNVERIFIED.** A complete list would require the CBIC index page, which was blocked here.

### 2.4 Example codes (IGST rate; CGST = SGST = half)
"Sch" refers to the 9/2025-CT(Rate) schedule. Serial numbers were **not** verified because the gazette could not be read; record them when the PDF is ingested.

| # | Code | Description | Rate | Set by / notes | Source | Conf |
|---|---|---|---|---|---|---|
| 1 | 7108 | Gold, unwrought/semi-manufactured | 3% | Sch IV | https://sjexim.services/2025/10/10/new-comprehensive-gst-rate-schedules-notified-by-cbic/ | H |
| 2 | 7106 | Silver, unwrought/semi-manufactured | 3% | Sch IV | same | H |
| 3 | 7113 | Articles of jewellery (gold, silver, diamond-studded) | 3% | Sch IV. Making charges inside a jewellery sale are part of the 3% supply. | same ; https://cleartax.in/s/gst-diamond-jewellery | H |
| 4 | 7101 | Pearls, natural or cultured | 3% | Sch IV | sjexim | M |
| 5 | 7102 (rough) | Rough or simply sawn diamonds | 0.25% | Sch V | sjexim ; https://cleartax.in/s/gst-diamond-jewellery | H |
| 6 | 7102 (cut & polished) | Cut and polished natural diamonds | **1.5%** | Sch VI. Raised from 0.25% w.e.f. 18-07-2022 (47th Council). **The brief's "0.25%" is out of date.** | https://gjepc.org/solitaire/?p=16021 ; sjexim | H |
| 7 | 7103 | Precious/semi-precious stones (not diamonds), not set | 0.25% | Sch V | sjexim ; https://gstgyaan.com/cgst-rate-on-supply-of-goods-schedule-vi | M |
| 8 | 7104 | Synthetic/lab-grown stones and diamonds | 0.25% or 1.5% | **Conflict.** sjexim places 7104 in Sch VI (1.5%). Other sources say 0.25% for rough lab-grown diamonds. Resolve from the gazette. | https://sjexim.services/2025/10/10/new-comprehensive-gst-rate-schedules-notified-by-cbic/ ; https://delmergroup.com/blogs/news/gst-on-gold-jewelry-and-lab-grown-diamond-jewelry-latest-updates-after-gst-council-reforms | L |
| 9 | 7117 | Imitation jewellery | 3% (UNVERIFIED) | Was in the 3% schedule under 1/2017. Its place in 9/2025 was not confirmed. | — | L |
| 10 | SAC 9988 | Job work: jewellery / Ch.71 goods other than diamonds | 5% | 11/2017 Sr 26 as amended by 15/2025 | https://navimumbai.icai.org/detail/56581.aspx | M |
| 11 | SAC 9988 | Job work on diamonds | 1.5% | same entry | same | M |
| 12 | 3004 | Medicaments (incl. Ayurvedic, Unani, homoeopathic), retail packs | 5% | Sch I. Was 12%. | https://www.in.kpmg.com/taxflashnews/KPMG-Flash-News-Recommendations-of-56th-GST-Council-meeting.pdf | H |
| 13 | 30xx (33 listed drugs) | Specified life-saving drugs | Nil | Exemption list 10/2025. Drug-specific, so the HSN code alone is not enough. | KPMG | H |
| 14 | 3822 | Diagnostic kits and reagents | 5% | Sch I | KPMG | H |
| 15 | 9025 | Medical thermometers | 5% | Was 18% | KPMG | H |
| 16 | 9018–9022 | Medical, surgical, dental instruments | 5% | Was 12% | KPMG | H |
| 17 | Ch 90 / any | Glucometers and test strips | 5% | | KPMG | H |
| 18 | 9001/9003/9004 | Contact lenses, frames, spectacles | 5% | | KPMG | H |
| 19 | 3926 / 4014 | Feeding bottles / nipples | 5% | | https://www.msassociates.pro/gst/gst-personal-care-and-hygiene.php | M |
| 20 | 9619 00 30/40/90 | Baby and clinical diapers | 5% | | same | M |
| 21 | 3305 / 3306 / 3401 | Hair oil and shampoo / toothpaste / toilet soap | 5% | Was 18% | same | M |
| 22 | 0401 | UHT milk | Nil | Was 5% | KPMG | H |
| 23 | 0406 | Paneer, pre-packaged and labelled | Nil | Cheese (0406) is 5%. Same heading, different rate. | KPMG | H |
| 24 | 0405 | Butter, ghee | 5% | Was 12% | KPMG | H |
| 25 | 1905 | Biscuits, bakers' wares | 5% | Was 18% | KPMG | H |
| 26 | 1806 | Chocolate | 5% | Was 18% | KPMG | H |
| 27 | 2106 90 | Namkeen, bhujia | 5% | | KPMG | H |
| 28 | 2202 10 | Sweetened/flavoured aerated water | 40% | Sch III | KPMG | H |
| 29 | 2202 99 21/29/31/39 | Fruit-juice and milk-based drinks | 5% | Re-mapped by 01/2026 from 01-05-2026 | https://lookuptax.com/tax-changes/india/cbic-notification-01-2026 | M |
| 30 | 2106 90 20 | Pan masala | 40% from 01-02-2026 | 28% plus cess before. Health cess sits outside GST. | https://www.taxmann.com/post/blog/gst-rate-schedules-amended-for-pan-masala-tobacco | H |
| 31 | 8517 | Mobile phones | 18% | Unchanged | https://cleartax.in/s/gst-on-electronics | M |
| 32 | 8471 | Laptops/computers | 18% | | same | M |
| 33 | 8528 | TVs (all sizes), monitors | 18% | Was 28% above 32" | same ; KPMG | H |
| 34 | 8415 | Air conditioners | 18% | Was 28% | KPMG | H |
| 35 | 8703 | Small cars (petrol ≤1200cc, diesel ≤1500cc, ≤4000 mm) | 18% | Larger cars fall in Sch III (40%). Thresholds come from the description, not the HSN. | KPMG | H |
| 36 | 2523 | Cement | 18% | Was 28% | KPMG | H |
| 37 | Ch 61/62/63 | Apparel and made-ups, sale value ≤ Rs 2,500/piece | 5% | Above Rs 2,500 the rate is 18%. | KPMG | H |
| 38 | Ch 64 | Footwear ≤ Rs 2,500/pair | 5% | Above Rs 2,500 the rate is 18%. | KPMG | H |
| 39 | SAC 9963 | Hotel accommodation ≤ Rs 7,500/unit/day | 5% without ITC | Above Rs 7,500 the rate is 18% (UNVERIFIED wording). | KPMG | H |
| 40 | SAC 9963 | Stand-alone restaurant service | 5% without ITC | A stand-alone restaurant cannot opt for 18% with ITC. | KPMG ; https://www.vjmglobal.com/blog/amendment-rate-tax-restaurants | M |
| 41 | SAC 99972 | Beauty and physical well-being (salon, gym, yoga) | 5% without ITC | 11/2017 Sr 35(i) as amended by 15/2025 | https://navimumbai.icai.org/detail/56581.aspx ; KPMG | H |
| 42 | SAC 9971 | Individual life and health insurance | Exempt | 16/2025 | KPMG ; studycafe | H |
| 43 | SAC 9993 | Health care by clinical establishments | Exempt | 12/2017 entry 74 (read with Sch I Sr 437 of 9/2025 per 15/2025) | https://taxguru.in/goods-and-service-tax/gst-health-care-services.html ; https://navimumbai.icai.org/detail/56581.aspx | M |

---

## 3. HSN digit rules and codes with more than one rate

### 3.1 Digit requirements
- **Notification 78/2020-Central Tax (15-10-2020)** sets the minimum digits by aggregate annual turnover (AATO) in the preceding financial year: **4 digits for AATO up to Rs 5 crore and 6 digits above Rs 5 crore** (https://taxguru.in/goods-and-service-tax/implementation-mandatory-mentioning-hsn-codes-gstr-1.html ; https://www.taxheal.com/?p=102763). **H**
  - For AATO ≤ Rs 5 crore, the 4-digit requirement is said to apply to B2B invoices and to be optional on B2C invoices. **UNVERIFIED** (no fetched source stated the B2B/B2C split).
  - 8-digit codes are said to be required for certain notified chemicals and for import/export. **UNVERIFIED**
- GSTR-1 Table 12 rollout: Phase 1 from 01-04-2022 (2 or 4 digits); 6 digits above Rs 5 crore from 01-08-2022; Phase 2 from 01-11-2022 (4 digits up to Rs 5 crore) (taxguru, above). Phase 3 from the May 2025 return period adds a dropdown, the B2B/B2C split and a mandatory Table 13 (https://www.taxheal.com/?p=102763 ; https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760596735_345%20Reporting%20of%20HSN%20codes%20in%20Table%2012%20and%20list%20of%20documents%20in%20table%2013%20of%20GSTR%201%201A.pdf). **M**
- **Implication:** rates are set at mixed granularity: chapter, 4-digit heading, 6-digit sub-heading or 8-digit tariff item. A 4-digit query can therefore return several rates.

### 3.2 One HSN, several rates (known cases)
| HSN | What decides the rate | Source |
|---|---|---|
| Ch 61/62/63 apparel and made-ups | Sale value per piece: ≤ Rs 2,500 at 5%, above at 18% | KPMG |
| 9404 cotton quilts | ≤ Rs 2,500 at 5%, above at 18% | KPMG |
| Ch 64 footwear | ≤ Rs 2,500/pair at 5%, above at 18% | KPMG |
| 8703 motor cars | Engine cc, fuel type, length: 18% or 40% | KPMG |
| 0406 | Paneer (nil) vs cheese (5%) | KPMG |
| 2202 | Juice/milk-based (5%) vs sweetened/caffeinated (40%), re-mapped 01-05-2026 | lookuptax |
| 7102 | Rough (0.25%) vs cut and polished (1.5%) | sjexim ; GJEPC |
| 2403 | Biris (18%) vs other tobacco (40%) | taxmann |
| Ch 30 | 33 named drugs nil, other medicaments 5% | KPMG |
| SAC 9963 | Hotel tariff ≤ Rs 7,500 (5%, no ITC) vs higher (18%); restaurant at specified premises | KPMG |
| Ch 01–21 food | Pre-packaged and labelled vs loose (e.g. 0202–0210: "other than fresh or chilled, pre-packaged and labelled") | caclubindia link (Sch I Sr 2) |
| 9988 job work | Depends on the goods worked on (diamond 1.5%, Ch 71 other 5%, other 18%) | navimumbai ICAI |

The API therefore needs `conditions` and `price_threshold` attributes on each rate row. It must return all candidate rates when the input is ambiguous, never a single guess.

---

## 4. Barcode → product data sources
| Source | Access / cost | License | India coverage | HSN? | URL |
|---|---|---|---|---|---|
| GS1 India DataKart (powers the Smart Consumer app) | Platform for brand owners, with a paid "Premium" tier. **No public third-party API is documented.** | Proprietary | Only GTINs issued by GS1 India, i.e. members. Coverage figures are not published. | Not mentioned on the page. **UNVERIFIED**, likely brand-entered at most. | https://gs1india.org/datakart/ ; https://gs1india.org/datakart-for-brand-owners |
| Open Food Facts | Free REST API (`/api/v3/product/{barcode}`), 15 product reads/min/IP. Requires a custom User-Agent. Bulk CSV/JSONL dumps available. | ODbL (database) + DbCL (contents); images CC BY-SA 3.0 | Partial for Indian FMCG (no figure verified) | No HSN field (UNVERIFIED, schema not fully audited) | https://openfoodfacts.github.io/openfoodfacts-server/api/ |
| Open Beauty Facts | Free API `/api/v2/product/{barcode}.json`. Dumps in MongoDB, JSONL, Parquet and CSV. API calls must match real user scans; scraping is blocked. | ODbL/DbCL; images CC BY-SA 3.0 | Low (UNVERIFIED) | No | https://world.openbeautyfacts.org/data |
| UPCitemdb | Free: 100 requests/day, 6/min/IP. DEV $99/mo (20k lookups/day). PRO $699/mo (150k/day). | Proprietary terms | Mostly US/EU retail (UNVERIFIED for India) | No | https://devs.upcitemdb.com/ ; https://upcitemdb.com/wp/docs/main/development/api-rate-limits/ |
| Others (Barcode Lookup, Go-UPC, EAN-Search) | Paid | Proprietary | **UNVERIFIED** | No | — |

**Finding:** no barcode source I checked returns HSN codes. The barcode only gives a product name, brand and category. HSN must then be inferred by classification (keyword or embedding search over the HSN master), with a human or the merchant confirming.

---

## 5. How commercial providers source and update rates
- **FastGST Tax Lookup API:** aggregates "publicly available GST data". Each rate response carries a `source` field citing the notification (number, date, change) and a `last_updated` field, with "best effort accuracy". Search uses Levenshtein matching plus embeddings. https://docs.taxlookupapi.fastgst.in/documentations/legal.html ; https://docs.taxlookupapi.fastgst.in/documentations/hsn/hsn_get_gst_rate.html
- **ClearTax:** publishes rate-finder content and articles updated after each Council meeting (e.g. https://cleartax.in/s/gst-on-electronics). Its internal process is not public (**UNVERIFIED**).
- **Masters India, Tally and others:** no public description of how they source or update rates was found (**UNVERIFIED**). ERP vendors such as Ginesys ship an "HSN SAC GST Rate Master" that users maintain (https://ginesysone.atlassian.net/wiki/spaces/PUB/pages/28965190/HSN+SAC+GST+Rate+Master).
- In practice the industry transcribes CBIC PDFs by hand. No provider claims an official feed.

---

## 6. Keeping rates current and honest
1. **Watch the sources.** Poll the CBIC Central Tax (Rate) and Integrated Tax (Rate) index pages (https://cbic-gst.gov.in/central-tax-rate.html, `/integrated-tax-rate.html`) and `taxinformation.cbic.gov.in` once a day. No official RSS feed was found (**UNVERIFIED**). Diff the lists of notification numbers. Also watch GST Council press releases, but treat them as "announced", not "in force".
2. **Use a secondary signal.** Monitor 2–3 secondary sources (taxguru, taxmann, ICAI branches) as an early warning. Never publish a rate based on them alone.
3. **Review by a person.** Each new notification goes to a reviewer queue. The reviewer transcribes the amended entries (schedule, serial number, HSN, description, conditions) together with the PDF URL and its sha256, and a second reviewer approves.
4. **Version by effective date.** Store rows as `(hsn_pattern, description_condition, price_min/max, rate, cess, notification_no, sr_no, effective_from, effective_to, superseded_by)`. Never overwrite a row; queries take an `as_of` date, which defaults to the invoice date. The 22-09-2025, 01-02-2026 and 01-05-2026 changes all had future effective dates, so they could be loaded ahead of time.
5. **Track corrigenda.** Corrigenda arrive within days of a notification (e.g. 01/2026 corrected on 06-05-2026), so they need their own entries.
6. **Be honest in every response.** Return `source`, `confidence`, `verified_at`, every candidate rate when conditions apply, and a disclaimer. Return "unknown" rather than a guess.
7. **Run a yearly review.** The Council intends to review rates once a year at a dedicated meeting (57th meeting outcome, calcguru link), so plan a larger review each year.

---

## Implications for our design
1. There is no official rate API. We must transcribe CBIC PDFs (9/2025-CTR plus amendments, 11/2017 and 12/2017 as amended) into our own versioned table.
2. Store rates with `effective_from`/`effective_to` and a notification and serial-number citation. All queries are "as of" a date.
3. Model conditions such as price per piece or pair, cc/length, pre-packaged and ITC restrictions as structured fields. Return several candidates when the input is ambiguous.
4. Rates match at mixed granularity (chapter, 4, 6 or 8 digits). Use longest-prefix match with explicit exclusions, and use the HSN master xlsx only for descriptions.
5. GST cess is zero for all goods from 01-02-2026. Keep the field for history.
6. Jewellery (Sunarone): 7113, 7108 and 7106 are 3%. Cut diamonds are **1.5%**, not 0.25%. Rough diamonds and stones are 0.25%. Job work is 5% (1.5% for diamonds). The 7104 and 7117 rates need gazette confirmation.
7. Health app: most medicines and devices are 5%, the 33 named drugs are nil, individual health insurance and clinical health care are exempt. Specific drug lists need name-level lookup, not HSN alone.
8. Barcode sources never give HSN. Build barcode → product → HSN classification with merchant confirmation, and cache the confirmed mappings per GTIN.
9. Set up a daily CBIC watcher, two-person review, and a re-check of the gazette before go-live. All rates in this file came from secondary sources because the official hosts were blocked from this sandbox.
10. Every response carries `source_url`, `notification`, `confidence` and a "verify before filing" disclaimer. Never present a rate as legal advice.
