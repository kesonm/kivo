import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, messageOf } from './api';
import { Icon } from './icons';
import type { AdminChatModel, AdminChatModelCatalog, OpenAiModelList } from './types';
import { ErrorBox, Loading, useNotice } from './ui';

export function AdminModels({ onSaved }: { onSaved: () => void }) {
  const [catalog, setCatalog] = useState<AdminChatModelCatalog>();
  const [models, setModels] = useState<AdminChatModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [available, setAvailable] = useState<OpenAiModelList>();
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [discovering, setDiscovering] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [query, setQuery] = useState('');
  const notify = useNotice();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<AdminChatModelCatalog>('/api/admin/models', { signal });
      setCatalog(result);
      setModels(result.models);
    } catch (e) {
      if (!signal?.aborted) setError(e);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setDiscovering(true);
    setDiscoveryError('');
    void api<OpenAiModelList>('/api/admin/models/available', { signal })
      .then(result => { if (!signal.aborted) setAvailable(result); })
      .catch(e => { if (!signal.aborted) setDiscoveryError(messageOf(e)); })
      .finally(() => { if (!signal.aborted) setDiscovering(false); });
    return () => controller.abort();
  }, [discoveryAttempt]);

  function setEnabled(model: AdminChatModel, enabled: boolean) {
    setModels(current => enabled
      ? [...current.filter(option => option.id !== model.id), { ...model, enabled: true }]
      : current.map(option => option.id === model.id ? { ...option, enabled: false } : option));
  }

  function moveModel(id: string, direction: -1 | 1) {
    setModels(current => {
      const ordered = current.filter(model => model.enabled);
      const index = ordered.findIndex(model => model.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return [...ordered, ...current.filter(model => !model.enabled)];
    });
  }

  const enabled = models.filter(model => model.enabled);
  const firstEnabled = enabled[0]?.id;
  const savedEnabled = catalog?.models.filter(model => model.enabled) ?? [];
  const changed = savedEnabled.length !== enabled.length || savedEnabled.some((model, index) => model.id !== enabled[index]?.id);
  const defaultModel = changed ? firstEnabled : catalog?.defaultModel;
  const conflict = error instanceof ApiError && error.code === 'chat_catalog_conflict';
  const search = query.trim().toLowerCase();
  const draftIds = new Set(models.map(model => model.id));
  const availableIds = available && !discoveryError && new Set([...available.models.map(model => model.id), ...available.otherModels]);
  const candidates = [...models.filter(model => !model.enabled), ...(available?.models.filter(model => !draftIds.has(model.id)) ?? [])]
    .filter(model => `${model.label} ${model.id}`.toLowerCase().includes(search));
  const otherModels = available?.otherModels.filter(id => !draftIds.has(id) && id.toLowerCase().includes(search)) ?? [];

  async function save() {
    if (!catalog || saving || !changed || !firstEnabled || conflict) return;
    setError(null);
    setSaving(true);
    try {
      const savedIds = new Set(catalog.models.map(model => model.id));
      const configured = models.filter(model => model.enabled || savedIds.has(model.id));
      const result = await api<AdminChatModelCatalog>('/api/admin/models', {
        method: 'PUT', body: { models: configured, defaultModel: firstEnabled, revision: catalog.revision },
      });
      setCatalog(result);
      setModels(result.models);
      onSaved();
      notify('聊天模型设置已保存', 'success');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  function modelRow(model: AdminChatModel, index?: number) {
    return <li className="admin-model-row" key={model.id}>
      <label className="admin-model-label">
        <input type="checkbox" checked={model.enabled} disabled={saving}
          onChange={event => setEnabled(model, event.currentTarget.checked)} />
        <span className="admin-model-name">
          <strong>{model.label}</strong>
          {model.label !== model.id && <code>{model.id}</code>}
          {model.id === defaultModel && <span className="admin-model-default">默认</span>}
          {availableIds && !availableIds.has(model.id) && <span className="admin-model-default">此 Key 未列出</span>}
        </span>
      </label>
      {index !== undefined && <div className="admin-model-order">
        <button type="button" className="icon-button" aria-label={`上移 ${model.label}`} title="上移"
          disabled={saving || index === 0} onClick={() => moveModel(model.id, -1)}><Icon name="up" size={16} /></button>
        <button type="button" className="icon-button" aria-label={`下移 ${model.label}`} title="下移"
          disabled={saving || index === enabled.length - 1} onClick={() => moveModel(model.id, 1)}><Icon name="down" size={16} /></button>
      </div>}
    </li>;
  }

  if (loading) return <Loading label="正在加载模型列表…" />;
  return <div className="admin-models">
    {error != null && <ErrorBox error={messageOf(error)} onRetry={!catalog || conflict ? () => void load() : undefined} />}
    {catalog && <div className="admin-model-columns">
      <section className="admin-model-group" aria-labelledby="admin-enabled-models">
        <div className="admin-model-tools"><h3 id="admin-enabled-models">聊天菜单</h3></div>
        {enabled.length > 0 && <ol className="admin-model-list admin-model-scroll" role="list" aria-label="已勾选的聊天模型">
          {enabled.map(modelRow)}
        </ol>}
        <div className="admin-model-save">
          <span className="muted small" role="status">{enabled.length ? `已勾选 ${enabled.length} 个模型` : '请至少勾选一个模型'}</span>
          <button type="button" className="button primary" disabled={!changed || saving || !firstEnabled || conflict}
            onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button>
        </div>
      </section>
      <section className="admin-model-group" aria-labelledby="admin-available-models">
        <div className="admin-model-tools">
          <h3 id="admin-available-models">可用模型</h3>
          <button type="button" className="button secondary" disabled={discovering} onClick={() => setDiscoveryAttempt(attempt => attempt + 1)}>
            <Icon name="refresh" size={15} />刷新 OpenAI 模型
          </button>
        </div>
        <input className="admin-model-search" type="search" aria-label="搜索可用模型" placeholder="搜索模型，例如 5.6"
          value={query} onChange={event => setQuery(event.currentTarget.value)} />
        {discoveryError && <ErrorBox error={discoveryError} />}
        {(!discoveryError || discovering) && <p className="muted small admin-model-note" role="status">
          {discovering ? '正在通过你的 OpenAI Key 加载模型…' : available &&
            `你的 OpenAI Key 列出了 ${available.models.length + available.otherModels.length} 个模型。聊天调用使用每位用户自己的 Key。`}
        </p>}
        {candidates.length > 0 || otherModels.length > 0 ? <ul className="admin-model-list admin-model-scroll" role="list" aria-label="可用模型">
          {candidates.map(model => modelRow(model))}
          {otherModels.map(id => <li key={id} className="admin-model-row admin-model-other">
            <code>{id}</code><span className="admin-model-default">未列为聊天模型</span>
          </li>)}
        </ul> : !discovering && !discoveryError && <p className="muted small admin-model-note">
          {search ? '没有匹配的可用模型。' : '没有更多可用模型。'}
        </p>}
      </section>
    </div>}
  </div>;
}
