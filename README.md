# Token Radar — cross-validated token launch radar

A ranked board of 219 pre-token launch candidates drawn from the sealed
DefiLlama snapshot, each with an implied token value from a multi-feature
valuation model selected by cross-validation and a concrete 6-step farm
plan, plus a filterable dashboard with a per-protocol detail view, a
sector sweep chart and a farm-plan export.

## The model (5 lines)

1. **Universe:** launch candidates only. CEX, Bridge and Canonical
   Bridge are excluded — venues and asset movers whose tokens already
   exist, or claims on existing assets. Of the remaining pre-token
   protocols, one boards when its category holds at least 3 live comps,
   when it sits on the snapshot watchlist, or when its TVL is at least
   $20M. All 40 watchlist protocols are on the board.
2. **Selection:** eight candidate pipelines (feature set × category
   shrinkage × trimmed or untrimmed fit) are scored by 5-fold
   cross-validation on the 128 live-token protocols; a challenger
   replaces the default only when it scores better by more than 1.5
   points. On this snapshot the default stands: log TVL + log age,
   offset k=4, trimmed.
3. **Fit:** log(market cap) on log TVL and log age, Huber-robust, then
   refitted on the points inside 2.2 MAD sigmas; each category adds its
   median residual shrunk by n/(n+4). A calibration multiplier (×1.1388
   on this snapshot) zeroes the median signed error of the pipeline's
   own out-of-fold predictions. 7-day growth and chain count were
   tested and rejected by cross-validation — they are shown as data,
   not used in the price.
4. **Backtest:** leave-one-out on all 128 listed protocols — the full
   procedure (selection, calibration, fit) rerun without each protocol
   in turn. Median error 82.48%, median signed error +5.85%. The v2
   size fit posted 84.65%; the v1 category-median model 91.81%.
5. **Farm plans:** 6 steps per row from the protocol's own category,
   chains and TVL tier, with per-step and total gas, total hands-on
   time, an airdrop pool of 5–15% of implied FDV by category, a
   per-wallet EV figure and an EV-to-gas rating.

Implied values are this board's own claims, never prices or promises.

## How to run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22.18+ (the entry runs on Node 22, standard library only, no
network). Output: `board.json`, `data.js`, `dashboard/`, `screenshots/`,
`dossier.json` under the output directory.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes outputs.
- `lib/model.ts` — the cross-validated fit, backtest, gas tiers and farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library (verbatim).
- `dashboard/` — the static page (index.html, app.css, app.js; no network).
- `screenshots/` — three renders of the page with the real board data.
