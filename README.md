# Token Radar — size-fitted token launch radar

A ranked board of 219 pre-token launch candidates drawn from the sealed
DefiLlama snapshot, each with an implied token value from a valuation
model fitted to protocol size and a concrete 5-step farm plan, plus a
filterable dashboard with a per-protocol detail view.

## The model (5 lines)

1. **Universe:** launch candidates only. CEX, Bridge and Canonical
   Bridge are excluded — venues and asset movers whose tokens already
   exist, or claims on existing assets. Of the remaining pre-token
   protocols, one boards when its category holds at least 3 live comps,
   when it sits on the snapshot watchlist, or when its TVL is at least
   $20M. All 40 watchlist protocols are on the board.
2. **Size fit:** log(market cap) = a + b × log(TVL), fitted on the 128
   live-token protocols with robust Huber weights, so one outsized
   listing cannot bend the line. A category with at least 8 comps blends
   in its own fitted line at weight n/(n+6); below that, the global line
   stands plus the category's median residual, shrunk by the same
   weight. The fitted slope is under 1: value grows slower than TVL.
3. **Growth:** × (1 + clamp(7-day TVL change, −50%, +100%) × 0.35).
4. **Maturity:** × (0.70 + 0.50 × min(age in days, 1460) / 1460); age
   unknown → 0.95.
5. **Backtest:** leave-one-out on all 128 listed protocols — each
   market cap predicted from a fit that excludes it. Median error
   84.65%, median signed error +0.11%. The previous model (category
   median multiples) posted 91.81%. Farm plans stay 5 steps per row
   from category playbook × TVL tier × primary-chain gas tier, with a
   30-day gas total and an EV-to-gas rating.

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
- `lib/model.ts` — the size-fit model, backtest, gas tiers and farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library (verbatim).
- `dashboard/` — the static page (index.html, app.css, app.js; no network).
- `screenshots/` — three renders of the page with the real board data.
