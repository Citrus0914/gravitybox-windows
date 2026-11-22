export interface AppConfig {
  schema: number;
  lastPage: number;
  navigationVersion?: number;
  hudEnabled: boolean;
  autoPricingSyncEnabled: boolean;
  syncAntigravityLifecycle: boolean;
  autoUpdateEnabled: boolean;
  lastCleanedVersion: string;
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
  hudEnabled?: boolean;
  version?: string;
  appVersion?: string;
  port?: number;
  targets?: number;
  windows?: number;
  message?: string;
  errors?: string[];
  runningTasks?: number;
  error?: string;
  lastError?: string;
  applicationChannel?: string;
  applicationLabel?: string;
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

export interface BreakdownModelEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedUsd: number;
}

export interface ProjectUsageBreakdown {
  id: string;
  name: string;
  workspacePath: string | null;
  conversationCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  cacheHitRate: number;
  lastActiveAt: number;
  topModels: BreakdownModelEntry[];
}

export interface ConversationUsageBreakdown {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  workspacePath: string | null;
  dbFiles: string[];
  subagentCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  cacheHitRate: number;
  firstActiveAt: number;
  lastActiveAt: number;
  byModel: BreakdownModelEntry[];
}

export interface UsageBreakdownData {
  period: string;
  snapshotId?: string;
  generatedAt: number;
  totals: {
    totalTokens: number;
    estimatedUsd: number;
    requestCount: number;
    projectCount: number;
    conversationCount: number;
  };
  projects: ProjectUsageBreakdown[];
  conversations: ConversationUsageBreakdown[];
}

export interface DashboardSummary {
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
  usageError?: string;
  generatedAt?: string;
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
