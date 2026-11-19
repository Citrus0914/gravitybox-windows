import React, { useState } from 'react';

export interface BarDatum {
  label: string;
  value: number;
  tooltip?: string;
}

export const BarChart: React.FC<{
  data: BarDatum[];
  height?: number;
  formatMax?: (v: number) => string;
  xLabels?: string[];
}> = ({ data, height = 108, formatMax, xLabels }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxVal = Math.max(0, ...data.map((d) => d.value));
  const safeMax = maxVal > 0 ? maxVal : 1;

  const axisLabels = xLabels ?? (() => {
    if (data.length === 0) return [];
    if (data.length <= 5) return data.map((d) => d.label);
    const idxs = [0, Math.floor((data.length - 1) * 0.25), Math.floor((data.length - 1) * 0.5), Math.floor((data.length - 1) * 0.75), data.length - 1];
    return [...new Set(idxs)].map((i) => data[i]?.label ?? '');
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, height }}>
        <div
          className="tabular"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            minWidth: 34,
            textAlign: 'right',
            paddingBottom: 2,
          }}
        >
          <span>{formatMax ? formatMax(maxVal) : String(maxVal)}</span>
          <span>0</span>
        </div>
        <div
          style={{
            flex: 1,
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: data.length > 20 ? 3 : 6,
            borderTop: '1px dashed var(--border)',
            borderBottom: '1px solid var(--border)',
            paddingTop: 6,
            paddingBottom: 2,
          }}
        >
          {data.map((d, i) => {
            const pct = maxVal > 0 ? (d.value / safeMax) * 100 : 0;
            const barH = d.value > 0 ? Math.max(6, pct) : 4;
            const isZero = d.value <= 0;
            return (
              <div
                key={i}
                title={d.tooltip ?? `${d.label}: ${formatMax ? formatMax(d.value) : d.value}`}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  cursor: 'default',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    maxWidth: 18,
                    height: `${barH}%`,
                    borderRadius: 4,
                    background: isZero
                      ? 'var(--bg-segment)'
                      : hovered === i
                        ? 'var(--accent-hover)'
                        : 'linear-gradient(180deg, #3b93ff 0%, #0a7aff 100%)',
                    transition: 'height 0.2s ease, opacity 0.15s ease',
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          paddingLeft: 42,
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
        }}
      >
        {axisLabels.map((lbl, idx) => (
          <span key={idx}>{lbl}</span>
        ))}
      </div>
    </div>
  );
};
