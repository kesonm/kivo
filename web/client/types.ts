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
  supportsUltra?: boolean;
}
export interface AdminChatModel extends ChatModelOption {
  efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort | null; enabled: boolean;
}
export interface AdminChatModelCatalog {
  models: AdminChatModel[]; defaultModel: string; revision: number; knownEfforts: Record<string, ReasoningEffort[]>;
}
export interface OpenAiModelList { models: AdminChatModel[]; otherModels: string[] }
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

export type WorkRoutingMode = 'off' | 'shadow' | 'enforce';
export type WorkIntent = 'question' | 'new' | 'continue' | 'fork' | 'revise' | 'reference' | 'compare';
export interface WorkSelection {
  intent: WorkIntent;
  taskId?: string;
  objectId?: string;
  referenceIds?: string[];
  focusRevision?: number;
  taskVersion?: number;
}
export interface WorkObject {
  id: string; name: string; kind: string; projectId: string | null; version: number;
  aliases?: string[]; anchors?: Record<string, unknown>; updatedAt?: string;
}
export interface WorkTask {
  id: string; goal: string; status: string; version: number; generation?: number;
  objects: (WorkObject & { role: 'target' | 'reference' })[];
  constraints?: string[]; acceptance?: string[]; updatedAt?: string;
  parentTaskId?: string | null; relation?: string | null;
}
export interface WorkFocus {
  revision: number; taskId: string | null; objectId: string | null;
  source?: string; updatedAt?: string;
}
export interface WorkCandidate {
  id: string; goal?: string; name?: string; status?: string; state?: string;
  objectName?: string; projectId?: string | null; updatedAt?: string; version?: number;
  kind?: string; taskId?: string; objectId?: string;
}
export interface WorkRoute {
  status: 'matched' | 'new' | 'ambiguous' | 'unresolved' | 'blocked';
  intent?: WorkIntent; taskId?: string | null; objectId?: string | null;
  candidates?: WorkCandidate[]; reason?: string; evidence?: unknown[]; allowed?: boolean | string[];
  objectCandidates?: { id: string; name: string; projectId?: string | null }[];
}
export interface WorkSnapshot {
  mode: WorkRoutingMode; objects: WorkObject[]; tasks: WorkTask[];
  executionScope?: 'question' | 'task' | 'legacy_project';
  focus?: WorkFocus; task?: WorkTask | null; executionProject?: Project | null;
  decisions?: { id?: string; status?: string; reason?: string; createdAt?: string; intent?: string }[];
  artifacts?: { id: string; name?: string; title?: string; version: number; status?: string; verificationStatus?: string }[];
}

export interface SupervisorTask {
  id: string; goal: string; status: string; queueStatus: string;
  conversationId: string; originMessageId: string; projectId?: string | null; projectName?: string | null;
  messageIds?: string[];
  latestRunId?: string | null; updatedAt: string; summary?: string; version?: number;
  result?: string; pendingFollowUp?: boolean;
  artifacts?: SupervisorArtifact[];
}
export interface SupervisorArtifact {
  id: string; name?: string; title?: string; url?: string; version?: number; status?: string;
}
export interface SupervisorSnapshot {
  tasks: SupervisorTask[]; counts: { queued: number; running: number; attention: number }; revision: string | number;
}
export interface SupervisorDetail {
  task: SupervisorTask;
  artifacts?: SupervisorArtifact[];
  events?: { id?: string; type?: string; kind?: string; summary?: string; createdAt?: string; status?: string }[];
}
