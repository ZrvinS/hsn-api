# HSN Rate API

An API that client apps (billing, jewellery, pharmacy) call to look up the GST rate for an HSN/SAC code, detect the HSN code from a product name or barcode with a confidence score, and calculate CGST/SGST/IGST/UTGST for an invoice.

**Data status:** there is no official free real-time GST rate API. Rates are curated from CBIC notifications, effective-dated, and each cites its notification. The shipped seed rates came from secondary sources and are all marked `unverified` until two people check them against the CBIC gazette PDFs. See `server/data/seed/README.md` and `docs/01-PRD.md` §2.

| Folder | Contents |
|---|---|
| `server/` | The API server (Node 22, TypeScript, Fastify, SQLite). Start with `server/README.md`. |
| `docs/` | PRD, TRD, app flow, security checklist, AI restrictions, best practices, design (OpenAPI, data model, architecture). Index: `docs/README.md`. |
| `research/` | Cited research on GST rate sources and barcode data sources. |
| `reviews/` | Validator and security audit reports, and the fix logs for each round. |
