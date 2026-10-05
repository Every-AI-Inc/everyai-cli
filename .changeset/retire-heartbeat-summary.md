---
"@everyai/cli": patch
---

`get_heartbeat_summary` is retired. It read the stored result of the "pipeline_heartbeat" routine, which no longer runs, so it returned stale or empty data. Read a scheduled task's latest completed result with `get_scheduled_task_result` instead, passing a `task_id` from `list_scheduled_tasks`. It is read-only, it does not run the task, and the CLI treats it as a free read, like `get_daily_brief`. The bundled `use-every` skill and the test fixtures that mirror the server's tool surface now name the new tool.
