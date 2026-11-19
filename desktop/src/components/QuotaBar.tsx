import React from 'react';
import type { NormalizedQuotaBar } from '../format';
import { ModelIcon } from './ModelIcon';

export const QuotaBar: React.FC<{ bar: NormalizedQuotaBar; showIcon?: boolean }> = ({
  bar,
  showIcon = true,
}) => {
  const pct = bar.percentage;
  const known = pct !== null && pct !== undefined && Number.isFinite(pct);
  const clamped = known ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const tone = !known ? '' : clamped <= 15 ? 'low' : clamped <= 35 ? 'warn' : '';

  return (
    <div className="quota-item">
      <div className="quota-top">
        <span className="quota-label">
          {showIcon && <ModelIcon name={bar.family === 'claude' ? 'claude' : 'gemini'} size={14} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {bar.label}
          </span>
        </span>
        <span className="quota-meta">
          {bar.resetCountdown && <span className="quota-reset">{bar.resetCountdown}</span>}
          <span className={`quota-pct tabular ${tone}`}>
            {known ? `${clamped}%` : '--'}
          </span>
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill ${tone}`}
          style={{ width: known ? `${Math.max(clamped > 0 ? 3 : 0, clamped)}%` : '0%' }}
        />
      </div>
    </div>
  );
};
