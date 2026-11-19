import React from 'react';

export const BrandLogo: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="gb-grad" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#3B82F6" />
        <stop offset="55%" stopColor="#6366F1" />
        <stop offset="100%" stopColor="#06B6D4" />
      </linearGradient>
    </defs>
    <path
      d="M32 7L54 53L42.5 53L32 30.5L21.5 53L10 53L32 7Z"
      fill="url(#gb-grad)"
    />
    <path
      d="M24.5 41.5L32 35.5L39.5 41.5L32 50L24.5 41.5Z"
      fill="url(#gb-grad)"
      opacity="0.7"
    />
  </svg>
);

export const ModelIcon: React.FC<{ name: string; size?: number }> = ({ name, size = 15 }) => {
  const low = (name || '').toLowerCase();
  if (low.includes('claude')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <g stroke="#D97757" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="2.5" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="21.5" y2="12" />
          <line x1="5.3" y1="5.3" x2="18.7" y2="18.7" />
          <line x1="18.7" y1="5.3" x2="5.3" y2="18.7" />
        </g>
      </svg>
    );
  }
  if (low.includes('gpt') || low.includes('o1') || low.includes('o3') || low.includes('o4') || low.includes('openai')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="#64748B" strokeWidth="1.8" strokeDasharray="4 2" />
        <circle cx="12" cy="12" r="3" fill="#64748B" />
      </svg>
    );
  }
  // Gemini / Argon / Carbon / default sparkle
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="gem-star" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="50%" stopColor="#06B6D4" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <path
        d="M12 2C12.7 7.4 16.6 11.3 22 12C16.6 12.7 12.7 16.6 12 22C11.3 16.6 7.4 12.7 2 12C7.4 11.3 11.3 7.4 12 2Z"
        fill="url(#gem-star)"
      />
    </svg>
  );
};
