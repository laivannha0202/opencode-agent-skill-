# Large repository strategy

Start with a compact map:

- repository instructions
- package/workspace manifests
- package containing the entry point
- direct dependency packages
- nearest analogous implementation
- relevant tests and build scripts

Then follow edges only when evidence requires it.

Prefer interface boundaries (types, public functions, route/service contracts, schemas) over implementation detail until a boundary is implicated. When a search returns many matches, narrow by package/import/caller rather than opening every result.

Before a major new read, ask: what uncertainty will this file resolve? If the answer is unclear, do not load it yet.
