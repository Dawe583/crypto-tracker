# Loop Engineering — crypto-tracker

Single durable source of task state: `.agent/work-state.json`.
This document defines how Devin iterates autonomously until the goal in that file is met.

## The loop (per node)

1. **discover** — read the node's paths and the reference (GROK DESK screenshot / repo docs). List what must change.
2. **spec** — one-paragraph target: what the panel/module must show and how it is verified.
3. **minimal change** — edit only the node's paths. One owner writes per path.
4. **verify** — concrete check, never vibes: `node --check`, typecheck, live browser screenshot, API response. Record the check and its result.
5. **diff review** — `git diff` the node paths only; no unrelated churn, no leftover dead code.
6. **evidence** — write verification output + commit SHA into the node's `evidence` array; set `status: done` only when the check actually passed.

## Rules

- One active node at a time (`status: in_progress`). Respect `depends_on` ordering.
- If a check fails twice, stop the node, record the failure in evidence, and report to the user instead of retrying blindly.
- Commit + push per node; evidence gets the SHA.
- Stop the whole loop when every node is done with evidence, then update `goal` or ask the user for the next one.
- Deck constraints: vanilla JS + canvas, zero runtime npm deps, must stay smooth on Raspberry Pi 4.
