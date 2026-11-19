import zhHans from '../../assets/i18n/zh-Hans.json';
import en from '../../assets/i18n/en.json';

export type ResolvedLocale = 'zh-Hans' | 'en';

const zhApp: Record<string, string> = zhHans.app as Record<string, string>;
const enApp: Record<string, string> = en.app as Record<string, string>;

const WINDOWS_OVERRIDES: Record<ResolvedLocale, Record<string, string>> = {
  'zh-Hans': {
    'about.reveal_data': '在资源管理器中显示',
    'settings.language.subtitle': '仅控制 GravityBox 控制台与对话状态栏 (HUD) 的显示语言，不改动 Antigravity 界面',
    'settings.login.subtitle': '登录 Windows 时自动在系统托盘驻留',
    'maintenance.reveal_btn': '在资源管理器中查看',
  },
  en: {
    'about.reveal_data': 'Show in Explorer',
    'settings.language.subtitle': 'Sets display language for GravityBox and Session HUD only without affecting Antigravity',
    'settings.login.subtitle': 'Launch automatically in the system tray at Windows sign-in',
    'maintenance.reveal_btn': 'Show in Explorer',
  },
};

export function resolveLocaleFromPreference(
  configured: string | null | undefined,
  systemLocales: string[] = [],
): ResolvedLocale {
  const c = (configured ?? '').trim().toLowerCase();
  if (c === 'en' || c.startsWith('en-')) return 'en';
  if (c === 'zh-hans' || c === 'zh-cn' || c === 'zh') return 'zh-Hans';
  const candidates = systemLocales.length > 0 ? systemLocales : [navigator.language || 'zh-CN'];
  for (const loc of candidates) {
    const low = loc.toLowerCase();
    if (low.startsWith('zh')) return 'zh-Hans';
    if (low.startsWith('en')) return 'en';
  }
  return 'zh-Hans';
}

export function translate(
  locale: ResolvedLocale,
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
): string {
  const winOverride = WINDOWS_OVERRIDES[locale]?.[key];
  const primary = locale === 'en' ? enApp[key] : zhApp[key];
  const secondary = enApp[key] ?? zhApp[key];
  let template = winOverride ?? primary ?? secondary ?? fallback ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}
