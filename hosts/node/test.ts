import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionResponse, readHistory, shown, transcriptPath, userMessage } from './claude-chat.ts';

test('a permission is answered as the CLI asks', () => {
  const request = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [{ type: 'addRules' }] };
  const allowed: any = permissionResponse('r1', request, true, false);
  assert.equal(allowed.type, 'control_response');
  assert.equal(allowed.response.request_id, 'r1');
  assert.equal(allowed.response.response.behavior, 'allow');
  assert.equal(allowed.response.response.updatedInput.command, 'ls');
  assert.equal(allowed.response.response.updatedPermissions, undefined);
  const always: any = permissionResponse('r1', request, true, true);
  assert.equal(always.response.response.updatedPermissions[0].type, 'addRules');
  const denied: any = permissionResponse('r1', request, false, false, 'no');
  assert.deepEqual(denied.response.response, { behavior: 'deny', message: 'no' });
});

test('only what the page shows goes to it', () => {
  assert.ok(shown({ type: 'system', subtype: 'init', model: 'x' }));
  assert.ok(!shown({ type: 'system', subtype: 'thinking_tokens' }));
  assert.ok(shown({ type: 'stream_event', event: {} }));
  assert.ok(shown({ type: 'control_request', request: {} }));
  assert.ok(!shown({ type: 'rate_limit_event' }));
});

test('a typed message is a user turn', () => {
  assert.deepEqual(userMessage('hi'), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
});

test('the past comes from the transcript, without sub-agents', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-chat-'));
  const project = join(home, '.claude', 'projects', '-x');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'abc.jsonl'), [
    '{"type":"queue-operation"}',
    '{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}',
    '{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"hello"}]}}',
  ].join('\n'));
  assert.ok(transcriptPath('abc', home));
  const past: any[] = readHistory('abc', home);
  assert.equal(past.length, 2);
  assert.equal(past[0].message.content[0].text, 'hi');
  assert.equal(past[1].message.content[0].text, 'hello');
  assert.deepEqual(readHistory('none', home), []);
});
