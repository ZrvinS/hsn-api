# Classifier evaluation set: `classify-eval.jsonl`

> **PROVISIONAL.** Every label in `classify-eval.jsonl` is an **LLM draft pending human review**
> (`labelled_by: claude-classification-worker (LLM draft …)`, `reviewed_by: null`). 06 AI-40 requires
> human labels, so **the AI-42 gates computed from this file are provisional** and are not a
> release sign-off until a human has labelled or reviewed every item.

- **Format:** one JSON object per line, validated by `EvalItem` in `scripts/eval-classifier.ts`.
- **Required fields:**
  - `label`: the 4-digit heading, or `none`
  - `expected_codes`
  - `category`
  - `adversarial`
  - `uncertain`
  - `source_of_label`
  - `labelled_by`
  - `reviewed_by`
- **Optional fields:**
  - `label8`: an 8-digit tariff item, given only where the name determines it; used for top-1@8
  - `set`: e.g. `r5_high_probe`, the 50 retail phrasings that probe the high band, written without reference to the synonym list
  - `excluded`: the reason an item is left out of all metrics, e.g. AI-45 leakage
- **Gated items:** items with `uncertain: true` or `excluded` are not gated.
- **Gate scope:** top-3 recall is gated on items whose heading exists in the seed master. This is a coordinator-approved provisional scope; Amit's sign-off is pending. The decision, its reason and its exit condition (the full HSN master loaded and the labels human-reviewed, after which the gate reverts to all positives) are recorded in `docs/00-coordinator-decisions.md`, "Eval gate scope decision (AG-12 sign-off), 2026-10-11". Top-3 over all positives is reported only.
- **Run:**
  - `npm run eval` (or `npx tsx scripts/eval-classifier.ts [--json]`)
  - CI gate: `test/eval/eval.test.ts`
  - regression baseline: `baseline.json`, which must be a previous `classifier.version`
- **Labels:** do not edit labels to make a gate pass.
