# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/qaz19qpl/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/qaz19qpl/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot of 2026-11-14: 758 protocols scanned, the 40-protocol watchlist covered in full, and 190 protocols that record no token ranked by implied value — the 40 watchlist rows plus 150 early finds the same screen picks past the floor. Protocols whose token already trades are never ranked; the dashboard sets them aside at the market's own values.

## The model

Every figure comes from the snapshot itself; no protocol's name is special-cased.

```
implied value = TVL × peer multiple × momentum × maturity × breadth
```

- **Peer multiple** — for each category, the median market-cap/TVL of the snapshot's own tokenised protocols (133 peers; global median 0.186×), shrunk toward the global median when a category has few peers and clamped to 0.03×–1.6×. Exchange (CEX) records are excluded from the peer set.
- **Momentum** — the 7-day TVL change, clamped to −40%…+60%, at weight 0.6.
- **Maturity** — rises from 0.8 to 1.15 over 1,460 days of tokenless record (listed_at → as_of); an unknown listing day is scored mid-scale, never at the top.
- **Breadth** — 1 + 0.05 × ln(1 + chains), a mild distribution factor.

Each row of `board.json` carries its full breakdown, and the dashboard's detail view shows the same arithmetic. Farm plans (6 steps per protocol) are generated from each protocol's category, chains, TVL tier and age, with dollar costs and times.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Node 22.18+, standard library only. Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory (defaults: reads `/input/snapshot.json`, writes `/output`). The program is deterministic: the same snapshot produces byte-identical output on every run. Open `dashboard/index.html` from the output to use the radar — sortable board, category/chain/tier/status filters, search, a per-protocol detail view, and the already-trading set.

<sub>Entered on [make.fun](https://make.fun/?ref=azy0wp0s&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
