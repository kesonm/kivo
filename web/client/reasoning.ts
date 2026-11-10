import type { ReasoningEffort } from './types';

export const effortLabels: Record<ReasoningEffort, string> = {
  none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: 'Max',
};

export const effortOptions = Object.keys(effortLabels) as ReasoningEffort[];
