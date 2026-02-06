# Lichess Research Snapshot

## Short Answers
1. **Is Lichess open source?** Yes. The main server codebase (`lila`) is open source under **AGPL-3.0 (or later)**.
2. **Can we fork it?** In principle, yes—AGPL permits forking and modification, but you must comply with the license and any separate asset licenses (pieces, fonts, etc.). Lichess’s Terms allow use and reproduction of their software/website as long as you comply with the applicable licenses.
3. **Do they have APIs?** Yes. Lichess provides a public HTTP/JSON API. Rate-limit guidance includes “one request at a time” and waiting after HTTP 429.
4. **Opening Explorer API?** Yes. The Opening Explorer service has public endpoints `/masters`, `/lichess`, and `/player` (hosted at `explorer.lichess.ovh`).
5. **What data can we extract/use?** Lichess publishes large database exports under **CC0**, explicitly allowing download, modification, and redistribution.

## What This Means For the Opening Trainer

### Option A — Use Lichess Opening Explorer API (lowest lift)
- The Opening Explorer endpoints are the same service used by the analysis “book” feature. You can query a position and receive move statistics, then sample moves by your desired probabilities (e.g., 60/30/10).
- Pros: No big infrastructure, quickly matches Lichess data.
- Cons: Rate limits and reasonable caps apply.

### Option B — Run Your Own Opening Explorer Service
- The `lila-openingexplorer` service is open source (AGPL).
- Pair it with Lichess CC0 database dumps for local, high-volume, or custom-filter use.
- Pros: Full control over filtering, rate limits, caching, and custom datasets.
- Cons: You now own the compute/storage/indexing pipeline.

### Option C — Build a Custom Stats Pipeline
- Use the CC0 database dumps, compute your own per-position move frequencies, and drive the trainer from your own store.
- Best if you need highly specialized filters or deterministic caching and want to avoid API dependencies.

## Important Constraint if Integrating With Live Lichess Games
- Lichess Terms forbid using external assistance (engines, books, databases) in games on their site. If your trainer ever connects to live Lichess play, you’ll need to ensure it doesn’t violate fair-play rules.

## Recommendation
Start with **Option A** (Opening Explorer API) for a prototype. Your sampling logic (top N moves with probability weights) can live entirely in your app. If you hit rate limits or need deeper customization, migrate to **Option B or C** using the CC0 dumps.

## Sources
- [Lichess lila repository](https://github.com/lichess-org/lila)
- [Lichess Terms of Service](https://lichess.org/terms-of-service)
- [Lichess Developers API](https://lichess.org/developers)
- [Lichess API tips](https://lichess.org/page/api-tips)
- [Lichess Opening Explorer (source)](https://github.com/lichess-org/lila-openingexplorer)
- [Lichess database dumps (CC0)](https://database.lichess.org/)
