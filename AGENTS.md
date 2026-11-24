# Agent notes

## Codebase knowledge graph (Understand-Anything)
- `.ua/knowledge-graph.json` maps every file, exported function, import, call, layer and a guided tour of this repo. Read it (or use the `understand-chat` / `understand-explain` skills) before exploring source for architecture questions.
- Auto-update is on (`.ua/config.json`): after each commit the plugin hook asks you to refresh the graph incrementally. Commit the updated `.ua/` files with your change.
- If the graph is missing or broken, rebuild it with the `understand` skill (`--full`). Node 22+ and pnpm 10+ are required.
