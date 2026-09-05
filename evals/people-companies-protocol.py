"""Actual CLI process -> registered FastMCP HTTP -> signed PostgREST -> local PG.

Run with the API worktree's Python and PC_API_WORKTREE / PC_SCHEMA_DSN /
PC_POSTGRES_BIN. Clerk identity, bookkeeping owner and optional external tracking
are injected; approval persistence returns a synthetic pending request and send
transport is captured. No shared or provider writes.
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from unittest.mock import AsyncMock, Mock, patch

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
API = Path(os.environ['PC_API_WORKTREE']).resolve()
# Uninjected application I/O must never inherit a developer's shared DB.
os.environ['SUPABASE_URL'] = 'http://127.0.0.1:59999'
os.environ['SUPABASE_SERVICE_API_KEY'] = 'local-synthetic-only'
sys.path[:0] = [str(API), str(API / 'tests/people_companies/mcp_writes')]
import test_protocol as protocol


def run(scenario=None):
    protocol.FinancialProtocol.setUpClass()
    try:
        proof = protocol.FinancialProtocol()
        proof.setUp()
        from mcp_server.admin import server, network_tools
        from mcp_server.admin.handlers import network, settings, write_send
        from services import member_reports_service, billing_authz, agent_chat_service
        import supabase_client
        transport = AsyncMock(return_value=(True, 'captured-only', None))
        with proof.adapters(), ExitStack() as stack, tempfile.TemporaryDirectory(prefix='pc-cli-proof-') as config:
            for module in (supabase_client, member_reports_service, network_tools, settings):
                stack.enter_context(patch.object(module, 'supabase', proof.system))
            stack.enter_context(patch.object(network, 'record_mcp_event', AsyncMock()))
            stack.enter_context(patch.object(server, '_record_mcp_tool_call', Mock()))
            stack.enter_context(patch.object(write_send, 'send_invoice_direct', transport))
            stack.enter_context(patch.dict(os.environ, {'MCP_APPROVAL_GATE_ENABLED': 'true', 'MCP_APPROVAL_WAIT_SECONDS': '0'}))
            billing_authz.reset_scope_cache_for_testing()
            calls = []
            actual = server.mcp._tool_manager.call_tool
            async def counted(name, arguments, **kwargs):
                calls.append((name, arguments))
                return await actual(name, arguments, **kwargs)
            stack.enter_context(patch.object(server.mcp._tool_manager, 'call_tool', counted))
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
            app = server.mcp.streamable_http_app()
            http = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning'))
            thread = threading.Thread(target=http.run, daemon=True)
            thread.start()
            try:
                for _ in range(100):
                    if http.started: break
                    time.sleep(.05)
                else: raise AssertionError('FastMCP HTTP failed to start')
                env = {**os.environ, 'EVERY_MCP_URL': f'http://127.0.0.1:{port}', 'EVERY_CONFIG_DIR': config,
                       'EVERY_TOKEN': 'synthetic-identity-injected-at-server', 'EVERYAI_FORCE_FILE_STORE': '1'}
                env.pop('NODE_OPTIONS', None)
                if scenario is not None:
                    scenario(proof, calls, env)
                    transport.assert_not_awaited()
                    return
                def cli(*args, expect=0):
                    result = subprocess.run(['node', str(ROOT/'dist/index.js'), *args, '--json'], cwd=ROOT, env=env, text=True, capture_output=True, timeout=20)
                    assert result.returncode == expect, (args, result.returncode, result.stdout, result.stderr)
                    value = json.loads(result.stdout)
                    if expect: return value
                    data = value['data'].get('structured_content', value['data'])
                    return data.get('result', data) if isinstance(data, dict) else data
                def create(kind, name, emails):
                    command = {'operation_id': str(uuid.uuid4()), 'name': name,
                               'methods': [{'action': 'upsert', 'kind': 'email', 'display_value': email, 'is_primary': i == 0} for i, email in enumerate(emails)]}
                    return cli('tool', 'call', 'create_'+kind, '--arg', 'command='+json.dumps(command), '--yes')['party']
                person = create('person', 'CLI Person', ['primary@example.com', 'secondary@example.com'])
                company = create('company', 'CLI Company', ['billing@example.com'])
                assert cli('person', 'list', '--search', 'secondary@example.com')['items'][0]['id'] == person['id']
                assert cli('company', 'list', '--search', 'CLI Company')['items'][0]['id'] == company['id']
                start = len(calls)
                cli('invoice', 'create', '--party', 'CLI Person', '--operation-id', str(uuid.uuid4()), '--amount', '12', expect=4)
                assert len(calls) == start, 'Local policy ran a tool before permission'
                for party in (person, company):
                    operation = str(uuid.uuid4())
                    arguments = ['invoice','create','--party-kind',party['kind'],'--party-id',party['id'],'--operation-id',operation,'--amount','12','--yes']
                    created = cli(*arguments)
                    repeated = cli(*arguments)
                    assert repeated['invoice_id'] == created['invoice_id'] and repeated['was_replay']
                    row = proof.tx.current('invoices', created['invoice_id'])
                    assert row['contact_id' if party['kind']=='person' else 'client_id'] == party['id']
                    assert row['client_id' if party['kind']=='person' else 'contact_id'] is None
                    method = proof.f.query('SELECT id FROM contact_methods WHERE '+('contact_id' if party['kind']=='person' else 'client_id')+'=%s AND is_primary', [party['id']])[0]['id']
                    proof.f.rpc('network_set_recipient_defaults', [proof.org, party['kind'], party['id'], 'invoice', 0, str(method), [], str(uuid.uuid4())])
                    preview = cli('invoice','preview-send',created['invoice_id'])
                    assert preview['party']['kind'] == party['kind']
                    recipients = Path(config)/'recipients.json'
                    binding = preview['recipients']
                    # The real gate/CLI metadata path is exercised. Durable approval
                    # storage is outside this reduced fixture and explicitly injected.
                    recipients.write_text(json.dumps(binding))
                    before_calls = len(calls)
                    pending_request = {'request': {'request_id': str(uuid.uuid4()), 'expires_at': '2099-01-01T00:00:00Z'}, 'created': False}
                    with patch.object(agent_chat_service, 'get_or_create_mcp_permission_request', AsyncMock(return_value=pending_request)), patch.object(agent_chat_service, 'consume_mcp_permission_approval', AsyncMock(return_value={'decision': 'pending'})):
                        denied = cli('invoice','send',created['invoice_id'],'--recipients',str(recipients),'--yes','--allow-destructive', expect=4)
                    assert denied['error']['mcp_gate']['type'] == 'human_approval'
                    assert len(calls) == before_calls + 1, 'CLI auto-retried human approval'
                    recipients.write_text(json.dumps({**binding, 'to': 'wrong@example.com'}))
                    cli('invoice','send',created['invoice_id'],'--recipients',str(recipients),'--yes','--allow-destructive', expect=1)
                    recipients.write_text(json.dumps(binding))
                    version = proof.f.query('SELECT version FROM contact_methods WHERE id=%s', [method])[0]['version']
                    proof.f.rpc('network_save_method', [proof.org, party['kind'], party['id'], str(method), version, 'email', 'changed-'+party['kind']+'@example.com', True, False, None])
                    cli('invoice','send',created['invoice_id'],'--recipients',str(recipients),'--yes','--allow-destructive', expect=1)
                    assert proof.tx.current('invoices', created['invoice_id'])['invoice_status'] == 'draft'
                # Same-name, same-UUID objects remain separate namespaces.
                proof.f.query("INSERT INTO clients(id,org_id,user_id,name) VALUES(%s,%s,'owner','CLI Person')", [person['id'], proof.org])
                before = proof.f.query('SELECT count(*) n FROM invoices WHERE org_id=%s', [proof.org])[0]['n']
                ambiguous = cli('invoice','create','--party','CLI Person','--operation-id',str(uuid.uuid4()),'--amount','12','--yes', expect=6)
                choices = ambiguous['error']['candidates']
                assert {(item['kind'], item['id']) for item in choices} == {('person',person['id']),('company',person['id'])}
                assert proof.f.query('SELECT count(*) n FROM invoices WHERE org_id=%s', [proof.org])[0]['n'] == before
                transport.assert_not_awaited()
                assert proof.f.query('SELECT count(*) n FROM contacts WHERE org_id=%s', [proof.org])[0]['n'] == 1
                assert proof.f.query('SELECT count(*) n FROM clients WHERE org_id=%s', [proof.org])[0]['n'] == 2
                print(json.dumps({'verdict':'PASS','proof':'CLI HTTP / real FastMCP / signed PostgREST / local PG', 'tool_calls':len(calls), 'sends':0, 'typed_profiles':2,'typed_invoices':2,'duplicate_invoices':0}), flush=True)
            finally:
                http.should_exit = True
                thread.join(5)
                assert not thread.is_alive(), 'Owned FastMCP server did not stop'
    finally:
        protocol.FinancialProtocol.doClassCleanups()

if __name__ == '__main__':
    run()
