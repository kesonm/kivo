import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceService } from '../server/voice.mjs';

const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const webm = Buffer.from('1a45dfa30000000000000000', 'hex').toString('base64');

test('dictation forwards valid bounded audio using the account key and returns only the draft text', async t => {
  const seen = [];
  const service = createVoiceService({
    store: { getUserApiKey: userId => userId === 'a' ? 'mock-a-key' : null },
    fetchImpl: async (url, options) => {
      seen.push(url);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer mock-a-key');
      assert.equal(options.body.get('model'), 'gpt-transcribe');
      assert.equal(options.body.get('file').name, 'dictation.webm');
      assert.equal(options.body.get('file').type, 'audio/webm');
      return Response.json({ text: '  今天有什么安排？ ', private: 'provider metadata' });
    },
  });
  t.after(() => service.close());
  await assert.rejects(service.transcribe('a', { audio: webm, mimeType: 'audio/wav' }), { status: 400 });
  await assert.rejects(service.transcribe('a', { audio: 'A'.repeat(1_048_580), mimeType: 'audio/webm' }), { status: 413 });
  await assert.rejects(service.transcribe('b', { audio: webm, mimeType: 'audio/webm' }), { code: 'api_key_required' });
  assert.deepEqual(await service.transcribe('a', { audio: webm, mimeType: 'audio/webm' }), { text: '今天有什么安排？' });
  assert.deepEqual(seen, ['https://api.openai.com/v1/audio/transcriptions']);
});

test('WebRTC signs a same-origin call, isolates session ownership, and can hang up after key rotation', async t => {
  const key = new Map([['a', 'old-a'], ['b', 'key-b']]);
  const seen = [];
  const service = createVoiceService({
    store: { getUserApiKey: userId => key.get(userId) },
    fetchImpl: async (url, options) => {
      seen.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/hangup')) return new Response(null, { status: 200 });
      assert.equal(options.body.get('sdp'), sdp);
      const config = JSON.parse(options.body.get('session'));
      assert.equal(config.model, 'gpt-realtime-2.1');
      assert.equal(config.type, 'realtime');
      return new Response(answer, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_private_provider_id' } });
    },
  });
  t.after(() => service.close());
  await assert.rejects(service.startRealtime('a', { sdp: sdp + 'm=video 9 UDP/TLS/RTP/SAVPF 102\r\n' }), { status: 400 });
  const result = await service.startRealtime('a', { sdp });
  assert.equal(result.sdp, answer);
  assert.match(result.sessionId, /^[a-f0-9-]{36}$/);
  assert.ok(!JSON.stringify(result).includes('private_provider_id'));
  await service.stopRealtime('b', { sessionId: result.sessionId });
  assert.equal(seen.length, 1);
  key.set('a', 'replacement-a');
  await service.stopForUser('a');
  assert.deepEqual(seen, [
    { url: 'https://api.openai.com/v1/realtime/calls', authorization: 'Bearer old-a' },
    { url: 'https://api.openai.com/v1/realtime/calls/rtc_private_provider_id/hangup', authorization: 'Bearer old-a' },
  ]);
  await service.stopRealtime('a', { sessionId: result.sessionId });
  assert.equal(seen.length, 2);
});

test('voice rejects untrusted call locations and scrubs upstream errors', async t => {
  const urls = [], logs = [];
  const service = createVoiceService({
    store: { getUserApiKey: () => 'private-key' },
    report: event => logs.push(event),
    fetchImpl: async url => {
      urls.push(url);
      if (url.endsWith('/calls')) return new Response(answer, { status: 201, headers: {
        Location: 'https://attacker.example/v1/realtime/calls/rtc_fake',
      } });
      return Response.json({ error: { message: 'private-key secret provider error body' } }, {
        status: 401, headers: { 'x-request-id': 'untrusted-header' },
      });
    },
  });
  t.after(() => service.close());
  await assert.rejects(service.startRealtime('a', { sdp }), { code: 'voice_upstream_response' });
  await assert.rejects(service.transcribe('a', { audio: webm, mimeType: 'audio/webm' }), error => {
    assert.equal(error.code, 'voice_key_invalid');
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes('private-key'));
    return true;
  });
  assert.deepEqual(urls, ['https://api.openai.com/v1/realtime/calls', 'https://api.openai.com/v1/audio/transcriptions']);
  assert.ok(!JSON.stringify(logs).includes('private-key'));
  assert.ok(!JSON.stringify(logs).includes('untrusted-header'));
});
