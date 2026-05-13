# LLM Wiki — knowledge base

Pattern from [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The cross-cutting brain lives at `Myvault\ClaudeRoot\_brain`; per-project knowledge lives here.

## Layout

- `wiki/INDEX.md` — top-level map, read first
- `wiki/entities/` — one file per person/company/product/thing
- `wiki/topics/` — concepts, themes, open questions
- `wiki/claims/` — specific claims with evidence + provenance
- `wiki/sources/` — raw notes from things fed in
- `chats/` — append-only transcripts of past Claude sessions

## Rules

- Integrate, don't append. Update existing pages.
- Note contradictions under a `## Contradictions` section.
- Provenance always — every non-trivial claim links to its source.
- Prune stale content; don't stack corrections.
- Use `[[wikilinks]]` so the Obsidian graph stays connected.
