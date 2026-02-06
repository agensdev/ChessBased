# ChessBased — Opening Repertoire Trainer

A browser-based chess opening trainer that helps you build, practice, and internalize your opening repertoire using real game data from the Lichess database.

## What It Does

ChessBased puts you on a board against an opponent that plays moves real people actually play. You practice your openings against statistically realistic responses, lock in the moves you want to memorize, and get immediate feedback when you stray from your prepared lines.

### Core Training Loop

1. **You play a move** — either from memory or by browsing the explorer panel
2. **The bot responds** — picking from the most popular moves in the Lichess database, weighted by how often real players choose them
3. **You see the data** — win rates, popularity, game counts for every candidate move at the current position
4. **You build muscle memory** — repeat lines until they're automatic

### Repertoire System

The central feature. For any position, you can **lock** specific moves to define your repertoire:

- **Lock individual moves** from the explorer panel
- **Lock entire lines** with one click to save a sequence from the starting position to where you are
- **Lock to new repertoire** — lock a line into a fresh repertoire in one click
- **Multiple repertoire systems** — maintain separate repertoires (e.g. "Main Lines", "Aggressive", "Anti-Sicilian") and switch between them instantly
- **Visual feedback during play** — moves are color-coded green when you follow your repertoire, red when you deviate
- **Bot follows your locks** — when the bot has locked moves for a position, it plays those, simulating the specific lines you want to practice against

### Explorer Panel

A live window into the Lichess Opening Explorer showing the top 10 moves for the current position:

- Move notation with popularity percentage and total game count
- Win / Draw / Loss bar for each move
- Current opening name displayed in real-time
- Click any move to play it directly on the board
- Filter by rating range (400–2500) and time control (bullet through correspondence)

### Position Analysis

Automatic detection of critical moments in the opening:

- **Danger alerts** — the position is good but there's a spread between best and average; miss the right move and you lose ground
- **Opportunity alerts** — the best move outperforms the position's objective value; a chance to gain an edge
- **Trap alerts** — a popular move scores significantly worse than the average; many players fall for it
- Move-by-move badges (best, blunder, trap, book) annotating the game as you play

### Engine Evaluation

Stockfish 17 runs in the background providing:

- Live evaluation bar showing who stands better and by how much
- Centipawn and mate-in-N scores
- Toggleable for distraction-free training

### Board & Navigation

- Full legal-move validation via chessops
- Arrow key navigation through move history
- Click any move in the history to jump to that position
- "Continue from here" to branch off at any point
- Flip board to view from either side
- Play as White, Black, or Manual (both sides yourself)
- **PGN import** — paste PGN to load lines into your repertoire

## Tech Stack

- **Vite + TypeScript** — no framework, pure DOM manipulation
- **@lichess-org/chessground** — the same board UI used by Lichess
- **chessops** — chess logic, move generation, FEN handling
- **Stockfish 17** — engine evaluation via Web Worker
- **Lichess Opening Explorer API** — real game statistics
- **localStorage** — all repertoire data and settings persist locally

## Getting Started

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. No backend needed — everything runs in the browser.

## Configuration

All settings are in the collapsible panel on the left sidebar:

| Setting | Description |
|---------|-------------|
| Mode | White / Black / Manual |
| Bot weighting | Popularity-weighted or equal random |
| Top moves | How many moves the bot considers (1–10) |
| Ratings | Which rating brackets to include in explorer data |
| Time controls | Which time controls to include |
| Eval bar | Toggle engine evaluation display |
| Move alerts | Toggle position analysis badges |
| Alert thresholds | Fine-tune sensitivity for trap/blunder detection |
