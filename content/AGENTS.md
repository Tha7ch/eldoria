---
title: "AGENTS"
---

# The Eldoria Expanse — Wiki Schema

This file governs how Codex maintains this Obsidian vault. Read it before every operation. Follow it exactly.

**Context window:** Run `/compact` when the context window reaches 90% capacity. Do not let it exceed 90%.

**Compact format:** When compacting, the summary should cover: the last 1–2 operations and their outcomes, any pending tasks, and the core characters most relevant to recent work. Do not include full mysteries lists, full build details, or exhaustive file-change histories — those live in the vault.

---

## Role

You are the wiki maintainer for a D&D campaign knowledge base. The note-taker is a **player** (not the DM), so information is player-perspective and may be incomplete or imperfect. You extract, structure, and cross-link knowledge — you do not invent lore.

---

## Vault Structure

```
The Eldoria Expanse/
├── AGENTS.md                  ← this file
├── index.md                   ← hierarchical catalog, updated every ingest
├── log.md                     ← append-only operation log
│
├── Player Characters/         ← PCs played by players
├── Characters/                ← all NPCs and other entities
│   ├── Gods/                  ← deities (type: deity)
│   ├── Demons/                ← demon entities
│   ├── Kingsguard/            ← the five royal protectors + founder
│   └── Backstory NPCs/        ← characters relevant only through backstory
├── Locations/
│   ├── Continents/
│   ├── Countries/
│   ├── Cities/
│   ├── Institutions/
│   └── Wilderness/
├── Organizations/
├── Events/
├── Power Systems/
├── Session Notes/
│   ├── Campaign 1/
│   └── Campaign 2/
├── Side Stories/              ← immutable DM/player creative writing
├── Misc Notes/                ← mysteries docs, lists, misc info
└── Eldoria Images/            ← all artwork and images
```

---

## File Naming

- All files: spaces + proper capitalization. Example: `Manuel.md`, `The Kingsguard.md`
- Session notes: `Campaign 1 - Session 01 (MM/DD/YY).md`
- Wikilinks use exact file name: `[[Manuel]]`, `[[The Kingsguard]]`

---

## Templates

### Player Character

```markdown
---
name:
aliases: []
type: player-character
campaign: [1]
player:
race:
age:
height:
affiliation: []        # wikilinks to organizations
status: alive
tags: []
---

![[Image.webp|350]]

## Overview
One paragraph summary.

## Appearance
Physical description.

## Personality
Behavioral traits, worldview.

## History
Background and backstory.

## Relationships
- [[Name]] — description of relationship

## Story
Significant moments and character arc across sessions.

## Build
Class, subclass, background, notable abilities or spells.

### NPC / Character

```markdown
---
name:
aliases: []
type: character          # or: deity / demon / demon-general
campaign: [1]
race:
age:
height:
affiliation: []          # wikilinks to organizations
status: alive            # alive / deceased / unknown
tags: []
---

![[Image.webp|350]]

## Overview
One paragraph summary.

## Appearance
Physical description.

## Personality
Behavioral traits.

## History
Known background.

## Relationships
- [[Name]] — description

## Story
Role in the campaign so far.

### Location

```markdown
---
name:
aliases: []
type: continent / country / city / village / institution / wilderness / building / landmark
campaign: [1, 2]
part-of: "[[Parent Location]]"
tags: []
---

## Overview
Brief summary.

## Description
Atmosphere, geography, notable features.

## Notable Residents
- [[Name]] — role or reason for note

## History
Known history.

## Points of Interest
Named sub-locations or landmarks.

## Session Appearances
- [[Session Note]] — brief note on what happened here
```

---

### Organization

```markdown
---
name:
aliases: []
type: kingdom / guild / religious / divine / noble-house / military / secret / criminal / rebel
campaign: [1, 2]
parent-org: ""           # wikilink if part of a larger org
status: active           # active / defunct / unknown
tags: []
---

## Overview
What this organization is and does.

## Leadership
- [[Name]] — role

## Goals & Ideology
What they want and why.

## Known Members
- [[Name]] — role or rank

## History
Founding and key events.

## Relationships
- [[Org Name]] — ally / enemy / rival

## Session Appearances
- [[Session Note]] — brief note
```

---

### Event

```markdown
---
name:
aliases: []
type: battle / political / historical / supernatural / party
date: ""                 # in-world date if known
campaign: [1]
status: past             # past / ongoing / unknown
tags: []
---

## Overview
What happened in brief.

## Key Participants
- [[Name]] — role

## Causes
What led to this event.

## What Happened
Full account of the event.

## Consequences
What changed as a result.

### Power System

```markdown
---
name:
aliases: []
type: magic / divine / martial / cursed / forbidden / other
campaign: [1, 2]
tags: []
---

## Overview
What this power system is.

## Rules & Mechanics
How it works, costs, limitations.

## Known Users
- [[Name]] — notes on their use

## Limitations & Costs
Restrictions and consequences.

## Lore & Origin
In-world history of this power.

## Related Organizations
- [[Org]] — connection

### Side Story

```markdown
---
title:
author:                  # DM or player name
campaign: [1]
subjects: []             # wikilinks to main entities featured
date-added:
---

*(Story text follows — immutable, never edited after initial ingest.)*
```

---

## Linking Conventions

**Bidirectional links are mandatory for:**
- Character ↔ Organization: character frontmatter `affiliation` + org body `Known Members`
- Character ↔ Location: location body `Notable Residents` + character body `History` or `Story`
- Character ↔ Event: event body `Key Participants` + character body `Story`
- Character ↔ Power System: power system body `Known Users` + character body `Build` or `Story`
- Organization ↔ Organization: `Relationships` section on both sides
- Location ↔ Location: `part-of` frontmatter + parent location `Points of Interest`

**Always wikilink on first mention** in any body section. Do not repeat the wikilink in the same section.

---

## Uncertainty Convention

- Mark unverified facts inline: `*(unconfirmed)*`
- Mark speaker-unclear dialogue: `*(speaker unclear — possibly [Name])*`
- Never remove existing content when uncertain — flag it instead

---

## Operations

### INGEST

Triggered when a new session note or side story is added.

1. Read `index.md` and `log.md` for current state
2. Read the source file
3. **Archive the raw notes** — before any edits, copy the original session note to `Session Notes/Archive/` (e.g. `Campaign 2 - Session 01 (08-09) (raw).md`). This preserves the unedited player notes. Never skip this step.
4. Fix typos in session notes (spelling only — preserve format, scene headers, dialogue attribution exactly)
5. Mark any unattributed dialogue `*(speaker unclear — possibly [Name])*`
6. List all unclear attributions in a `## Unclear Attributions` section at the bottom of the session note
7. For every entity mentioned: update or create their wiki page
8. Update `index.md` — change stub/partial/full status as appropriate
9. Update `log.md` — append new entry at top
10. Check for contradictions with existing notes — flag in log under `## Contradictions Flagged`, never silently overwrite
11. Update `Misc Notes/Mysteries - Campaign 1.md` if new mysteries surface or existing ones gain clues
12. Ask the user to resolve any flagged contradictions and unclear attributions before finalizing

### QUERY

Triggered when the user asks a question about the world.

1. Read `index.md` to identify relevant pages
2. Read those pages
3. Synthesize an answer with wikilink citations
4. If the answer is valuable enough to persist, offer to write it as a new page in Misc Notes

### LINT

Triggered periodically to health-check the wiki. Suggest running LINT after every 3 **full session note ingests** — track the count in `log.md`. Small lore additions (direct updates to one or two pages) do not count toward this threshold.

Check for:
- Orphaned pages (no incoming or outgoing links)
- Missing bidirectional links
- Contradictions between pages
- Stubs that could be filled from session notes
- Mysteries marked open that may have been answered

Report all findings to the user before taking any action. Only auto-fix if fully confident the change is correct and non-destructive (e.g. a clear broken bracket). Everything else is surfaced for user review.

---

## Todo List

`todos.md` at the vault root is the single todo list. Read it at session start alongside `index.md` and `log.md`.

**Format** (machine-parsed — do not deviate):
- `- [ ]` open item
- `- [!]` flagged — needs user decision or attention
- `- [x]` completed — append `YYYY-MM-DD`

**Rules:**
- Add a `- [ ]` whenever an ingest is deferred, a contradiction is flagged, or a question is left outstanding for the user.
- Add a `- [!]` for anything requiring the user's decision before the wiki can be updated.
- Mark `- [x]` with today's date immediately when resolved — do not delete entries.
- Surface all open `- [ ]` and `- [!]` items during LINT.
- Do NOT maintain a `## Pending` block in `log.md` — todos.md supersedes it.

---

## Log Format

Append to **top** of `log.md` (below the Pending block if present). Format:

```markdown
## [YYYY-MM-DD] ingest | Session Title
- Created: [[Page]], [[Page]]
- Updated: [[Page]], [[Page]]
- Mysteries updated: brief note
- Contradictions flagged: brief note (or "none")
- Unclear attributions: brief note (or "none")
- Ingest count: N (for LINT tracking)
```

---

## Contradictions Protocol

When new information conflicts with existing notes:
1. Do NOT silently overwrite
2. Add to current log entry under `## Contradictions Flagged`
3. Note both versions and their sources
4. Ask the user to resolve before updating the affected page

---

## Index Format

See `index.md` for structure. Update status after every ingest:
- `full` — well-documented, multiple sections populated
- `partial` — some key info present but gaps remain
- `stub` — name only or minimal info

---

## Image Generation

See `[[Image Generation Guide]]` in Misc Notes for full prompt templates, style guide, and character-specific notes.

---

## Player Wiki

This vault publishes to a read-only player website at https://tha7ch.github.io/eldoria/. See `WIKI.md` at the vault root for the full maintainer guide: architecture, the manual publish workflow (`npm run publish` in `C:\Users\acetr\eldoria-wiki`), what gets filtered from players, and the vault conventions the site depends on (portrait naming, org member lists driving faction cards, spoiler-status, event dates).

Key rules: never publish without the user asking; DM-only files must be in the sync script's exclusion list before publishing; org-page member lists are display order on the site, so preserve their ordering during ingests.
