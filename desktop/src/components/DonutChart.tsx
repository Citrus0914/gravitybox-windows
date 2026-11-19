import React from 'react';

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export const DONUT_PALETTE = ['#2563eb', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b'];

export const DonutChart: React.FC<{
  slices: DonutSlice[];
  centerValue: string;
  centerLabel: string;
  size?: number;
}> = ({ slices, centerValue, centerLabel, size = 122 }) => {
  const total = slices.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  const r = 44;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--bg-segment)"
          strokeWidth="12"
        />
        {total > 0 &&
          slices.map((s, idx) => {
            const frac = Math.max(0, s.value) / total;
            if (frac <= 0) return null;
            const dash = Math.max(2, frac * c - (slices.length > 1 ? 2.5 : 0));
            const curOffset = -offset;
            offset += frac * c;
            return (
              <circle
                key={idx}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="12"
                strokeDasharray={`${dash} ${c}`}
                strokeDashoffset={curOffset}
                strokeLinecap="butt"
                transform="rotate(-90 60 60)"
              />
            );
          })}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          textAlign: 'center',
          padding: 16,
        }}
      >
        <div className="tabular" style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.15 }}>
          {centerValue}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 2 }}>
          {centerLabel}
        </div>
      </div>
    </div>
  );
};
