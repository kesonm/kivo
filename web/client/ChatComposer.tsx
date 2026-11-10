import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { AttachmentChips } from './ChatContent';
import { Icon } from './icons';
import { effortLabels } from './reasoning';
import { ReasoningControls } from './ReasoningControls';
import { VoiceControls } from './VoiceControls';
import type { ChatModelOption, ChatTool, ReasoningEffort } from './types';

const toolOptions = [
  { id: 'image', icon: 'image', label: '生成图片', description: '把文字描述变成图像', placeholder: '描述你想生成的图片' },
  { id: 'search', icon: 'search', label: '联网搜索', description: '查找实时信息和来源', placeholder: '你想从网上查找什么？' },
] as const;
const maxFiles = 4;

type ComposerProps = {
  draft: string;
  setDraft: (draft: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  attachments: File[];
  onAttach: (files: File[]) => void;
  onRemove: (index: number) => void;
  tool: ChatTool;
  onTool: (tool: Exclude<ChatTool, 'analyze'>) => void;
  model?: ChatModelOption;
  models: ChatModelOption[];
  onModel: (model: string) => void;
  effort?: ReasoningEffort;
  onEffort: (effort?: ReasoningEffort) => void;
  ultra: boolean;
  ultraAvailable: boolean;
  onUltra: (enabled: boolean) => void;
  onOpenReasoning: () => void;
  threadId: string | null;
  providerConfigured: boolean;
  busy: boolean;
  running: boolean;
  sending: boolean;
  stopping: boolean;
  onSend: (event?: FormEvent) => void;
  onStop: () => void;
  onOpenLocal: () => void;
  workRestricted?: boolean;
  voiceRestricted?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

export function ChatComposer({ draft, setDraft, textarea, attachments, onAttach, onRemove, tool, onTool, model, models, onModel, effort, onEffort, ultra, ultraAvailable, onUltra, onOpenReasoning, threadId, providerConfigured, busy, running, sending, stopping, onSend, onStop, onOpenLocal, workRestricted = false, voiceRestricted = false, onBusyChange }: ComposerProps) {
  const [menu, setMenu] = useState<'tools' | 'reasoning' | 'models' | null>(null);
  const [opensBelow, setOpensBelow] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  const toolTrigger = useRef<HTMLButtonElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const blocked = busy || voiceBusy;
  const hasDraft = Boolean(draft.trim() || attachments.length);
  const selectedTool = toolOptions.find(option => option.id === tool);
  const modelLabel = model?.label || '默认模型';
  const efforts = model?.efforts ?? [];
  const effortIndex = Math.max(0, effort ? efforts.indexOf(effort) : 0);
  const effortLabel = efforts.length ? effortLabels[efforts[effortIndex]] : '由模型决定';
  const modeLabel = ultra ? 'Ultra 多代理' : effortLabel;
  const modelMenuOpen = (menu === 'reasoning' || menu === 'models') && !blocked;
  const nativeVoiceBlocked = typeof navigator !== 'undefined' && /\bkivo-iOS\//i.test(navigator.userAgent);
  const updateVoiceBusy = useCallback((value: boolean) => {
    setVoiceBusy(value);
    if (value) setMenu(null);
  }, []);
  useEffect(() => { onBusyChange?.(voiceBusy); }, [voiceBusy, onBusyChange]);

  useEffect(() => {
    if (!menu || blocked) return;
    const activeTrigger = menu === 'tools' ? toolTrigger.current : modelTrigger.current;
    const items = menuContent.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const selected = Array.from(items ?? []).find(item => item.getAttribute('aria-checked') === 'true');
    const slider = menuContent.current?.querySelector<HTMLInputElement>('input[type="range"]:not(:disabled)');
    (slider ?? selected ?? items?.[0])?.focus({ preventScroll: true });
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menuContent.current?.contains(event.target) && !activeTrigger?.contains(event.target)) setMenu(null);
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu, blocked]);

  function toggleMenu(next: 'tools' | 'reasoning') {
    if (menu === next || (next === 'reasoning' && menu === 'models')) {
      setMenu(null);
      return;
    }
    const bounds = form.current?.getBoundingClientRect();
    const spaceBelow = window.innerHeight - (bounds?.bottom ?? window.innerHeight);
    const spaceAbove = bounds?.top ?? 0;
    setOpensBelow(next === 'tools' ? spaceBelow >= 260 : spaceAbove < 248 && spaceBelow > spaceAbove);
    setMenu(next);
    if (next === 'reasoning') onOpenReasoning();
  }

  function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && menu === 'models') {
      event.preventDefault();
      event.stopPropagation();
      setMenu('reasoning');
      return;
    }
    if (menu === 'reasoning' && event.key !== 'Escape') return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      (menu === 'tools' ? toolTrigger : modelTrigger).current?.focus();
      setMenu(null);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menuContent.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') items[0].focus();
    else if (event.key === 'End') items[items.length - 1].focus();
    else items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }

  function paste(event: ClipboardEvent<HTMLFormElement>) {
    if (blocked) return;
    const clipboard = event.clipboardData;
    const files = Array.from(clipboard.files ?? []);
    if (!files.length) {
      for (const item of clipboard.items ?? []) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      event.preventDefault();
      onAttach(files);
    }
  }

  function insertDictation(text: string) {
    const transcript = text.trim();
    if (!transcript) return;
    const editor = textarea.current;
    const start = editor?.selectionStart ?? draft.length;
    const end = editor?.selectionEnd ?? start;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const prefix = /[a-z0-9]$/i.test(before) && /^[a-z0-9]/i.test(transcript) ? ' ' : '';
    const suffix = /[a-z0-9]$/i.test(transcript) && /^[a-z0-9]/i.test(after) ? ' ' : '';
    setDraft((before + prefix + transcript + suffix + after).slice(0, 24000));
    requestAnimationFrame(() => {
      textarea.current?.focus();
      const cursor = before.length + prefix.length + transcript.length;
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  return <form ref={form} className={'composer composer-chat' + (running ? ' composer-running' : '') + (attachments.length || selectedTool ? ' composer-with-context' : '')}
    onSubmit={event => { event.preventDefault(); if (!blocked) onSend(event); }} onPaste={paste}>
    {!!attachments.length && <AttachmentChips files={attachments} disabled={blocked} onRemove={onRemove} />}
    {selectedTool && <div className="composer-selection">
      <button className="composer-tool-chip" type="button" disabled={blocked} aria-label={`移除工具 ${selectedTool.label}`} onClick={() => { onTool('auto'); textarea.current?.focus(); }}>
        <Icon name={selectedTool.icon} size={15} />{selectedTool.label}<Icon name="close" size={13} />
      </button>
    </div>}
    <div className="composer-input-row">
      <button ref={toolTrigger} type="button" className="composer-control composer-plus" title="添加文件与工具" aria-label="添加文件与工具" aria-haspopup="menu"
        aria-expanded={menu === 'tools' && !blocked} aria-controls={menu === 'tools' && !blocked ? menuId : undefined} disabled={blocked} onClick={() => toggleMenu('tools')}>
        <Icon name="plus" size={20} />
      </button>
      <input type="file" ref={fileInput} multiple hidden onChange={event => {
        onAttach(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = '';
      }} />
      <textarea ref={textarea} value={draft} onChange={event => setDraft(event.target.value)}
        placeholder={running ? 'kivo 正在执行任务…' : tool === 'analyze' ? '你想了解附件中的哪些内容？' : selectedTool?.placeholder || '有问题，尽管问'}
        aria-label="发送给 kivo 的消息" disabled={blocked} maxLength={24000} rows={1} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!blocked) onSend();
          }
        }} />
      <div className="composer-controls">
        <button ref={modelTrigger} type="button" className={'composer-model-picker' + (ultra ? ' ultra-active' : '')} title={`${modelLabel} · ${modeLabel}`} aria-label={`选择思考程度，当前模型 ${modelLabel}，${modeLabel}`} aria-haspopup="dialog"
          aria-expanded={modelMenuOpen} aria-controls={modelMenuOpen ? menuId : undefined} disabled={blocked || !models.length} onClick={() => toggleMenu('reasoning')}>
          <span>{ultra ? 'Ultra' : modelLabel}</span><Icon name="down" size={13} />
        </button>
        <VoiceControls disabled={busy || !providerConfigured || nativeVoiceBlocked || workRestricted || voiceRestricted} disabledReason={workRestricted || voiceRestricted ? '请先发送一条普通问答结束工作上下文，再使用语音功能' : nativeVoiceBlocked ? '请在浏览器中使用语音功能' : undefined}
          hasDraft={hasDraft || running} threadId={threadId} onDictation={insertDictation} onBusyChange={updateVoiceBusy} />
        {running ? <button type="button" className="send-button stop-button" title="停止任务" aria-label="停止任务" disabled={stopping} onClick={onStop}>
          {stopping ? <span className="spinner" /> : <Icon name="stop" size={17} />}
        </button> : (hasDraft || sending) && <button type="submit" className="send-button" title="发送消息" aria-label="发送消息" disabled={!hasDraft || blocked || !providerConfigured}>
          {sending ? <span className="spinner" /> : <Icon name="send" size={20} />}
        </button>}
      </div>
    </div>
    {menu && !blocked && <div ref={menuContent} id={menuId} role={menu === 'reasoning' ? 'dialog' : 'menu'}
      aria-label={menu === 'tools' ? '可用工具' : menu === 'reasoning' ? '思考程度' : '选择模型'} onKeyDown={navigateMenu}
      onBlur={event => {
        if (menu === 'reasoning' && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)
            && !modelTrigger.current?.contains(event.relatedTarget)) setMenu(null);
      }}
      className={`composer-popover composer-popover-${menu} ${opensBelow ? 'popover-below' : 'popover-above'}`}>
      {menu === 'tools' ? <>
        <button type="button" role="menuitem" disabled={attachments.length >= maxFiles || workRestricted} onClick={() => { setMenu(null); fileInput.current?.click(); }}>
          <Icon name="file" size={17} /><span className="composer-option-title">添加照片和文件</span><span className="composer-option-description">{workRestricted ? '切换到普通问答后使用' : '上传、粘贴与分析附件'}</span>
        </button>
        {toolOptions.map(option => <button type="button" role="menuitem" key={option.id} disabled={attachments.length > 0} onClick={() => { onTool(option.id); setMenu(null); textarea.current?.focus(); }}>
          <Icon name={option.icon} size={17} /><span className="composer-option-title">{option.label}</span><span className="composer-option-description">{option.description}</span>
          {tool === option.id && <Icon name="check" size={16} />}
        </button>)}
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onOpenLocal(); }}>
          <Icon name="folder" size={17} /><span className="composer-option-title">打开本地文件夹</span><span className="composer-option-description">进入本地项目对话</span>
        </button>
      </> : menu === 'reasoning' ? <ReasoningControls key={model?.id} model={model} effort={effort} onEffort={onEffort}
        onPickModel={() => setMenu('models')} ultra={ultra} ultraAvailable={ultraAvailable} onUltra={onUltra} /> : <>
        <button type="button" role="menuitem" className="reasoning-back" onClick={() => setMenu('reasoning')}>
          <Icon name="chevron" size={13} />返回思考程度
        </button>
        {models.map(option => <button type="button" role="menuitemradio" aria-checked={option.id === model?.id} key={option.id}
          onClick={() => { onModel(option.id); setMenu('reasoning'); }}>
          <span className="composer-model-option">
            <span className="composer-option-title">{option.label}</span>
            {option.description && <span className="composer-option-description">{option.description}</span>}
          </span>
          {option.id === model?.id && <Icon name="check" size={17} />}
        </button>)}
      </>}
    </div>}
  </form>;
}
