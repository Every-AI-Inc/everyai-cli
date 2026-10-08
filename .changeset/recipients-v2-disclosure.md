---
"@everyai/cli": minor
---

Invoice and proposal sends show the exact recipients first. `every invoice send` and the new `every proposal send` preview the send, print the exact To and CC (name and email), ask for confirmation (`--yes` without a TTY) and send with the binding from the preview. `--expect-digest` stops a send when the fresh preview differs from the approved one. New `every recipients get|set <party> --kind invoice|proposal` reads and sets a person's or company's default recipients. `every tool call send_invoice|send_proposal` refuses a missing or invalid recipients binding.
