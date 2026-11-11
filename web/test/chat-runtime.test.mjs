import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { prepareChatRequest, CHAT_MAX_MESSAGES, CHAT_MAX_BYTES } from '../server/chat.mjs';

const encode = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const terminal = (text, type = 'response.completed') => ({ type, response: { output: [{ type: 'message', role: 'assistant', id: 'answer', content: [{ type: 'output_text', text }] }], usage } });
const agentMessage = (id, agent, text, phase = 'final_answer') => ({
  type: 'message', id, role: 'assistant', agent: { agent_name: agent }, phase, content: [{ type: 'output_text', text }],
});
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for runtime state'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

function setup(t, { fetchImpl, config: overrides = {} } = {}) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const users = ['alpha', 'beta', 'gamma'].map(name => {
    const user = store.createUser({ username: `chat_${name}`, displayName: name, passwordHash: 'unused' });
    store.setUserApiKey(user.id, `sk-fake-chat-runtime-${name}-0123456789`);
    return user;
  });
  const calls = [];
  const controlledFetch = async (url, options) => {
    const call = { url, payload: JSON.parse(options.body), authorization: options.headers.authorization,
      beta: options.headers['OpenAI-Beta'], controller: null };
    calls.push(call);
    return new Response(new ReadableStream({ start(controller) {
      call.controller = controller;
      options.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  let projectOperations = 0;
  const forbidden = () => { projectOperations++; throw new Error('Plain chat may not use Docker or project directories'); };
  const config = { model: 'test-model', dataDir: '/this-chat-directory-must-never-exist', gatewayPort: 0, gatewayHost: '127.0.0.1', maxConcurrentRuns: 2, maxOutputTokens: 512, runTimeoutMs: 10000, ...overrides };
  const runtime = createRuntime({ store, config, fetchImpl: fetchImpl || controlledFetch, spawnImpl: forbidden, execFileImpl: forbidden });
  t.after(async () => { await runtime.close(); store.close(); assert.equal(projectOperations, 0); });
  function create(user = users[0], text = 'Hello') {
    const thread = store.createThread(null, user.id, 'Plain chat');
    const run = store.createRun(thread.id, user.id);
    store.appendMessage(thread.id, 'user', text);
    return { user, thread, run, project: null, text };
  }
  return { store, runtime, calls, users, create, config };
}

test('standard and Ultra chats leave output limits to the provider and account usage beyond 4096', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { model: 'gpt-6.1-sol', maxOutputTokens: undefined } });
  for (const chatMode of ['standard', 'ultra']) {
    const input = f.create(), index = f.calls.length;
    await f.runtime.start({ ...input, chatMode }); await until(() => f.calls[index]?.controller);
    const call = f.calls[index];
    assert.equal(Object.hasOwn(call.payload, 'max_output_tokens'), false);
    call.controller.enqueue(encode({ type: 'response.completed', response: {
      output: [agentMessage('answer', '/root', '完整答复')],
      usage: { input_tokens: 100, output_tokens: 8192, total_tokens: 8292 },
    } }));
    call.controller.close(); await until(() => f.store.getRun(input.run.id).status !== 'running');
    assert.equal(f.store.getRun(input.run.id).status, 'completed');
    assert.equal(f.store.getMessages(input.thread.id).at(-1).content, '完整答复');
  }
  assert.deepEqual(f.store.getUsage({ userId: f.users[0].id }).usage.map(row => row.outputTokens), [8192, 8192]);
});

test('disabling automatic titles recovers unfinished jobs without replaying provider calls', async t => {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const user = store.createUser({ username: 'title_recovery', displayName: 'title', passwordHash: 'unused' });
  store.setUserApiKey(user.id, 'sk-fake-title-recovery-0123456789');
  const thread = store.createThread(null, user.id), run = store.createRun(thread.id, user.id);
  store.appendMessage(thread.id, 'user', '优化导航'); store.appendMessage(thread.id, 'assistant', '建议精简入口');
  store.updateRun(run.id, { status: 'completed' });
  store.enqueueTitleJob({ runId: run.id, model: 'test-model' });
  assert.equal(store.getThread(thread.id).titlePending, true);
  const runtime = createRuntime({ store, config: { autoThreadTitles: false, model: 'test-model' },
    fetchImpl: async () => { throw new Error('must not replay a title request'); } });
  t.after(async () => { await runtime.close(); store.close(); });
  assert.equal(store.getTitleJob(run.id).status, 'skipped');
  assert.equal(store.getThread(thread.id).titlePending, undefined);
});

test('completed replies publish done before asynchronous title summaries and account title usage separately', { timeout: 10000 }, async t => {
  let resolveTitle, titleRequest;
  const f = setup(t, { config: { autoThreadTitles: true, maxOutputTokens: undefined }, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.stream === false) {
      titleRequest = { url, payload };
      return new Promise(resolve => { resolveTitle = resolve; });
    }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode(terminal('我们可以先改进导航和输入区域。'))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const input = f.create(f.users[0], '帮我优化网页界面'), events = [];
  f.store.updateRun(input.run.id, { requestMessageId: f.store.getMessages(input.thread.id)[0].id });
  f.runtime.subscribe(input.run.id, event => events.push(event));
  await f.runtime.start(input);
  await until(() => events.some(event => event.event === 'done') && resolveTitle);
  assert.equal(f.store.getRun(input.run.id).status, 'completed');
  assert.equal(f.store.getThread(input.thread.id).titlePending, true);
  assert.equal(Object.hasOwn(titleRequest.payload, 'max_output_tokens'), false);
  assert.equal(titleRequest.url, 'https://api.openai.com/v1/responses');
  resolveTitle(Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: '网页导航与输入区域优化' }] }],
    usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } }));
  await until(() => !f.store.getThread(input.thread.id).titlePending);
  assert.equal(f.store.getThread(input.thread.id).title, '网页导航与输入区域优化');
  const records = f.store.getUsage({ userId: input.user.id }).usage;
  assert.equal(records.find(row => row.source === 'thread_title').totalTokens, 40);
  assert.equal(f.store.getMessages(input.thread.id).filter(message => message.role === 'assistant').length, 1);
});

test('plain chat cancellation settles unknown usage once and retains streamed text without Docker', { timeout: 10000 }, async t => {
  const f = setup(t), input = f.create(), events = [];
  f.runtime.subscribe(input.run.id, event => events.push(event));
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  f.calls[0].controller.enqueue(encode({ type: 'response.output_text.delta', item_id: 'answer', delta: '保留这部分' }));
  await until(() => f.store.getRun(input.run.id).output === '保留这部分');
  await f.runtime.interrupt(input.run.id); await f.runtime.interrupt(input.run.id);
  assert.equal(f.store.getRun(input.run.id).status, 'interrupted');
  assert.equal(events.filter(event => event.event === 'done').length, 1);
  assert.equal(f.store.getMessages(input.thread.id).filter(message => message.role === 'assistant').length, 1);
  assert.equal(f.store.getMessages(input.thread.id).find(message => message.role === 'assistant').content, '保留这部分');
  const records = f.store.getUsage({ userId: input.user.id }).usage;
  assert.equal(records.length, 1); assert.equal(records[0].status, 'unknown'); assert.equal(records[0].totalTokens, null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM projects').get().n, 0);
});

test('Ultra delegates upstream and publishes only the root final answer, settling usage once', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { model: 'gpt-6.1-sol' } }), input = f.create();
  await f.runtime.start({ ...input, tool: 'auto', chatMode: 'ultra' });
  await until(() => f.calls[0]?.controller);
  const call = f.calls[0];
  assert.equal(call.beta, 'responses_multi_agent=v1');
  assert.equal(call.authorization, 'Bearer sk-fake-chat-runtime-alpha-0123456789');
  assert.deepEqual(call.payload.multi_agent, { enabled: true, max_concurrent_subagents: 3 });
  assert.deepEqual(call.payload.reasoning, { effort: 'max' });
  assert.deepEqual(call.payload.tools, []);
  assert.equal(call.payload.store, false);
  const spawn = { type: 'multi_agent_call', action: 'spawn_agent', call_id: 'spawn-1', arguments: 'private task prompt' };
  const spawnResult = { type: 'multi_agent_call_output', call_id: 'spawn-1',
    output: [{ type: 'output_text', text: JSON.stringify({ task_name: '/root/child' }) }] };
  const child = agentMessage('child', '/root/child', 'private child text');
  const commentary = agentMessage('commentary', '/root', 'private commentary', 'commentary');
  const answer = agentMessage('answer', '/root', '最终答复。');
  const push = event => call.controller.enqueue(encode(event));
  push({ type: 'response.output_item.added', item: spawn, output_index: 0 });
  push({ type: 'response.output_item.done', item: spawnResult, output_index: 1 });
  push({ type: 'response.output_item.added', item: child, output_index: 2 });
  push({ type: 'response.output_item.added', item: commentary, output_index: 3 });
  push({ type: 'response.output_text.delta', item_id: 'child', delta: 'private child text' });
  push({ type: 'response.output_text.delta', item_id: 'commentary', delta: 'private commentary' });
  push({ type: 'response.output_item.added', item: { ...answer, content: [] }, output_index: 4 });
  push({ type: 'response.output_text.delta', output_index: 4, delta: '最终' });
  await until(() => f.store.getRun(input.run.id).output === '最终');
  const completed = { type: 'response.completed', response: { output: [spawn, spawnResult, child, commentary, answer], usage } };
  push({ type: 'response.output_item.done', item: answer, output_index: 4 });
  push(completed);
  call.controller.close();
  await until(() => f.store.getRun(input.run.id).status !== 'running');
  assert.equal(f.store.getRun(input.run.id).status, 'completed');
  assert.deepEqual(f.store.getMessages(input.thread.id).map(message => message.content), [input.text, '最终答复。']);
  const events = f.store.getRunEvents(input.run.id, { after: 0, limit: 100 });
  assert.ok(events.some(event => event.tool === 'ultra' && event.summary === '已分派子代理'));
  assert.ok(events.some(event => event.tool === 'ultra' && event.summary === '主代理正在汇总结果'));
  assert.ok(!JSON.stringify(events).includes('private'));
  const records = f.store.getUsage({ userId: input.user.id }).usage;
  assert.deepEqual(records.map(record => [record.status, record.totalTokens]), [['completed', 15]]);

  const next = f.create(input.user, '普通 Max');
  await f.runtime.start({ ...next, tool: 'auto', reasoningEffort: 'max' });
  await until(() => f.calls[1]?.controller);
  assert.equal(f.calls[1].beta, undefined);
  assert.equal(f.calls[1].payload.multi_agent, undefined);
  assert.deepEqual(f.calls[1].payload.reasoning, { effort: 'max' });
  assert.ok(f.calls[1].payload.tools.some(tool => tool.type === 'web_search'));
  f.calls[1].controller.enqueue(encode(terminal('普通答复')));
  f.calls[1].controller.close();
  await until(() => f.store.getRun(next.run.id).status === 'completed');
});

test('stopping Ultra keeps the visible root answer and leaves missing usage unknown', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { model: 'gpt-6.1-sol' } }), input = f.create();
  await f.runtime.start({ ...input, chatMode: 'ultra' });
  await until(() => f.calls[0]?.controller);
  const { controller } = f.calls[0];
  controller.enqueue(encode({ type: 'response.output_item.added', item: agentMessage('answer', '/root', ''), output_index: 0 }));
  controller.enqueue(encode({ type: 'response.output_text.delta', item_id: 'answer', delta: '已收到的答案' }));
  await until(() => f.store.getRun(input.run.id).output === '已收到的答案');
  await f.runtime.interrupt(input.run.id);
  assert.equal(f.store.getRun(input.run.id).status, 'interrupted');
  assert.equal(f.store.getMessages(input.thread.id).find(message => message.role === 'assistant').content, '已收到的答案');
  assert.deepEqual(f.store.getUsage({ userId: input.user.id }).usage.map(record => [record.status, record.totalTokens]), [['unknown', null]]);
});

test('a rejected Ultra request keeps the question and does not silently retry', { timeout: 10000 }, async t => {
  let calls = 0;
  const f = setup(t, { config: { model: 'gpt-6.1-sol' }, fetchImpl: async () => {
    calls++;
    return Response.json({ error: { message: 'PRIVATE_PROVIDER_RESPONSE' } }, { status: 403 });
  } });
  const input = f.create();
  await f.runtime.start({ ...input, chatMode: 'ultra' });
  await until(() => f.store.getRun(input.run.id).status === 'failed');
  const run = f.store.getRun(input.run.id);
  assert.match(run.error, /Ultra.*Max/);
  assert.doesNotMatch(run.error, /PRIVATE_PROVIDER_RESPONSE/);
  assert.equal(f.store.getMessages(input.thread.id).find(message => message.role === 'user').content, input.text);
  assert.equal(calls, 1);
});

test('ordinary chats enforce user-one and global-two concurrency across chat and projects', { timeout: 10000 }, async t => {
  const f = setup(t), first = f.create(f.users[0]), second = f.create(f.users[1]);
  await f.runtime.start(first); await until(() => f.calls[0]?.controller);
  const anotherSameUser = f.create(f.users[0]);
  await assert.rejects(f.runtime.start(anotherSameUser), error => error.status === 409);
  f.store.updateRun(anotherSameUser.run.id, { status: 'failed' });
  const project = f.store.createProject(f.users[0].id, 'Only a DB fixture, no files');
  const thread = f.store.createThread(project.id, f.users[0].id);
  const projectRun = f.store.createRun(thread.id, f.users[0].id);
  await assert.rejects(f.runtime.start({ user: f.users[0], project, thread, run: projectRun, text: 'Do not run' }), error => error.status === 409);
  f.store.updateRun(projectRun.id, { status: 'failed' });
  await f.runtime.start(second); await until(() => f.calls[1]?.controller);
  const third = f.create(f.users[2]);
  await assert.rejects(f.runtime.start(third), error => error.status === 429);
  f.store.updateRun(third.run.id, { status: 'failed' });
  await Promise.all([f.runtime.interrupt(first.run.id), f.runtime.interrupt(second.run.id)]);
  assert.equal(f.calls.length, 2);
});

function primaryInput(f, user = f.users[0], text = '安排工作') {
  const input = f.create(user, text);
  f.store.db.prepare('INSERT INTO kibot_threads(user_id,thread_id) VALUES(?,?)').run(user.id, input.thread.id);
  input.thread = f.store.getThread(input.thread.id);
  const messageId = f.store.getMessages(input.thread.id).at(-1).id;
  f.store.updateRun(input.run.id, { requestMessageId: messageId });
  return input;
}
const taskTool = { type: 'function', name: 'kivo_list_work', description: 'Read owned work', strict: true,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const functionTurn = (id = 'call_1', name = taskTool.name) => ({ type: 'response.completed', response: { usage, output: [
  { type: 'reasoning', id: 'reasoning_1', summary: [], encrypted_content: 'opaque-provider-reasoning' },
  { type: 'function_call', id: 'fc_1', call_id: id, name, arguments: '{}' },
] } });

test('primary chat has bounded reserved capacity alongside workers, with one primary per user', { timeout: 10000 }, async t => {
  const f = setup(t);
  const workers = [f.create(f.users[0]), f.create(f.users[1])];
  await f.runtime.start(workers[0]); await f.runtime.start(workers[1]);
  const primary = primaryInput(f);
  await f.runtime.start(primary);
  const second = primaryInput(f, f.users[1]);
  await f.runtime.start(second);
  await until(() => f.calls.length === 4);
  const third = primaryInput(f, f.users[2]);
  await assert.rejects(f.runtime.start(third), error => error.status === 429);
  f.store.updateRun(third.run.id, { status: 'failed' });
  await f.runtime.interrupt(second.run.id);
  assert.throws(() => f.store.createRun(primary.thread.id, primary.user.id), error => error.status === 409);
  await assert.rejects(f.runtime.start({ ...primary, run: { ...primary.run, id: 'duplicate-primary' } }), error => error.status === 409);
  await Promise.all([...workers, primary].map(input => f.runtime.interrupt(input.run.id)));
});

test('primary tool round trip replays encrypted reasoning, scopes calls and accounts every model request', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { maxOutputTokens: undefined } }), input = primaryInput(f), executed = [];
  f.runtime.setPrimaryAssistant(context => {
    assert.equal(context.userId, input.user.id); assert.equal(context.messageId, f.store.getRun(input.run.id).requestMessageId);
    return { messages: f.store.getMessages(input.thread.id), instructions: 'Coordinate owned tasks.', tools: [taskTool],
      onToolCall: async call => { executed.push(call); return { tasks: [{ id: 'owned-task', status: 'queued' }] }; } };
  });
  await f.runtime.start({ ...input, tool: 'auto' });
  await until(() => f.calls[0]?.controller);
  assert.ok(f.calls[0].payload.tools.some(tool => tool.name === taskTool.name));
  assert.deepEqual(f.calls[0].payload.include, ['reasoning.encrypted_content']);
  assert.equal(f.calls[0].payload.parallel_tool_calls, false);
  f.calls[0].controller.enqueue(encode(functionTurn())); f.calls[0].controller.close();
  await until(() => f.calls[1]?.controller);
  assert.deepEqual(executed, [{ name: taskTool.name, arguments: '{}', callId: 'call_1' }]);
  assert.ok(f.calls[1].payload.input.some(item => item.encrypted_content === 'opaque-provider-reasoning'));
  assert.ok(f.calls[1].payload.input.some(item => item.type === 'function_call_output' && JSON.parse(item.output).tasks[0].id === 'owned-task'));
  f.calls[1].controller.enqueue(encode(terminal('工作已安排。'))); f.calls[1].controller.close();
  await until(() => f.store.getRun(input.run.id).status === 'completed');
  assert.equal(f.store.getRun(input.run.id).output, '工作已安排。');
  assert.equal(f.store.getUsage({ userId: input.user.id }).totals.totalTokens, 30);
  assert.equal(f.store.getUsage({ userId: input.user.id }).usage.length, 2);
  assert.ok(f.calls.every(call => !Object.hasOwn(call.payload, 'max_output_tokens')));
});

test('primary tools reject unknown or replayed calls before repeating any action', { timeout: 10000 }, async t => {
  const f = setup(t), input = primaryInput(f); let executed = 0;
  f.runtime.setPrimaryAssistant(() => ({ tools: [taskTool], onToolCall: async () => { executed++; return {}; } }));
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  f.calls[0].controller.enqueue(encode(functionTurn())); f.calls[0].controller.close();
  await until(() => f.calls[1]?.controller);
  f.calls[1].controller.enqueue(encode(functionTurn())); f.calls[1].controller.close();
  await until(() => f.store.getRun(input.run.id).status === 'failed');
  assert.equal(executed, 1); assert.equal(f.calls.length, 2);
  assert.match(f.store.getRun(input.run.id).error, /重复/);
});

test('Ultra primary keeps memory but never obtains application-tool capabilities', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { model: 'gpt-6.1-sol' } }), input = primaryInput(f);
  f.runtime.setPrimaryAssistant(() => ({ instructions: 'Primary memory is supplied.', tools: [taskTool], onToolCall: () => { throw new Error('must not execute'); } }));
  await f.runtime.start({ ...input, chatMode: 'ultra' }); await until(() => f.calls[0]?.controller);
  assert.deepEqual(f.calls[0].payload.tools, []);
  assert.match(f.calls[0].payload.instructions, /Primary memory is supplied/);
  assert.match(f.calls[0].payload.instructions, /Task-management tools are unavailable/);
  f.calls[0].controller.enqueue(encode({ type: 'response.completed', response: { usage, output: [agentMessage('answer', '/root', '分析完成')] } }));
  f.calls[0].controller.close(); await until(() => f.store.getRun(input.run.id).status === 'completed');
});

test('ordinary threads cannot impersonate kibot or obtain application tools', { timeout: 10000 }, async t => {
  const f = setup(t), input = f.create(); let factoryCalls = 0;
  f.runtime.setPrimaryAssistant(() => { factoryCalls++; return { tools: [taskTool], onToolCall: () => ({}) }; });
  await f.runtime.start({ ...input, thread: { ...input.thread, isPrimary: true } });
  await until(() => f.calls[0]?.controller);
  assert.equal(factoryCalls, 0);
  assert.ok(f.calls[0].payload.tools.every(tool => tool.type !== 'function'));
  f.calls[0].controller.enqueue(encode(terminal('普通聊天'))); f.calls[0].controller.close();
  await until(() => f.store.getRun(input.run.id).status === 'completed');
});

test('primary refuses an unknown tool and never executes a streamed call before completion', { timeout: 10000 }, async t => {
  const f = setup(t), input = primaryInput(f); let executed = 0;
  f.runtime.setPrimaryAssistant(() => ({ tools: [taskTool], onToolCall: async () => { executed++; return {}; } }));
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  f.calls[0].controller.enqueue(encode({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: taskTool.name, arguments: '{}' } }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(executed, 0);
  f.calls[0].controller.enqueue(encode(functionTurn('call_2', 'kivo_delete_everything'))); f.calls[0].controller.close();
  await until(() => f.store.getRun(input.run.id).status === 'failed');
  assert.equal(executed, 0); assert.equal(f.calls.length, 1);
});

test('ordinary chat rejects oversized complete history before starting provider calls', async t => {
  const f = setup(t), input = f.create();
  f.store.appendMessage(input.thread.id, 'assistant', 'x'.repeat(CHAT_MAX_BYTES));
  f.store.appendMessage(input.thread.id, 'user', 'Next');
  await assert.rejects(f.runtime.start({ ...input, text: 'Next' }), error => error.status === 409 && /过大|过长|超过/.test(error.message));
  assert.equal(f.calls.length, 0);
  f.store.updateRun(input.run.id, { status: 'failed' });
});

test('incomplete model response preserves terminal output and records returned usage', { timeout: 10000 }, async t => {
  const f = setup(t), input = f.create();
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  f.calls[0].controller.enqueue(encode(terminal('模型只完成了一部分', 'response.incomplete')));
  f.calls[0].controller.close();
  await until(() => f.store.getRun(input.run.id).status !== 'running');
  assert.equal(f.store.getRun(input.run.id).status, 'failed');
  assert.equal(f.store.getRun(input.run.id).output, '模型只完成了一部分');
  assert.equal(f.store.getUsage({ userId: input.user.id }).totals.totalTokens, 15);
});

test('provider errors and unknown streams fail clearly without leaking keys or reporting actual zero', { timeout: 10000 }, async t => {
  let calls = 0;
  const f = setup(t, { fetchImpl: async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { message: 'SECRET_PROVIDER_ERROR sk-DO_NOT_EXPOSE' } }, { status: 401 });
    return new Response(encode({ type: 'response.created', response: { id: 'partial' } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const first = f.create(); await f.runtime.start(first);
  await until(() => f.store.getRun(first.run.id).status !== 'running');
  const failed = f.store.getRun(first.run.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /个人设置/);
  assert.ok(!JSON.stringify(failed).includes('SECRET_PROVIDER_ERROR')); assert.ok(!JSON.stringify(failed).includes('sk-DO_NOT_EXPOSE'));
  const second = f.create(); await f.runtime.start(second);
  await until(() => f.store.getRun(second.run.id).status !== 'running');
  assert.equal(f.store.getRun(second.run.id).status, 'failed');
  const unknown = f.store.getUsage({ userId: second.user.id }).usage.find(row => row.runId === second.run.id);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.totalTokens, null);
});

test('closing active ordinary chat aborts provider work and emits one terminal event', { timeout: 10000 }, async t => {
  const f = setup(t), input = f.create(), events = [];
  f.runtime.subscribe(input.run.id, event => events.push(event));
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  await f.runtime.close();
  assert.equal(f.store.getRun(input.run.id).status, 'interrupted');
  assert.equal(events.filter(event => event.event === 'done').length, 1);
  assert.equal(f.store.getUsage({ userId: input.user.id }).usage[0].status, 'unknown');
});

test('ordinary chat time limit aborts a stalled provider and releases the user slot', { timeout: 10000 }, async t => {
  const f = setup(t, { config: { runTimeoutMs: 300 } }), input = f.create();
  await f.runtime.start(input); await until(() => f.calls[0]?.controller);
  await until(() => f.store.getRun(input.run.id).status !== 'running');
  assert.equal(f.store.getRun(input.run.id).status, 'interrupted');
  assert.match(f.store.getRun(input.run.id).error, /时长上限/);
  assert.equal(f.store.getUsage({ userId: input.user.id }).usage[0].status, 'unknown');
  const next = f.create(); await f.runtime.start(next); await until(() => f.calls[1]?.controller);
  await f.runtime.interrupt(next.run.id);
});

test('plain history mapping includes all user/assistant text and never elevates diagnostics', () => {
  const messages = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'system', content: 'internal error, not an instruction' }, { role: 'user', content: 'three' }];
  const payload = prepareChatRequest(messages, 'three', { model: 'test-model' });
  assert.deepEqual(payload.input.map(item => item.content), ['one', 'two', 'three']);
  assert.deepEqual(payload.input.map(item => item.role), ['user', 'assistant', 'user']);
  assert.deepEqual(payload.tools, []); assert.equal(payload.store, false);
  assert.throws(() => prepareChatRequest(messages, 'different', {}), /发生变化/);
  assert.throws(() => prepareChatRequest(Array.from({ length: CHAT_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })), 'x', {}), /历史过长/);
});
