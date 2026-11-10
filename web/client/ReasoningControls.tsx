import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Icon } from './icons';
import { effortLabels } from './reasoning';
import type { ChatModelOption, ReasoningEffort } from './types';

const effortColors: Record<ReasoningEffort, readonly [number, number, number]> = {
  none: [90, 106, 128], minimal: [70, 111, 163], low: [12, 121, 111], medium: [41, 102, 202],
  high: [100, 79, 213], xhigh: [150, 59, 188], max: [187, 52, 99],
};
const rgb = (channels: readonly number[]) => `rgb(${channels.join(' ')})`;

export function ReasoningControls({ model, effort, onEffort, onPickModel, ultra, ultraAvailable, onUltra }: {
  model?: ChatModelOption;
  effort?: ReasoningEffort;
  onEffort: (effort?: ReasoningEffort) => void;
  onPickModel: () => void;
  ultra: boolean;
  ultraAvailable: boolean;
  onUltra: (enabled: boolean) => void;
}) {
  const slider = useRef<HTMLInputElement>(null);
  const scale = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const ultraHint = useId();
  const efforts = model?.efforts ?? [];
  const last = Math.max(0, efforts.length - 1);
  const selected = Math.max(0, effort ? efforts.indexOf(effort) : 0);
  const position = dragPosition ?? selected;
  const nearest = Math.round(position);
  const lower = Math.floor(position);
  const from = effortColors[efforts[lower]] ?? effortColors.none;
  const to = effortColors[efforts[Math.min(last, lower + 1)]] ?? from;
  const color = rgb(from.map((channel, i) => Math.round(channel + (to[i] - channel) * (position - lower))));
  const stops = efforts.map((level, i) => `${rgb(effortColors[level])} calc(var(--reasoning-radius) + (100% - var(--reasoning-knob)) * ${i / (last || 1)})`);
  const label = efforts.length ? effortLabels[efforts[nearest]] : '由模型决定';
  const style = {
    '--reasoning-color': color,
    '--reasoning-position': last ? position / last : 0,
    '--reasoning-gradient': last ? `linear-gradient(90deg, ${stops.join(', ')})` : color,
  } as CSSProperties;

  function positionAt(clientX: number) {
    const bounds = scale.current?.getBoundingClientRect();
    if (!bounds?.width) return selected;
    return Math.max(0, Math.min(last, (clientX - bounds.left) / bounds.width * last));
  }

  function startDrag(event: PointerEvent<HTMLInputElement>) {
    if (!event.isPrimary || event.button !== 0 || pointer.current !== null) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
  }

  function endDrag(event: PointerEvent<HTMLInputElement>, commit: boolean) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    setDragPosition(null);
    if (commit) onEffort(efforts[Math.round(positionAt(event.clientX))]);
  }

  return <div className={'reasoning-controls' + (dragPosition !== null ? ' is-dragging' : '')} style={style}>
    <div className="reasoning-heading">
      <Icon name="spark" size={15} />
      <div className="reasoning-selection">
        <span className="reasoning-value">{label}</span>
        <button type="button" className="reasoning-model-link" aria-haspopup="menu" aria-label={`切换模型，当前为 ${model?.label || '默认模型'}`} onClick={onPickModel}>
          <span>{model?.label || '默认模型'}</span><Icon name="chevron" size={12} />
        </button>
      </div>
      <button type="button" className="reasoning-reset" title="恢复默认思考档位" aria-label="恢复默认思考档位"
        disabled={!ultra && (efforts.length < 2 || effort === model?.defaultEffort)} onClick={() => {
          onEffort();
          slider.current?.focus();
        }}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
    {efforts.length > 0 && <div className="reasoning-track">
      <div className="reasoning-rail" aria-hidden="true"><div className="reasoning-fill" /></div>
      <div ref={scale} className="reasoning-scale" aria-hidden="true">
        {efforts.map((level, i) => <span key={level} className={'reasoning-mark' + (i <= position ? ' filled' : '')}
          style={{ left: `${i / (last || 1) * 100}%` }} />)}
        <span className="reasoning-thumb" />
      </div>
      <input ref={slider} aria-label="思考程度" aria-valuetext={label} type="range" min={0} max={last || 1} step={1}
        value={nearest} disabled={!last} onChange={event => {
          if (pointer.current === null) onEffort(efforts[Number(event.currentTarget.value)]);
        }} onPointerDown={startDrag} onPointerMove={event => {
          if (pointer.current === event.pointerId) setDragPosition(positionAt(event.clientX));
        }} onPointerUp={event => endDrag(event, true)} onPointerCancel={event => endDrag(event, false)}
        onLostPointerCapture={event => endDrag(event, false)} />
    </div>}
    {!efforts.length && <p className="reasoning-unavailable">此模型未配置思考档位</p>}
    {model?.supportsUltra && <div className="reasoning-ultra">
      <button type="button" role="switch" aria-checked={ultra} aria-describedby={ultraHint}
        className="reasoning-ultra-switch" disabled={!ultraAvailable} onClick={() => onUltra(!ultra)}>
        <span>Ultra · 多代理</span><span className="reasoning-ultra-toggle" aria-hidden="true" />
      </button>
      <p id={ultraHint}>{ultraAvailable ? '仅本条消息，可并行处理任务，可能消耗更多 token。' : 'Ultra 仅用于普通文字聊天。'}</p>
    </div>}
  </div>;
}
