const options = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: '适合日常聊天和复杂任务' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '适合快速处理简单任务' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: '适合复杂推理和深入分析' },
];

export function chatModelOptions(defaultModel) {
  const preferred = options.find(option => option.id === defaultModel);
  return [
    preferred ?? { id: defaultModel, label: defaultModel, description: '服务器默认模型' },
    ...options.filter(option => option.id !== defaultModel),
  ];
}

export function isChatModel(model, defaultModel) {
  return typeof model === 'string' && (model === defaultModel || options.some(option => option.id === model));
}
