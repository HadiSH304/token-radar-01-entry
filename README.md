# Token Radar — comps-based token launch radar

A ranked board of all 342 pre-token protocols in the sealed DefiLlama
snapshot, each with an implied token value and a concrete 5-step farm plan,
plus a filterable dashboard with a per-protocol detail view.

## The model (5 lines)

1. **Comps:** each protocol is priced off the live market — TVL × the
   median market-cap/TVL multiple of the live-token protocols in its own
   category (trimmed median at ≥8 comps; global median when a category
   holds fewer than 3 comps). The pool actually used holds 128 live
   protocols across 34 categories.
2. **Growth:** × (1 + clamp(7-day TVL change, −50%, +100%) × 0.35).
3. **Maturity:** × (0.70 + 0.50 × min(age in days, 1460) / 1460); age
   unknown → 0.95.
4. **Backtest:** the same multiples predict listed protocols' market caps
   from TVL (excluding the protocol itself); the median error is shown in
   the dashboard's Methodology panel.
5. **Farm plans:** 5 steps per row from category playbook × TVL tier ×
   primary-chain gas tier, with a 30-day gas total and an EV-to-gas rating.

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
- `lib/model.ts` — the comps model, backtest, gas tiers and farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library (verbatim).
- `dashboard/` — the static page (index.html, app.css, app.js; no network).
- `screenshots/` — three renders of the page with the real board data.
