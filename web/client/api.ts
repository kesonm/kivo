let csrfToken = '';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  const multipart = options.body instanceof FormData ? options.body : undefined;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!multipart && (options.body !== undefined || mutation)) headers['Content-Type'] = 'application/json';
  if (mutation) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', signal: options.signal,
    body: multipart ?? (options.body === undefined ? mutation ? '{}' : undefined : JSON.stringify(options.body)),
  });
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new ApiError(`服务暂时不可用（${response.status}），请稍后重试。`, response.status); }
  if (typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  if (!response.ok) {
    if (response.status === 401 && !['/api/auth/login', '/api/auth/register'].includes(path)) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(typeof data.error === 'string' ? data.error : '请求未成功，请重试。', response.status,
      typeof data.code === 'string' ? data.code : undefined, data.details);
  }
  return data as T;
}

export const messageOf = (error: unknown) => error instanceof Error ? error.message : '发生了未知错误，请重试。';
export const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value || 0);
export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
export const dateTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const fullDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN');
};
export const enc = encodeURIComponent;
