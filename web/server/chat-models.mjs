const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const reasoningLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
const builtins = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: '适合日常聊天和复杂任务', efforts: reasoningLevels },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '适合快速处理简单任务', efforts: ['none', ...reasoningLevels] },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: '适合复杂推理和深入分析', efforts: reasoningLevels },
];
const availableModels = [...builtins, { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: '', efforts: ['none', ...reasoningLevels] }];
const knownEfforts = new Map(availableModels.map(option => [option.id, option.efforts]));
const maxModels = 24;
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

class ChatModelError extends Error {
  constructor(message, code = 'chat_catalog_invalid') {
    super(message);
    this.status = 400;
    this.code = code;
  }
}

export function defaultChatModelCatalog(defaultModel) {
  const preferred = builtins.find(option => option.id === defaultModel)
    ?? { id: defaultModel, label: defaultModel, description: '服务器默认模型', efforts: knownEfforts.get(defaultModel) ?? [] };
  return {
    defaultModel,
    models: [preferred, ...builtins.filter(option => option.id !== defaultModel)].map(option => ({
      ...option, enabled: true, defaultEffort: option.efforts.length ? 'medium' : null,
    })),
  };
}

export function validateChatModelCatalog({ models, defaultModel }) {
  if (!Array.isArray(models) || !models.length || models.length > maxModels) throw new ChatModelError(`模型列表须有 1 至 ${maxModels} 个模型`);
  const ids = new Set();
  const validated = models.map(option => {
    const { id, label, description, enabled, efforts, defaultEffort } = option ?? {};
    if (typeof id !== 'string' || !modelId.test(id) || ids.has(id)) throw new ChatModelError('模型 ID 无效或重复');
    ids.add(id);
    if (typeof label !== 'string' || !label.trim() || label.length > 60) throw new ChatModelError('模型显示名称须有 1 至 60 个字符');
    if (typeof description !== 'string' || description.length > 160 || typeof enabled !== 'boolean') {
      throw new ChatModelError('模型描述或启用状态无效');
    }
    const allowed = knownEfforts.get(id) ?? effortLevels;
    if (!Array.isArray(efforts) || efforts.length > allowed.length || new Set(efforts).size !== efforts.length
        || efforts.some(effort => !allowed.includes(effort))) {
      throw new ChatModelError(`${id} 包含不支持的思考档位`);
    }
    if (efforts.length ? !efforts.includes(defaultEffort) : defaultEffort !== null) {
      throw new ChatModelError(`${id} 的默认档位必须在已选档位中`);
    }
    return {
      id, label: label.trim(), description: description.trim(), enabled,
      efforts: effortLevels.filter(effort => efforts.includes(effort)), defaultEffort,
    };
  });
  if (!validated.some(option => option.id === defaultModel && option.enabled)) {
    throw new ChatModelError('请选择一个已启用的默认模型');
  }
  return { defaultModel, models: validated };
}

export function adminChatModelCatalog(catalog) {
  const configuredIds = new Set(catalog.models.map(option => option.id));
  // Make new options visible without changing the chat menu until an admin enables them.
  const available = availableModels.filter(option => !configuredIds.has(option.id))
    .slice(0, maxModels - catalog.models.length).map(option => ({ ...option, enabled: false, defaultEffort: 'medium' }));
  return { ...catalog, models: [...catalog.models, ...available], knownEfforts: Object.fromEntries(knownEfforts) };
}

export function chatModelOptions(catalog) {
  return catalog.models.filter(option => option.enabled).map(({ enabled, ...option }) => option);
}

export function resolveChatSelection(catalog, model, reasoningEffort) {
  const selected = catalog.models.find(option => option.id === (model === undefined ? catalog.defaultModel : model) && option.enabled);
  if (!selected) throw new ChatModelError('所选聊天模型不可用，请重新选择模型', 'chat_model_invalid');
  if (reasoningEffort !== undefined && !selected.efforts.includes(reasoningEffort)) {
    throw new ChatModelError('此模型不支持所选思考档位，请重新选择', 'chat_reasoning_invalid');
  }
  return { model: selected.id, reasoningEffort: reasoningEffort ?? selected.defaultEffort ?? undefined };
}
