"""Live model -> at most five compiled CLI invocations -> actual local MCP/SQL.

The existing protocol harness injects identity and captures external effects.
An explicit synthetic userinfo cache replaces OAuth discovery only. CLI docs,
schemas, policy, argument parsing, lookup, confirmation retry and SQL are real.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from uuid import uuid4

from dotenv import dotenv_values
from psycopg2 import sql

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cli_protocol", ROOT / "evals/people-companies-protocol.py")
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


async def cold_start(provider, proof, calls, env):
    # The ordinary protocol fixture intentionally has a reduced org row.
    # Restore only the captured columns needed by the real settings read.
    meta = Path("/Users/brandonchu-mbp16/Projects/Every")
    catalog = json.loads((meta / "research/2026-09-04-people-companies-refactor/evidence/schema-dev-catalog.json").read_text())["rows"][0]["catalog"]
    required = {"name", "address", "email", "phone", "currency", "brand_logo_url", "brand_color",
                "sales_tax_default", "timezone", "org_links", "subdomain_slug", "url"}
    present = {row["column_name"] for row in proof.f.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orgs'")}
    for column in catalog["columns"]:
        if column["table_name"] == "orgs" and column["column_name"] in required - present:
            proof.f.query(sql.SQL("ALTER TABLE orgs ADD COLUMN {} {}").format(
                sql.Identifier(column["column_name"]), sql.SQL(column["data_type"])))
    proof.f.query("UPDATE orgs SET currency='USD',timezone='UTC' WHERE org_id=%s", [proof.org])
    protocol.protocol.mcp_fixture.MCPPostgrest.process.send_signal(signal.SIGUSR1)
    for _ in range(40):
        try:
            proof.system.table("orgs").select(",".join(sorted(required))).eq("org_id", proof.org).execute()
            break
        except Exception:
            await asyncio.sleep(.05)
    else:
        raise AssertionError("Owned settings schema did not reload")
    person = proof.f.profile(name="[E2E] Cold Start Person", methods=[
        {"action": "upsert", "kind": "email", "display_value": "primary@example.test", "is_primary": True},
        {"action": "upsert", "kind": "email", "display_value": "secondary@example.test", "is_primary": False},
    ])
    operation = str(uuid4())
    cache = Path(env["EVERY_CONFIG_DIR"]) / "cache"
    cache.mkdir(mode=0o700)
    key = re.sub(r"[^a-zA-Z0-9._-]", "_", "custom:" + env["EVERY_MCP_URL"])
    identity_file = cache / ("userinfo-" + key + ".json")
    identity_file.write_text(json.dumps({"fetched_at": int(time.time() * 1000), "userinfo": {
        "user_id": "owner", "org_id": proof.org, "org_name": "Synthetic CLI workspace",
        "org_slug": None, "email": "owner@example.test", "name": "Synthetic Owner"}}))
    identity_file.chmod(0o600)
    private = dotenv_values("/Users/brandonchu-mbp16/Projects/Every/every-fastapi/.env")
    system = ("You are a coding assistant using Every's installed CLI. You have at most five CLI invocations. "
              "Your first invocation must be args=[\"docs\",\"--json\"] to read its offline docs. Use the CLI to complete the user's task and report the actual result. "
              "All records and identity are synthetic in an isolated test workspace. Do not send messages or use staging. "
              "The only available tool runs the actual every binary with an argument array, not a shell command.")
    question = ("Create exactly one draft invoice for the Person whose email is secondary@example.test, "
                "for one unit of Workshop at a unit price of 100 in the workspace's configured currency. "
                f"Use operation UUID {operation}. I authorize creating this draft, but no send or other writes. "
                "Do not create a Company for this Person.")
    tool = {"name": "every_cli", "description": "Run the installed Every CLI. Pass CLI arguments as an array, without the binary name.",
            "input_schema": {"type": "object", "properties": {"args": {"type": "array", "items": {"type": "string"}}}, "required": ["args"]}}
    history = [{"role": "user", "content": question}]
    if provider == "claude":
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=private["ANTHROPIC_API_KEY"], timeout=120, max_retries=0)
        model = private.get("CLAUDE_CORE_MODEL") or "claude-sonnet-5"
    else:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=private["OPENAI_API_KEY"], timeout=120, max_retries=0)
        model = private.get("EVERY_MAIN_OPENAI_MODEL") or "gpt-5.6-luna"
    invocations = []
    try:
        for _ in range(7):
            if provider == "claude":
                response = await client.messages.create(model=model, max_tokens=2500, system=system, messages=history, tools=[tool])
                history.append({"role": "assistant", "content": [item.model_dump(exclude_none=True) for item in response.content]})
                requested = [(item.id, item.name, item.input) for item in response.content if item.type == "tool_use"]
            else:
                response = await client.responses.create(model=model, instructions=system, input=history, store=False,
                    tools=[{"type": "function", "name": tool["name"], "description": tool["description"],
                            "parameters": tool["input_schema"], "strict": False}], reasoning={"effort": "low"}, max_output_tokens=3000)
                history.extend(item.model_dump(exclude_none=True) for item in response.output)
                requested = [(item.call_id, item.name, json.loads(item.arguments)) for item in response.output if item.type == "function_call"]
            if not requested:
                break
            outputs = []
            for call_id, name, arguments in requested:
                assert name == "every_cli" and len(invocations) < 5, "Exceeded five CLI invocations"
                args = arguments["args"]
                assert isinstance(args, list) and all(isinstance(arg, str) for arg in args)
                assert "--staging" not in args
                command = [arg for arg in args if arg not in ("--json", "--no-cache")]
                allowed = command[:1] in (["docs"], ["whoami"], ["help"], ["--help"], ["--version"]) or command[:2] in (
                    ["tools", "list"], ["tools", "describe"], ["person", "list"], ["company", "list"], ["invoice", "create"],
                    ["contacts", "list"], ["contact", "list"], ["people", "list"], ["companies", "list"])
                if command[:2] == ["tool", "call"]:
                    allowed = len(command) > 2 and command[2] in {"business_settings", "list_people", "list_companies", "create_invoice", "view_invoice"}
                assert allowed, f"Unrequested CLI effect refused: {command[:3]}"
                result = await asyncio.to_thread(subprocess.run, ["node", str(ROOT / "dist/index.js"), *args],
                    cwd=ROOT, env=env, text=True, capture_output=True, timeout=20)
                invocations.append({"args": args, "exit_code": result.returncode})
                output = json.dumps({"exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
                print(json.dumps({"provider": provider, "cli": args, "exit_code": result.returncode}), flush=True)
                if result.returncode:
                    print(json.dumps({"provider": provider, "failed_cli_output": output}), flush=True)
                if provider == "claude":
                    outputs.append({"type": "tool_result", "tool_use_id": call_id, "content": output})
                else:
                    outputs.append({"type": "function_call_output", "call_id": call_id, "output": output})
            if provider == "claude":
                history.append({"role": "user", "content": outputs})
            else:
                history.extend(outputs)
        rows = proof.f.query("SELECT id,contact_id,client_id,total_amount,invoice_status FROM invoices WHERE org_id=%s", [proof.org])
        assert invocations and [arg for arg in invocations[0]["args"] if arg != "--json"] == ["docs"]
        assert len(rows) == 1, rows
        assert str(rows[0]["contact_id"]) == str(person["id"]) and rows[0]["client_id"] is None
        assert rows[0]["total_amount"] == 100 and rows[0]["invoice_status"] == "draft"
        assert proof.f.query("SELECT count(*) n FROM clients WHERE org_id=%s", [proof.org])[0]["n"] == 0
        assert proof.f.query("SELECT count(*) n FROM contacts WHERE org_id=%s", [proof.org])[0]["n"] == 1
        created = [arguments for name, arguments in calls if name == "create_invoice"]
        assert created and all(arguments["command"]["operation_id"] == operation for arguments in created)
        assert any(name == "list_people" and arguments.get("query") == "secondary@example.test" for name, arguments in calls)
        assert all(item["exit_code"] == 0 for item in invocations), invocations
        print(json.dumps({"verdict": "PASS", "provider": provider, "model": model, "cli_invocations": len(invocations),
            "mcp_calls": len(calls), "org": proof.org, "invoice_id": str(rows[0]["id"]),
            "binary_sha256": hashlib.sha256((ROOT / "dist/index.js").read_bytes()).hexdigest(),
            "outcome": "one Person invoice by secondary email; no Company, duplicate, or send"}), flush=True)
    finally:
        await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=("claude", "openai"))
    provider = parser.parse_args().provider
    protocol.run(lambda proof, calls, env: asyncio.run(cold_start(provider, proof, calls, env)))
