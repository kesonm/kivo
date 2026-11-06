// Run only in a disposable server-side QA container. No production data or real keys.
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const config = { dataDir: '/tmp/chat-browser-qa', hostDataDir: '/tmp/chat-browser-qa', distDir: '/app/dist', publicOrigin: 'http://127.0.0.1:18301', cookieSecure: false, model: 'qa-simulated-model', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 2, maxOutputTokens: 512, runTimeoutMs: 60000 };
const runtime = createRuntime({ store, config, spawnImpl() { throw new Error('QA ordinary chat cannot start a runner'); }, execFileImpl() { throw new Error('QA ordinary chat cannot invoke Docker'); },
  fetchImpl: async (_url, request) => {
    const input = JSON.parse(request.body).input;
    const users = input.filter(item => item.role === 'user');
    const answer = `这是服务器验收的模拟回复，未调用真实模型。\n\n当前对话包含 ${users.length} 条用户消息。${users.length > 1 ? '我仍然能看到你的第一条消息：' + (typeof users[0].content === 'string' ? users[0].content : users[0].content.map(part => part.text || '').join('')) : '可以继续发送消息，检查上下文与流式输出。'}`;
    const encoder = new TextEncoder(); let timer, stopped = false;
    return new Response(new ReadableStream({ start(controller) {
      const emit = event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const pieces = answer.match(/.{1,8}|\n/g) || [];
      timer = setInterval(() => {
        if (stopped) return;
        if (pieces.length) emit({ type: 'response.output_text.delta', item_id: 'qa-answer', delta: pieces.shift() });
        else { clearInterval(timer); stopped = true; emit({ type: 'response.completed', response: { status: 'completed', output: [{ id: 'qa-answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 } } }); controller.close(); }
      }, 350);
      request.signal.addEventListener('abort', () => { clearInterval(timer); if (!stopped) { stopped = true; controller.error(new DOMException('Aborted', 'AbortError')); } }, { once: true });
    }, cancel() { clearInterval(timer); stopped = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  },
});
const app = createApp({ store, runtime, config });
const server = app.listen(3000, '0.0.0.0', () => console.log('Disposable chat QA ready; simulated upstream only.'));
process.once('SIGTERM', async () => { server.close(); await runtime.close(); store.close(); process.exit(0); });
