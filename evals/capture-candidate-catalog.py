"""Regenerate CLI fixtures from the API's real registered FastMCP catalog.

PC_API_WORKTREE points at the candidate API checkout. Run with its Python venv;
use dummy local-only Supabase/OpenAI env values. This imports code but makes no
MCP tool invocation, provider request, or database write.
"""
import asyncio
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(os.environ['PC_API_WORKTREE']).resolve()))
from mcp_server.admin.server import mcp

ALIASES = {
    'list_invoices', 'list_people', 'list_companies', 'create_invoice',
    'list_deals', 'get_pipeline_summary', 'move_deal_stage', 'send_invoice',
    'preview_document_send', 'ask_assistant', 'create_person', 'create_company',
    'update_person', 'update_company', 'end_affiliation',
}

async def main():
    tools = [tool.model_dump(mode='json', exclude_none=True) for tool in await mcp.list_tools()]
    missing = ALIASES - {tool['name'] for tool in tools}
    if missing:
        raise ValueError(f'Candidate lacks required CLI tools: {sorted(missing)}')
    fixtures = ROOT/'tests/fixtures'
    (fixtures/'tools-alias-schemas.json').write_text(json.dumps([tool for tool in tools if tool['name'] in ALIASES], indent=2)+'\n')
    annotations = [{'name': tool['name'], **{field: tool.get('annotations', {}).get(hint, False)
                    for field, hint in [('readOnly','readOnlyHint'), ('destructive','destructiveHint'), ('openWorld','openWorldHint')]}}
                   for tool in tools]
    (fixtures/'tools-annotations.json').write_text(json.dumps(annotations, indent=2)+'\n')

if __name__ == '__main__':
    asyncio.run(main())
