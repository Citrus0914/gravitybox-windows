export function compactNumber(value: number, significantDigits = 3): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const integer = Math.floor(value);
  if (integer < 1000) return String(integer);
  const rounded = Number(integer.toPrecision(significantDigits));
  const divisor = rounded >= 1e9 ? 1e9 : rounded >= 1e6 ? 1e6 : 1e3;
  const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : 'K';
  return `${Number((rounded / divisor).toPrecision(significantDigits))}${unit}`;
}

/**
 * 格式化最多保留 fractionDigits 位小数的简约数字（去除多余尾零，如 15.50 -> 15.5、0.00 -> 0）。
 */
export function compactDecimal(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const digits = Math.max(0, Math.min(20, Math.floor(fractionDigits)));
  if (digits === 0) return String(Math.round(value) || 0);
  const rounded = Number(value.toFixed(digits));
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return String(rounded);
}

/**
 * 格式化简约百分比（<100% 保留 significantDigits 位有效数字并去尾零；>=100% 取整，如 0.155 -> 15.5%、0.42 -> 42%、1.132 -> 113%）。
 */
export function compactPercent(ratio: number, significantDigits = 3): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = ratio * 100;
  if (percent >= 100) return `${Math.round(percent)}%`;
  const rounded = Number(percent.toPrecision(significantDigits));
  if (Object.is(rounded, -0) || rounded === 0) return '0%';
  if (rounded >= 100) return `${Math.round(rounded)}%`;
  const text = rounded < 1e-4 ? rounded.toFixed(6).replace(/\.?0+$/, '') : String(rounded);
  return `${text}%`;
}
function isChineseLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized.startsWith('zh-hans');
}

export function durationText(value: number, language: string = 'zh'): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (isChineseLanguage(language)) {
    if (seconds === 0) return '0秒';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
    return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${rest ? `${rest}秒` : ''}`;
  }
  if (seconds === 0) return '0s';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${rest ? `${rest}s` : ''}`;
}

export function formatTurnDurationCompact(seconds: number, language: string = 'zh'): string {
  const isZh = isChineseLanguage(language);
  const prefix = isZh ? '本轮 ' : 'Turn ';
  if (!Number.isFinite(seconds) || seconds < 0) return `${prefix}0s`;
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${prefix}${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${prefix}${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${prefix}${minutes}m`;
}
