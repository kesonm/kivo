function spawnedAgent(item) {
  for (const part of Array.isArray(item.output) ? item.output : []) {
    if (part?.type !== 'output_text' || typeof part.text !== 'string' || part.text.length > 4096) continue;
    try {
      const name = JSON.parse(part.text)?.task_name;
      if (typeof name === 'string' && /^\/root(?:\/[\w-]+)+$/.test(name)) return true;
    } catch { /* The provider did not confirm a child agent. */ }
  }
  return false;
}

// Beta streams interleave agents. Only output positively identified as the
// root's final answer can reach the conversation transcript.
export function createUltraOutput({ onText, onActivity }) {
  const rootItems = new Set(), itemsByIndex = new Map(), parts = new Map(), activities = new Map();
  let received = false, delegated = false;

  function activity(key, status, summary) {
    const previous = activities.get(key);
    if (previous && (previous.status !== 'started' || status === 'started')) return;
    if (!previous && activities.size >= 128) return;
    const itemId = previous?.itemId ?? `ultra-${activities.size + 1}`;
    const event = { kind: 'tool', source: 'hosted', tool: 'ultra', status, summary, itemId };
    activities.set(key, event);
    onActivity?.(event);
  }

  function write(text, id, index, delta = false) {
    if (typeof text !== 'string' || !text) return;
    const key = JSON.stringify([id, index]);
    const sent = parts.get(key) ?? '';
    const addition = delta ? text : text.startsWith(sent) ? text.slice(sent.length) : '';
    if (!addition) return;
    parts.set(key, sent + addition);
    activity('answer', 'started', delegated ? '主代理正在汇总结果' : '主代理正在生成答复');
    received = true;
    onText(addition, id);
  }

  function itemEvent(item, index, agent, done) {
    if (!item) return;
    const call = item.call_id;
    if (typeof call === 'string' && call.length && call.length <= 200) {
      const key = `spawn:${call}`;
      if (item.type === 'multi_agent_call' && item.action === 'spawn_agent') activity(key, 'started', '正在分派子代理');
      if (done && item.type === 'multi_agent_call_output' && activities.has(key)) {
        const spawned = spawnedAgent(item);
        if (spawned) delegated = true;
        activity(key, spawned ? 'succeeded' : 'unknown', spawned ? '已分派子代理' : '未确认子代理已分派');
      }
    }
    if (!done && Number.isInteger(index)) itemsByIndex.delete(index);
    if ((agent && agent !== '/root') || (item.agent?.agent_name ?? agent) !== '/root'
        || item.type !== 'message' || item.role !== 'assistant' || item.phase !== 'final_answer'
        || typeof item.id !== 'string' || !item.id) return;
    rootItems.add(item.id);
    if (Number.isInteger(index)) itemsByIndex.set(index, item.id);
    if (!done) return;
    for (const [partIndex, part] of (Array.isArray(item.content) ? item.content : []).entries()) {
      const text = part?.type === 'output_text' ? part.text : part?.type === 'refusal' ? part.refusal : '';
      write(text, item.id, partIndex);
    }
  }

  return {
    get received() { return received; },
    event(event) {
      const agent = event.agent?.agent_name;
      const type = event.type;
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        itemEvent(event.item, event.output_index, agent, type.endsWith('.done'));
      } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
        for (const [index, item] of (event.response?.output ?? []).entries()) itemEvent(item, index, undefined, true);
      } else if (['response.output_text.delta', 'response.refusal.delta', 'response.output_text.done', 'response.refusal.done'].includes(type)) {
        const id = event.item_id ?? itemsByIndex.get(event.output_index);
        if ((agent && agent !== '/root') || !rootItems.has(id)) return;
        const delta = type.endsWith('.delta');
        write(delta ? event.delta : event.text ?? event.refusal, id, event.content_index ?? 0, delta);
      }
    },
    finish(completed) {
      if (completed && received) activity('answer', 'succeeded', '主代理已完成答复');
      for (const [key, event] of activities) {
        if (event.status === 'started') activity(key, 'unknown', event.summary);
      }
    },
  };
}
