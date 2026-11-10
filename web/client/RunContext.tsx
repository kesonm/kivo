import { useEffect, useState } from 'react';
import { api, dateTime, enc, messageOf } from './api';
import { TaskActivity, useRunActivity } from './RunActivity';
import { Icon } from './icons';
import type { Run, RunEvent } from './types';
import './run-context.css';

type Source = { kind: string; id?: string; title?: string; taskTitle?: string; version?: number; role?: string; conversationId?: string; createdAt?: string; excerpt?: string; truncated?: boolean; sourceRunId?: string; sessionId?: string };
type Snapshot = { recorded: boolean; sources: Source[]; execution: null | { mode: string; lifecycle: string; sessionId?: string; threadId?: string; inheritedHistory?: boolean } };
const lifecycle: Record<string,string> = { new:'新建执行会话', continue:'恢复执行会话', rebuild:'重建执行会话', fork:'独立分支会话', revise:'修订会话', request:'独立模型请求', attachments:'仅保存附件，未调用模型' };
function HistoricalActivity({runId}: {runId:string}) {
  const activity = useRunActivity(runId);
  return activity.run ? <TaskActivity run={activity.run} events={activity.events} error={activity.error} refresh={activity.refresh} initiallyOpen /> : <p className="execution-note">{activity.error || '正在读取执行记录…'}{activity.error && <button onClick={activity.refresh}>重试</button>}</p>;
}
export function RunDetails({runId, live, events = [], error, refresh = () => {}}: {runId:string; live?:Run; events?:RunEvent[]; error?:string; refresh?:()=>void}) {
  const [activityOpen,setActivityOpen] = useState(false);
  const [wanted,setWanted] = useState(false);
  const [snapshot,setSnapshot] = useState<Snapshot>();
  const [failure,setFailure] = useState('');
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    if (!wanted && live?.status !== 'running') return;
    const controller=new AbortController();
    setFailure('');
    api<Snapshot>(`/api/runs/${enc(runId)}/context`,{signal:controller.signal}).then(setSnapshot).catch(e=>{if(!controller.signal.aborted)setFailure(messageOf(e));});
    return ()=>controller.abort();
  },[runId,wanted,retry,live?.status]);
  const unavailable=snapshot?.sources.filter(source=>source.kind==='unavailable').length || 0;
  const histories=new Map<string,Source[]>();
  for(const source of snapshot?.sources || []) if(source.kind==='message') {
    const key=source.conversationId || source.id!; histories.set(key,[...(histories.get(key)||[]),source]);
  }
  return <details className="execution-details-group">
    <summary><Icon name="terminal" size={15}/><span>执行详情</span><small>{live?.status === 'running' ? '正在执行' : '活动与上下文来源'}</small><Icon name="down" size={14}/></summary>
    <div className="execution-details">
    {live ? <TaskActivity run={live} events={events} error={error} refresh={refresh}/> : activityOpen ? <HistoricalActivity runId={runId}/> : <button className="execution-summary" onClick={()=>setActivityOpen(true)}><Icon name="terminal" size={15}/>执行活动<Icon name="down" size={14}/></button>}
    <details className="context-disclosure" onToggle={e=>{if(e.currentTarget.open)setWanted(true);}}>
      <summary><Icon name="folder" size={15}/>上下文来源{snapshot?.recorded && <small>{histories.size} 个历史对话</small>}<Icon name="down" size={14}/></summary>
      {failure ? <p role="alert">{failure}<button onClick={()=>setRetry(n=>n+1)}>重试</button></p> : !snapshot ? <p>正在读取来源…</p> : !snapshot.recorded ? <p>此执行未记录上下文来源，不能确定引用了哪些历史会话。</p> : <>
        {snapshot.execution?.inheritedHistory && <p>本次恢复了执行线程。下方清单记录显式加载的来源，不包含线程内部保留的全部工具历史。</p>}
        {histories.size===0 && <p>{snapshot.execution?.inheritedHistory ? '恢复了旧线程，其内部历史没有逐条来源清单。' : '未引用历史对话片段。'}</p>}
        {[...histories].map(([id,sources])=><details key={id} className="source-group"><summary>{sources[0].title || '历史对话'}<small>引用 {sources.length} 条消息</small></summary>
          {sources.map(source=><div className="source-excerpt" key={source.id}><small>{source.createdAt && dateTime(source.createdAt)} · {source.sessionId ? '来自已记录的执行 Session' : '历史消息来源'}</small><p>{source.excerpt}{source.truncated?'…（仅展示前 1200 字）':''}</p><details><summary>来源标识</summary><code>消息：{source.id}</code>{source.sessionId && <code>Session：{source.sessionId}</code>}{source.sourceRunId && <code>执行：{source.sourceRunId}</code>}</details></div>)}
        </details>)}
        {snapshot.sources.filter(source=>!['message','unavailable'].includes(source.kind)).map((source,i)=><p className="source-reference" key={source.id || i}>{source.kind==='artifact'?'参考产物':source.kind==='task'?'任务记录':source.role==='reference'?'只读参考':'工作对象'}：{source.title} {source.version ? `· v${source.version}` : ''}</p>)}
        {!!unavailable && <p>{unavailable} 项来源已删除、失效或不可访问，内容不再显示。</p>}
      </>}
    </details>
    <details className="context-disclosure" onToggle={e=>{if(e.currentTarget.open)setWanted(true);}}><summary><Icon name="chat" size={15}/>本次执行会话<Icon name="down" size={14}/></summary>
      {failure ? <p role="alert">{failure}<button onClick={()=>setRetry(n=>n+1)}>重试</button></p> : !snapshot ? <p>正在读取会话…</p> : !snapshot.execution ? <p>旧执行未记录会话映射。</p> : <><p>{lifecycle[snapshot.execution.lifecycle] || '执行会话'} · {snapshot.execution.mode==='cloud'?'云端项目':snapshot.execution.mode==='local'?'本地电脑':'普通聊天'}</p>{snapshot.execution.mode==='chat' && snapshot.execution.lifecycle!=='attachments' && <p>本次使用 Responses 请求；历史引用不会恢复来源会话执行。</p>}<code>Run：{runId}</code>{snapshot.execution.sessionId && <code>Session：{snapshot.execution.sessionId}</code>}{snapshot.execution.threadId && <code>引擎线程：{snapshot.execution.threadId}</code>}</>}
    </details>
    </div>
  </details>;
}
