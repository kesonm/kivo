import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, messageOf } from './api';
import { Icon } from './icons';
import { effortLabels, effortOptions } from './reasoning';
import type { AdminChatModel, AdminChatModelCatalog, ReasoningEffort } from './types';
import { ErrorBox, Loading, useNotice } from './ui';

function modelEffortLimits(catalog: AdminChatModelCatalog, id: string) {
  return Object.hasOwn(catalog.knownEfforts, id) ? catalog.knownEfforts[id] : undefined;
}

export function AdminModels({ onSaved }: { onSaved: () => void }) {
  const [catalog, setCatalog] = useState<AdminChatModelCatalog>();
  const [draft, setDraft] = useState<AdminChatModelCatalog>();
  const [newModelId, setNewModelId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const notify = useNotice();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const result = await api<AdminChatModelCatalog>('/api/admin/models', { signal });
      setCatalog(result);
      setDraft(result);
    } catch (e) {
      if (!signal?.aborted) setError(messageOf(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function updateModel(id: string, patch: Partial<AdminChatModel>) {
    setDraft(current => current && { ...current, models: current.models.map(model => model.id === id ? { ...model, ...patch } : model) });
  }

  function setEffort(model: AdminChatModel, effort: ReasoningEffort, enabled: boolean) {
    const efforts = effortOptions.filter(option => option === effort ? enabled : model.efforts.includes(option));
    const defaultEffort = model.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort
      : efforts.includes('medium') ? 'medium' : efforts[0] ?? null;
    updateModel(model.id, { efforts, defaultEffort });
  }

  function addModel() {
    if (!draft || saving) return;
    const id = newModelId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id) || draft.models.some(model => model.id === id)) {
      setError('请输入有效且未重复的 OpenAI 模型 ID');
      return;
    }
    if (draft.models.length >= 24) return;
    setError('');
    const efforts = modelEffortLimits(draft, id) ?? [];
    setDraft({ ...draft, models: [...draft.models, { id, label: id.slice(0, 60), description: '', enabled: true,
      efforts, defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? null }] });
    setNewModelId('');
  }

  const changed = JSON.stringify(draft) !== JSON.stringify(catalog);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving || !changed) return;
    setError('');
    setSaving(true);
    try {
      const { models, defaultModel, revision } = draft;
      const result = await api<AdminChatModelCatalog>('/api/admin/models', { method: 'PUT', body: { models, defaultModel, revision } });
      setCatalog(result);
      setDraft(result);
      onSaved();
      notify('聊天模型设置已保存', 'success');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading label="正在加载模型列表…" />;
  return <form className="admin-models" onSubmit={save}>
    {error && <ErrorBox error={error} onRetry={!draft ? () => void load() : undefined} />}
    {draft && <>
      {draft.models.map(model => {
        const isDefault = draft.defaultModel === model.id;
        const limits = modelEffortLimits(draft, model.id);
        const allowedEfforts = limits ?? effortOptions;
        return <fieldset className="admin-model-row" key={model.id} disabled={saving}>
          <legend className="admin-model-id"><code>{model.id}</code></legend>
          <div className="admin-model-main">
            <label>显示名称<input value={model.label} maxLength={60} required onChange={event => updateModel(model.id, { label: event.target.value })} /></label>
            <label>说明<input value={model.description} maxLength={160} onChange={event => updateModel(model.id, { description: event.target.value })} /></label>
          </div>
          <div className="admin-model-reasoning">
            <div role="group" aria-label={`${model.id} 可选思考档位`} className="admin-effort-options">
              <span>可选思考档位</span>
              {allowedEfforts.map(effort => <label key={effort}>
                <input type="checkbox" checked={model.efforts.includes(effort)} onChange={event => setEffort(model, effort, event.target.checked)} />
                {effortLabels[effort]}
              </label>)}
            </div>
            <label className="admin-effort-default">默认档位
              <select value={model.defaultEffort ?? ''} disabled={!model.efforts.length}
                onChange={event => updateModel(model.id, { defaultEffort: event.target.value as ReasoningEffort })}>
                {model.efforts.length ? model.efforts.map(effort => <option value={effort} key={effort}>{effortLabels[effort]}</option>)
                  : <option value="">由模型决定</option>}
              </select>
            </label>
          </div>
          <div className="admin-model-actions">
            <label title={isDefault ? '先将另一模型设为默认' : undefined}>
              <input type="checkbox" checked={model.enabled} disabled={isDefault} onChange={event => updateModel(model.id, { enabled: event.target.checked })} />
              对聊天用户启用
            </label>
            <label><input type="radio" name="default-chat-model" checked={isDefault} disabled={!model.enabled}
              onChange={() => setDraft({ ...draft, defaultModel: model.id })} />设为默认模型</label>
            {!limits && !isDefault && <button type="button" className="text-button" onClick={() =>
              setDraft({ ...draft, models: draft.models.filter(option => option.id !== model.id) })}>移除</button>}
          </div>
        </fieldset>;
      })}
      <div className="admin-model-add">
        <label>添加 OpenAI 模型<input value={newModelId} maxLength={128} placeholder="模型 ID，例如 gpt-6-sol" disabled={saving}
          onChange={event => setNewModelId(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); addModel(); }
          }} /></label>
        <button type="button" className="button secondary" onClick={addModel}
          disabled={!newModelId.trim() || saving || draft.models.length >= 24}><Icon name="plus" size={16} />添加模型</button>
      </div>
      <p className="muted small">自定义模型请使用 OpenAI 的模型 ID，并按该模型支持的档位勾选。</p>
      <div className="admin-model-save">
        <button type="button" className="button secondary" disabled={saving} onClick={() => void load()}>重新加载</button>
        <button type="submit" className="button primary" disabled={!changed || saving}>{saving ? '正在保存…' : '保存模型设置'}</button>
      </div>
    </>}
  </form>;
}
