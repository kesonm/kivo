import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, messageOf } from './api';
import { Icon } from './icons';
import type { AdminChatModel, AdminChatModelCatalog } from './types';
import { ErrorBox, Loading, useNotice } from './ui';

export function AdminModels({ onSaved }: { onSaved: () => void }) {
  const [catalog, setCatalog] = useState<AdminChatModelCatalog>();
  const [models, setModels] = useState<AdminChatModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
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

  function setEnabled(id: string, enabled: boolean) {
    setModels(current => current.map(model => model.id === id ? { ...model, enabled } : model));
  }

  function moveModel(id: string, direction: -1 | 1) {
    setModels(current => {
      const index = current.findIndex(model => model.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const enabled = models.filter(model => model.enabled);
  const firstEnabled = enabled[0]?.id;
  const changed = catalog?.models.some((model, index) => model.id !== models[index]?.id || model.enabled !== models[index]?.enabled);
  const defaultModel = changed ? firstEnabled : catalog?.defaultModel;
  const conflict = error instanceof ApiError && error.code === 'chat_catalog_conflict';

  async function save() {
    if (!catalog || saving || !changed || !firstEnabled || conflict) return;
    setError(null);
    setSaving(true);
    try {
      const result = await api<AdminChatModelCatalog>('/api/admin/models', {
        method: 'PUT', body: { models, defaultModel: firstEnabled, revision: catalog.revision },
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

  if (loading) return <Loading label="正在加载模型列表…" />;
  return <div className="admin-models">
    {error != null && <ErrorBox error={messageOf(error)} onRetry={!catalog || conflict ? () => void load() : undefined} />}
    {catalog && <>
      <ol className="admin-model-list" role="list" aria-label="可用聊天模型">
        {models.map((model, index) => <li className="admin-model-row" key={model.id}>
          <label className="admin-model-label">
            <input type="checkbox" checked={model.enabled} disabled={saving}
              onChange={event => setEnabled(model.id, event.currentTarget.checked)} />
            <span className="admin-model-name">
              <strong>{model.label}</strong>
              {model.label !== model.id && <code>{model.id}</code>}
              {model.id === defaultModel && <span className="admin-model-default">默认</span>}
            </span>
          </label>
          <div className="admin-model-order">
            <button type="button" className="icon-button" aria-label={`上移 ${model.label}`} title="上移"
              disabled={saving || index === 0} onClick={() => moveModel(model.id, -1)}><Icon name="up" size={16} /></button>
            <button type="button" className="icon-button" aria-label={`下移 ${model.label}`} title="下移"
              disabled={saving || index === models.length - 1} onClick={() => moveModel(model.id, 1)}><Icon name="down" size={16} /></button>
          </div>
        </li>)}
      </ol>
      <div className="admin-model-save">
        <span className="muted small" role="status">{enabled.length ? `已勾选 ${enabled.length} 个模型` : '请至少勾选一个模型'}</span>
        <button type="button" className="button primary" disabled={!changed || saving || !firstEnabled || conflict}
          onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button>
      </div>
    </>}
  </div>;
}
