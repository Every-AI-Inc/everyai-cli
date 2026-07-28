---
"@everyai/cli": minor
---

Track the 85-tool Every MCP surface.

The server surface grew from 78 to 85 tools: custom fields (define, read, set and search, including tags), scheduled tasks (list, create, cancel), record timelines, entity counts, read-only pipeline settings, and pending-deal approval. The six retired Bookings tools are gone.

Tools are discovered at runtime, so they were already reachable — this release brings the local state that does not auto-update into line:

- `approve_pending_deal` is pinned to the write tier by an explicit name-based override. It activates a deal and queues its plan, which is hard to undo, and the server marks it non-destructive — so without this its safety tier would depend entirely on that annotation staying correct.
- The bundled `use-every` skill no longer teaches the removed booking tools, and documents the custom-fields and scheduled-task workflows.
- Test fixtures now mirror the real 85-tool surface with annotations read from the live server rather than hand-written.
