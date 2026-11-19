export interface AppConfig {
  schema: number;
  lastPage: number;
  navigationVersion?: number;
  quotaRefreshMinutes: number;
  hudEnabled: boolean;
  translationEnabled?: boolean;
  autoPricingSyncEnabled: boolean;
  syncAntigravityLifecycle: boolean;
  autoUpdateEnabled: boolean;
  lastCleanedVersion: string;
  accountsCollapsed: boolean;
  menuSelectedTab: number;
  menuUsagePeriod: number;
  menuTrendMetric: 'tokens' | 'requests';
  applicationChannel: string;
  appLanguage?: string | null;
}

export interface AppRuntimeInfo {
  version: string;
  stateDir: string;
  pipeEndpoint: string;
  antigravityDir: string;
  antigravityInstalled: boolean;
  antigravityRunning: boolean;
  systemLocales: string[];
  autoStart: boolean;
  coreFound: boolean;
  nodeFound: boolean;
}

export interface StatusSnapshot {
  mode?: string;
  locale?: string;
  configuredLanguage?: string;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  version?: string;
  appVersion?: string;
  port?: number;
  targets?: number;
  windows?: number;
  message?: string;
  dictionaryError?: string;
  errors?: string[];
  runningTasks?: number;
  error?: string;
  lastError?: string;
  oauthClientConfigured?: boolean;
  applicationChannel?: string;
  applicationLabel?: string;
  accountSwitchSupported?: boolean;
  activeAccountEmail?: string;
  activeFiveHourQuota?: number | null;
  activeSubscriptionTier?: string;
  liveAccountEmail?: string | null;
  accountsRevision?: string;
  updatedAt?: string;
  rssMB?: number;
  [key: string]: unknown;
}

export interface TaskItem {
  id: string;
  kind: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  done?: number;
  total?: number;
  result?: { ok?: boolean; message?: string; [key: string]: unknown };
  error?: string;
}

export interface QuotaGroupWindow {
  id?: string;
  key?: string;
  label?: string;
  period?: '5h' | 'weekly' | 'daily' | string;
  remaining?: number | null;
  percentage?: number | null;
  known?: boolean;
  resetTime?: number | null;
  resetCountdown?: string;
  stale?: boolean;
}

export interface QuotaGroup {
  key?: string;
  id?: string;
  displayName?: string;
  summaryLabel?: string;
  title?: string;
  label?: string;
  family?: string;
  brands?: string[];
  isStandalone?: boolean;
  availability?: string;
  quotaState?: string;
  message?: string;
  windows?: QuotaGroupWindow[];
  percentage?: number | null;
  resetCountdown?: string;
  stale?: boolean;
}

export type StaleGroupEntry = string | { name?: string; observed_at?: number };

export interface AccountItem {
  id: string;
  email: string;
  name?: string;
  disabled?: boolean;
  validation_blocked?: boolean;
  subscription_tier?: string;
  quota_last_updated?: number;
  quotaLastUpdated?: number;
  quota_refresh_error?: string;
  fiveHourRemaining?: number | null;
  weeklyRemaining?: number | null;
  geminiFiveHourRemaining?: number | null;
  geminiWeeklyRemaining?: number | null;
  geminiFiveHourResetCountdown?: string;
  geminiWeeklyResetCountdown?: string;
  claudeFiveHourRemaining?: number | null;
  claudeWeeklyRemaining?: number | null;
  claudeFiveHourResetCountdown?: string;
  claudeWeeklyResetCountdown?: string;
  argonWeeklyRemaining?: number | null;
  argonWeeklyResetCountdown?: string;
  carbonWeeklyRemaining?: number | null;
  carbonWeeklyResetCountdown?: string;
  staleGroups?: StaleGroupEntry[];
  stale_groups?: StaleGroupEntry[];
  quotaGroups?: QuotaGroup[];
  quotaWarnings?: string[];
  credentialReadiness?: { state?: string; message?: string };
  quota?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ModelUsageEntry {
  model: string;
  promptTokens?: number;
  candidatesTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  requestCount: number;
  estimatedUsd: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  pricingStatus?: string;
  pricingProvenance?: string | null;
}

export interface HourlyTrendPoint {
  hour: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  request_count: number;
}

export interface DailyTrendPoint {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  request_count: number;
}

export interface UsagePeriodData {
  period: string;
  snapshotId?: string;
  selectedAccountId?: string;
  availableAccounts?: Array<{
    id: string;
    label: string;
    email?: string;
    name?: string | null;
    type?: 'all' | 'account';
    total_tokens?: number;
    request_count?: number;
  }>;
  summary: {
    totalTokens: number;
    promptTokens: number;
    candidatesTokens: number;
    cachedTokens: number;
    cacheWriteTokens?: number;
    requestCount: number;
    estimatedUsd: number;
    cacheHitRate: number;
    databasesScanned?: number;
    databasesDiscovered?: number;
    pricedModels?: number;
    unpricedModels?: number;
    hasError?: boolean;
    availability?: string;
    lastScannedAt?: number;
    [key: string]: unknown;
  };
  byModel: ModelUsageEntry[];
  dailyTrends: DailyTrendPoint[];
  todayHourly: HourlyTrendPoint[];
}

export interface DashboardSummary {
  dictionary?: {
    total?: number;
    dictionaryTotal?: number;
    covered?: number;
    translated?: number;
    verified?: number;
    extracted?: number;
    missing?: number;
    coverageAvailable?: boolean;
  };
  accounts?: {
    total?: number;
    currentAccountId?: string | null;
    activeEmail?: string;
    activeName?: string;
    activeTier?: string;
    isLiveVerified?: boolean;
    quotaLastUpdated?: number | null;
    autoSwitchEnabled?: boolean;
    geminiFiveHourRemaining?: number | null;
    geminiWeeklyRemaining?: number | null;
    geminiFiveHourResetCountdown?: string;
    geminiWeeklyResetCountdown?: string;
    claudeFiveHourRemaining?: number | null;
    claudeWeeklyRemaining?: number | null;
    claudeFiveHourResetCountdown?: string;
    claudeWeeklyResetCountdown?: string;
    argonWeeklyRemaining?: number | null;
    argonWeeklyResetCountdown?: string;
    carbonWeeklyRemaining?: number | null;
    carbonWeeklyResetCountdown?: string;
    staleGroups?: StaleGroupEntry[];
    quotaGroups?: QuotaGroup[];
    quotaRefreshError?: string;
    quotaWarnings?: string[];
    [key: string]: unknown;
  } | null;
  usage?: {
    todayTokens?: number;
    totalTokens?: number;
    estimatedUsd?: number;
    allTimeEstimatedUsd?: number;
    requestCount?: number;
    totalRequestCount?: number;
    todayPricedModels?: number;
    todayUnpricedModels?: number;
    todayHourly?: HourlyTrendPoint[];
    todayByModel?: ModelUsageEntry[];
    periods?: Record<string, UsagePeriodData>;
    [key: string]: unknown;
  } | null;
  accountsError?: string;
  usageError?: string;
  generatedAt?: string;
}

export interface AutoSwitchConfig {
  enabled: boolean;
  strategy?: 'priority' | 'round_robin' | string;
  monitored_model?: string;
  monitoredGroup?: string;
  reserve_percentage?: number;
  reservePercentage?: number;
  reserveThresholdPct?: number;
  candidate_min_percentage?: number;
  candidateMinPercentage?: number;
  candidateMinPct?: number;
  candidate_account_ids?: string[];
  last_switched_id?: string;
  [key: string]: unknown;
}

export interface MaintenanceScanResult {
  ok?: boolean;
  running?: boolean;
  safeBytes?: number;
  statefulBytes?: number;
  protectedBytes?: number;
  totalBytes?: number;
  retentionDays?: number;
  buckets?: {
    runtimeCache?: {
      id: string;
      bytes: number;
      clearableBytes: number;
      fileCount: number;
      available: boolean;
    };
    historyLogs?: {
      id: string;
      bytes: number;
      clearableBytes: number;
      fileCount: number;
      retentionDays: number;
      available: boolean;
    };
  };
  latestRestorableSnapshot?: {
    id: string;
    at?: number;
    timestamp?: string;
    totalBytes?: number;
    fileCount?: number;
    snapshotPath?: string;
  } | null;
  [key: string]: unknown;
}
