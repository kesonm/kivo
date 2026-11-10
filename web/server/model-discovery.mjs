import { isChatModelId } from './chat-models.mjs';
import { AppError } from './store.mjs';

const modelListUrl = 'https://api.openai.com/v1/models';
const maxListBytes = 1024 * 1024;
const reasoning = ['none', 'low', 'medium', 'high', 'xhigh'];
const extendedReasoning = [...reasoning, 'max'];
const reasoningPresets = new Map([
  ['gpt-5.4', [reasoning, 'none']],
  ['gpt-5.4-mini', [reasoning, 'none']],
  ['gpt-5.4-nano', [reasoning, 'none']],
  ['gpt-5.4-pro', [['medium', 'high', 'xhigh'], 'medium']],
  ['gpt-5.5', [reasoning, 'medium']],
  ['gpt-5.5-pro', [['medium', 'high', 'xhigh'], 'high']],
  ['gpt-5.6', [extendedReasoning, 'medium']],
  ['gpt-5.6-sol', [extendedReasoning, 'medium']],
  ['gpt-5.6-terra', [extendedReasoning, 'medium']],
  ['gpt-5.6-luna', [extendedReasoning, 'medium']],
  ['gpt-6.1-terra', [extendedReasoning, 'medium']],
]);

// List Models returns IDs, so treat text families as candidates and keep specialist IDs visible separately.
function isChatCandidate(id) {
  const base = id.startsWith('ft:') ? id.split(':', 2)[1] : id;
  if (base === 'chat-latest' || base === 'chatgpt-4o-latest') return true;
  return /^(?:gpt-\d|o\d)/.test(base)
    && !/-(?:audio|realtime|transcribe|tts|image|instruct|vision-preview|search)(?:-|$)/.test(base);
}

async function readModelIds(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxListBytes) throw new Error('OpenAI model list exceeds the response limit');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(payload?.data)) throw new Error('OpenAI model list has an invalid shape');
  const ids = new Set(payload.data.map(model => model?.id).filter(isChatModelId));
  return [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export async function discoverOpenAiModels(key, { fetchImpl = globalThis.fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(10_000);
  let response;
  try {
    response = await fetchImpl(modelListUrl, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new AppError('暂时无法连接 OpenAI 模型列表，请重试。', 502, 'model_list_unavailable');
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new AppError('OpenAI API Key 无效，请在账户设置中更新后重试。', 502, 'model_list_key_invalid');
    if (response.status === 403) throw new AppError('此 OpenAI API Key 没有读取模型列表的权限，请检查项目权限。', 502, 'model_list_forbidden');
    if (response.status === 429) throw new AppError('OpenAI 模型列表请求过于频繁，请稍后重试。', 429, 'model_list_rate_limit');
    throw new AppError('暂时无法加载 OpenAI 模型列表，请重试。', 502, 'model_list_unavailable');
  }

  let ids;
  try { ids = await readModelIds(response); }
  catch { throw new AppError('无法读取 OpenAI 返回的模型列表，请重试。', 502, 'model_list_invalid'); }

  const models = [];
  const otherModels = [];
  for (const id of ids) {
    if (!isChatCandidate(id)) {
      otherModels.push(id);
      continue;
    }
    const alias = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const [efforts, defaultEffort] = reasoningPresets.get(alias) ?? [[], null];
    models.push({ id, label: id.slice(0, 60), description: '', enabled: false, efforts, defaultEffort });
  }
  return { models, otherModels };
}
