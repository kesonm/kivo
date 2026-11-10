export interface User {
  id: string; username: string; displayName: string; role: 'admin' | 'user';
  disabled: boolean; usedTokens: number; apiKeyConfigured: boolean; keyLast4?: string | null; createdAt: string;
}
export interface Project { id: string; name: string; createdAt: string; updatedAt: string; location?: 'local' | 'cloud'; deviceId?: string; localPath?: string }
export interface Thread { id: string; projectId: string | null; title: string; createdAt: string; updatedAt: string }
export type ChatTool = 'auto' | 'image' | 'search' | 'analyze';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ChatModelOption {
  id: string; label: string; description: string; efforts?: ReasoningEffort[]; defaultEffort?: ReasoningEffort | null;
}
export interface AdminChatModel extends ChatModelOption {
  efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort | null; enabled: boolean;
}
export interface AdminChatModelCatalog {
  models: AdminChatModel[]; defaultModel: string; revision: number; knownEfforts: Record<string, ReasoningEffort[]>;
}
export interface MessageAttachment { name: string; mimeType: string; size: number; id?: string; url?: string; analyzable?: boolean }
export interface MessageArtifact extends MessageAttachment { id: string; url: string }
export interface MessageCitation { url: string; title: string; startIndex: number; endIndex: number }
export interface Message {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string;
  attachments?: MessageAttachment[]; artifacts?: MessageArtifact[]; citations?: MessageCitation[];
}
export interface Run {
  id: string; threadId: string; projectId?: string | null; status: 'running' | 'completed' | 'failed' | 'interrupted';
  output: string; logs: string[]; createdAt: string; error?: string;
  mode?: 'cloud' | 'local' | 'chat';
  interruptReason?: 'restart' | 'user' | 'other';
  resumedFromRunId?: string;
  verification?: RunVerification | null;
}
export interface RunVerification {
  command: string;
  status: 'not_run' | 'running' | 'passed' | 'failed' | 'unknown';
  exitCode?: number | null;
}
export interface RunEvent {
  seq: number;
  createdAt: string;
  kind: 'task' | 'command' | 'file' | 'tool' | 'approval' | 'verification';
  source: 'cloud' | 'local' | 'hosted';
  status: 'started' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown' | 'awaiting_approval';
  tool?: string;
  summary?: string;
  paths?: string[];
  exitCode?: number | null;
  itemId?: string;
}
export interface Session { user: User | null; csrfToken: string; providerConfigured: boolean; model?: string; defaultChatModel?: string; chatModels?: ChatModelOption[] }
export interface ApiKeyStatus { configured: boolean; last4: string | null; updatedAt: string | null }
export interface Usage { id: string; model: string; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; status: string; createdAt: string; userId?: string; username?: string; displayName?: string; threadId?: string; runId?: string; keyLast4?: string | null }
export interface UsagePage { usage: Usage[]; total: number; limit: number; offset: number; totals?: { inputTokens: number; outputTokens: number; totalTokens: number; unknownRequests: number; totalRequests: number } }
export interface FileEntry { path: string; size: number }
export interface Diff { diff: string; files: { path: string; status: string }[]; truncated: boolean }
export interface Overview { users: number; projects: number; runs: number; totalUsedTokens: number; unknownUsageRequests: number; configuredUsers: number; model: string }
export interface AdminThread extends Thread { owner: { id: string; username: string; displayName: string }; project: { id: string; name: string } | null; messageCount: number; runCount: number }
export interface ThreadPage { threads: AdminThread[]; total: number; limit: number; offset: number }
export interface ThreadRecord { thread: Thread; owner: { id: string; username: string; displayName: string }; project: { id: string; name: string } | null; messages: Message[]; runs: Run[]; messagesTotal: number; runsTotal: number; messageOffset: number; runOffset: number; nextMessageOffset: number | null; nextRunOffset: number | null }
export interface AuditEntry { id: string; actor: string; action: string; target: string; detail: string; createdAt: string }
