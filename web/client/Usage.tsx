import { dateTime, number } from './api';
import { Empty, StatusBadge } from './ui';
import type { Usage } from './types';

export function Pagination({ total, offset, limit, loading = false, onChange }: { total: number; offset: number; limit: number; loading?: boolean; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  return <div className="pagination"><span>第 {number(offset + 1)}–{number(Math.min(offset + limit, total))} 条，共 {number(total)} 条</span><div className="row"><button className="button small-button secondary" disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>上一页</button><button className="button small-button secondary" disabled={loading || offset + limit >= total} onClick={() => onChange(offset + limit)}>下一页</button></div></div>;
}
export function UsageTable({ usage, showUser = false }: { usage: Usage[]; showUser?: boolean }) {
  const displayTokens = (value: number | null) => value == null ? '未知' : number(value);
  if (!usage.length) return <Empty icon="activity" title="还没有模型用量" description="通过本站调用模型后，将在这里显示服务方返回的用量记录。" />;
  return <><div className="table-scroll"><table><thead><tr><th>调用时间</th>{showUser && <th>用户</th>}<th>密钥尾号</th><th>模型</th><th className="numeric">输入 tokens</th><th className="numeric">输出 tokens</th><th className="numeric">合计</th><th>记录状态</th></tr></thead><tbody>{usage.map(entry => <tr key={entry.id}><td className="nowrap muted">{dateTime(entry.createdAt)}</td>{showUser && <td>{entry.displayName || entry.username || entry.userId || '—'}</td>}<td><code className="inline-code">{entry.keyLast4 ? `••••${entry.keyLast4}` : '—'}</code></td><td><code className="inline-code">{entry.model || '—'}</code>{entry.source === 'thread_title' && <div className="muted">会话标题</div>}</td><td className="numeric">{displayTokens(entry.inputTokens)}</td><td className="numeric">{displayTokens(entry.outputTokens)}</td><td className="numeric strong">{displayTokens(entry.totalTokens)}</td><td><StatusBadge status={entry.status} /></td></tr>)}</tbody></table></div>{usage.some(entry => entry.totalTokens == null) && <p className="table-footnote">“未知”表示服务方未返回完整用量，不代表调用免费。实际费用请以本人 OpenAI 账单为准。</p>}</>;
}
