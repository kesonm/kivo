import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import { Icon } from './icons';
import './voice-controls.css';

type VoiceMode = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'connecting' | 'live';
type VoiceTask = {
  kind: 'dictation' | 'realtime';
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  sessionId?: string;
  limit?: number;
  disconnect?: number;
};

const MAX_AUDIO_BYTES = 768 * 1024;
const RECORDING_MS = 60_000;
const VOICE_MS = 10 * 60_000;
const AUDIO_FORMATS = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

async function stopRemote(sessionId: string) {
  try { await api('/api/voice/realtime/stop', { method: 'POST', body: { sessionId } }); }
  catch { /* The peer also disconnects, and the server expires the session. */ }
}

function dispose(task: VoiceTask, audio: HTMLAudioElement | null) {
  task.controller.abort();
  window.clearTimeout(task.limit);
  window.clearTimeout(task.disconnect);
  if (task.recorder && task.recorder.state !== 'inactive') task.recorder.stop();
  task.stream?.getTracks().forEach(track => track.stop());
  task.channel?.close();
  task.peer?.close();
  if (audio) audio.srcObject = null;
  if (task.sessionId) void stopRemote(task.sessionId);
}

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '请在浏览器的网站设置里允许使用麦克风';
    if (error.name === 'NotFoundError') return '找不到麦克风，请检查输入设备';
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return '无法启用麦克风，请检查系统权限或设备占用';
  }
  return messageOf(error);
}

function microphone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器环境无法启用麦克风，请使用支持麦克风的浏览器打开 HTTPS 页面');
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

function audioBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') { reject(new Error('未能读取录音')); return; }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('未能读取录音')), { once: true });
    reader.readAsDataURL(blob);
  });
}

function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === 'complete' || signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => {
      window.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const timer = window.setTimeout(finish, 2_500);
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', finish, { once: true });
  });
}

type Props = {
  disabled: boolean;
  disabledReason?: string;
  hasDraft: boolean;
  threadId: string | null;
  onDictation: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

export function VoiceControls({ disabled, disabledReason, hasDraft, threadId, onDictation, onBusyChange }: Props) {
  const taskRef = useRef<VoiceTask | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [mode, setMode] = useState<VoiceMode>('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [playingBlocked, setPlayingBlocked] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const busy = mode !== 'idle';
  const realtime = mode === 'connecting' || mode === 'live';
  const dictating = busy && !realtime;

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  useEffect(() => {
    setMode('idle');
    setError('');
    const release = () => {
      const task = taskRef.current;
      taskRef.current = null;
      if (task) dispose(task, audioRef.current);
    };
    const pageHidden = () => { release(); setMode('idle'); };
    window.addEventListener('pagehide', pageHidden);
    return () => {
      window.removeEventListener('pagehide', pageHidden);
      release();
    };
  }, [threadId]);

  function end(task: VoiceTask, message = '') {
    if (taskRef.current !== task) return;
    taskRef.current = null;
    dispose(task, audioRef.current);
    setMode('idle');
    setError(message);
  }

  function begin(kind: VoiceTask['kind']) {
    if (taskRef.current || disabled) return null;
    const task: VoiceTask = { kind, controller: new AbortController() };
    taskRef.current = task;
    setError('');
    setMuted(false);
    setPlayingBlocked(false);
    setSpeaking(false);
    setMode(kind === 'realtime' ? 'connecting' : 'requesting');
    return task;
  }

  async function dictate() {
    const active = taskRef.current;
    if (active?.kind === 'dictation') {
      if (active.recorder?.state === 'recording') active.recorder.stop();
      else end(active);
      return;
    }
    const task = begin('dictation');
    if (!task) return;
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录音，请更新浏览器后重试');
      const mimeType = AUDIO_FORMATS.find(format => MediaRecorder.isTypeSupported(format));
      if (!mimeType) throw new Error('当前浏览器没有可用的录音格式');
      const stream = await microphone();
      if (taskRef.current !== task) { stream.getTracks().forEach(track => track.stop()); return; }
      task.stream = stream;
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
      task.recorder = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.addEventListener('dataavailable', event => {
        if (taskRef.current !== task || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_AUDIO_BYTES) { end(task, '录音太大，请缩短后重试'); return; }
        chunks.push(event.data);
      });
      recorder.addEventListener('error', () => end(task, '录音过程中出现错误，请重试'), { once: true });
      recorder.addEventListener('stop', async () => {
        if (taskRef.current !== task) return;
        window.clearTimeout(task.limit);
        stream.getTracks().forEach(track => track.stop());
        setMode('transcribing');
        try {
          if (!bytes) throw new Error('没有录到声音，请重试');
          const type = (recorder.mimeType || mimeType).split(';')[0];
          const audio = await audioBase64(new Blob(chunks, { type }));
          if (taskRef.current !== task) return;
          const result = await api<{ text: string }>('/api/voice/transcribe', {
            method: 'POST', body: { audio, mimeType: type }, signal: task.controller.signal,
          });
          if (taskRef.current !== task) return;
          if (!result.text) throw new Error('没有识别到可转写的内容，请重试');
          onDictation(result.text);
          end(task);
        } catch (failure) { end(task, messageOf(failure)); }
      }, { once: true });
      recorder.start(1_000);
      setMode('recording');
      task.limit = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, RECORDING_MS);
    } catch (failure) {
      end(task, microphoneError(failure));
    }
  }

  async function playVoice(task: VoiceTask) {
    const audio = audioRef.current;
    if (!audio || !audio.srcObject) return;
    try {
      await audio.play();
      if (taskRef.current === task) setPlayingBlocked(false);
    } catch {
      if (taskRef.current === task) setPlayingBlocked(true);
    }
  }

  async function startVoice() {
    const active = taskRef.current;
    if (active?.kind === 'realtime') { end(active); return; }
    const task = begin('realtime');
    if (!task) return;
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('当前浏览器不支持实时语音');
      const stream = await microphone();
      if (taskRef.current !== task) { stream.getTracks().forEach(track => track.stop()); return; }
      task.stream = stream;
      const peer = new RTCPeerConnection();
      task.peer = peer;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('没有找到可用的麦克风音轨');
      peer.addTrack(track, stream);
      track.addEventListener('ended', () => end(task, '麦克风已断开，语音对话已结束'), { once: true });
      peer.addEventListener('track', event => {
        if (taskRef.current !== task || !audioRef.current) return;
        audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void playVoice(task);
      });
      peer.addEventListener('connectionstatechange', () => {
        if (taskRef.current !== task) return;
        window.clearTimeout(task.disconnect);
        if (peer.connectionState === 'connected') {
          setMode('live');
        } else if (peer.connectionState === 'disconnected') {
          setMode('connecting');
          task.disconnect = window.setTimeout(() => end(task, '语音连接已断开，请重试'), 6_000);
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          end(task, '语音连接已断开，请重试');
        }
      });
      const channel = peer.createDataChannel('oai-events');
      task.channel = channel;
      channel.addEventListener('message', message => {
        if (taskRef.current !== task || typeof message.data !== 'string' || message.data.length > 65_536) return;
        try {
          const event = JSON.parse(message.data);
          if (event.type === 'response.created' || event.type === 'output_audio_buffer.started') setSpeaking(true);
          if (event.type === 'response.done' || event.type === 'output_audio_buffer.stopped' ||
              event.type === 'input_audio_buffer.speech_started') setSpeaking(false);
          if (event.type === 'error') end(task, 'OpenAI 语音会话遇到错误，请重试');
        } catch { /* Ignore malformed diagnostic events. */ }
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await gatherIce(peer, task.controller.signal);
      if (taskRef.current !== task) return;
      const result = await api<{ sdp: string; sessionId: string }>('/api/voice/realtime', {
        method: 'POST', body: { sdp: peer.localDescription?.sdp ?? offer.sdp }, signal: task.controller.signal,
      });
      if (taskRef.current !== task) { void stopRemote(result.sessionId); return; }
      task.sessionId = result.sessionId;
      task.limit = window.setTimeout(() => end(task, '本次语音对话已到 10 分钟，可以重新开始'), VOICE_MS);
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      if (taskRef.current !== task || peer.connectionState === 'connected') return;
      task.disconnect = window.setTimeout(() => end(task, '未能建立实时音频连接，请检查网络后重试'), 18_000);
    } catch (failure) {
      end(task, microphoneError(failure));
    }
  }

  function toggleMute() {
    const stream = taskRef.current?.stream;
    if (!stream) return;
    stream.getAudioTracks().forEach(track => { track.enabled = muted; });
    setMuted(!muted);
  }

  const micLabel = mode === 'recording' ? '结束录音并转写' : dictating ? '取消语音输入' : '语音输入';
  const voiceLabel = realtime ? '结束语音对话' : '语音对话';
  return <>
    <button type="button" className={'composer-voice-button' + (dictating ? ' voice-active' : '')}
      aria-label={micLabel} title={disabled && !dictating ? disabledReason || micLabel : micLabel} aria-pressed={dictating}
      disabled={realtime || (!dictating && disabled)} onClick={() => void dictate()}>
      <Icon name={mode === 'recording' ? 'stop' : 'mic'} size={18} />
    </button>
    {(!hasDraft || realtime) && <button type="button" className="composer-voice-primary" aria-label={voiceLabel}
      title={disabled && !realtime ? disabledReason || voiceLabel : voiceLabel}
      aria-pressed={realtime} disabled={dictating || (!realtime && disabled)} onClick={() => void startVoice()}>
      <Icon name={realtime ? 'stop' : 'wave'} size={18} />
    </button>}
    <audio ref={audioRef} autoPlay hidden />
    {dictating && <div className="voice-indicator" role="status">
      {mode === 'recording' ? '正在录音，点击停止后转写' : mode === 'transcribing' ? '正在转写…' : '正在等待麦克风权限…'}
    </div>}
    {realtime && <section className="voice-session-panel" aria-label="实时语音">
      <div className="voice-session-symbol"><Icon name="wave" size={22} /></div>
      <div className="voice-session-status" role="status">
        <strong>语音对话</strong>
        <span>{mode === 'connecting' ? '正在连接…' : muted ? '麦克风已静音' : speaking ? 'kivo 正在回答…' : '正在聆听，可以直接说话'}</span>
      </div>
      <button type="button" className="composer-voice-button" aria-label={muted ? '取消静音' : '静音麦克风'}
        aria-pressed={muted} title={muted ? '取消静音' : '静音麦克风'} disabled={mode !== 'live'} onClick={toggleMute}>
        <Icon name={muted ? 'mic-off' : 'mic'} size={17} />
      </button>
      <button type="button" className="voice-end-button" onClick={() => void startVoice()}>结束</button>
      {playingBlocked && <button type="button" className="voice-play-button" onClick={() => { const task = taskRef.current; if (task) void playVoice(task); }}>播放语音</button>}
    </section>}
    {error && <div className="voice-error" role="alert"><span>{error}</span>
      <button type="button" className="composer-voice-button" aria-label="关闭语音提示" onClick={() => setError('')}><Icon name="close" size={15} /></button>
    </div>}
  </>;
}
