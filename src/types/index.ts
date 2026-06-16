export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AuthType = 'bearer' | 'basic' | 'oauth2_client_credentials' | 'none';

export interface BearerAuthConfig {
  type: 'bearer';
  token: string;
}

export interface BasicAuthConfig {
  type: 'basic';
  username: string;
  password: string;
}

export interface OAuth2ClientCredentialsConfig {
  type: 'oauth2_client_credentials';
  token_url: string;
  client_id: string;
  client_secret: string;
  scope?: string;
  header_prefix?: string;
}

export type AuthConfig = BearerAuthConfig | BasicAuthConfig | OAuth2ClientCredentialsConfig | { type: 'none' };

export interface HookConfig {
  request: RequestConfig;
  extracts?: ExtractConfig[];
}

export type AssertionOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'notExists'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'type';

export interface ExtractConfig {
  name: string;
  from: 'status' | 'body' | 'headers' | 'cookies';
  path?: string;
  header?: string;
  cookie?: string;
}

export interface AssertionConfig {
  id?: string;
  severity?: SeverityLevel;
  statusCode?: number;
  responseTime?: number;
  jsonPath?: {
    path: string;
    operator: AssertionOperator;
    expected?: any;
  };
  jsonSchema?: Record<string, any>;
  headerExists?: string;
  headerEquals?: {
    name: string;
    value: string | number | boolean;
  };
  bodyContains?: string;
  contract?: {
    snapshotPath?: string;
    strict?: boolean;
  };
  description?: string;
}

export interface RequestConfig {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  queryParams?: Record<string, any>;
  timeout?: number;
  followRedirects?: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  dependsOn?: string[];
  request: RequestConfig;
  extracts?: ExtractConfig[];
  assertions: AssertionConfig[];
  dataSource?: {
    file: string;
    type: 'csv' | 'json';
    varPrefix?: string;
  };
  retry?: {
    maxAttempts: number;
    delayMs?: number;
  };
  skip?: boolean;
  auth?: AuthConfig;
}

export interface TestSuite {
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  filePath?: string;
  defaults?: {
    headers?: Record<string, string>;
    timeout?: number;
    retry?: TestCase['retry'];
  };
  before?: {
    variables?: Record<string, any>;
  };
  setup?: HookConfig;
  teardown?: HookConfig;
  auth?: AuthConfig;
  tests: TestCase[];
}

export interface EnvironmentConfig {
  name: string;
  baseUrl: string;
  variables?: Record<string, any>;
  headers?: Record<string, string>;
  auth?: AuthConfig;
}

export interface GlobalConfig {
  concurrency?: number;
  timeout?: number;
  retries?: number;
  variables?: Record<string, any>;
  headers?: Record<string, string>;
  output?: {
    html?: string;
    json?: string;
    junit?: string;
    snapshots?: string;
    failed?: string;
  };
}

export interface AssertionResult {
  assertionId?: string;
  type: string;
  severity: SeverityLevel;
  passed: boolean;
  message: string;
  expected?: any;
  actual?: any;
  diff?: any;
  description?: string;
}

export interface ExecutionResult {
  testCaseId: string;
  testCaseName: string;
  suiteId: string;
  suiteName: string;
  status: 'passed' | 'failed' | 'skipped';
  startTime: number;
  endTime: number;
  duration: number;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
    time: number;
  } | null;
  assertions: AssertionResult[];
  extractedVariables: Record<string, any>;
  skippedReason?: string;
  error?: string;
  dataRow?: Record<string, any>;
  dataRowIndex?: number;
  retryAttempts?: number;
}

export interface HookExecutionResult {
  name: 'setup' | 'teardown';
  status: 'passed' | 'failed' | 'skipped';
  startTime: number;
  endTime: number;
  duration: number;
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
    time: number;
  } | null;
  extractedVariables: Record<string, any>;
  error?: string;
  message?: string;
}

export interface SuiteExecutionResult {
  suiteId: string;
  suiteName: string;
  startTime: number;
  endTime: number;
  duration: number;
  testResults: ExecutionResult[];
  setupResult?: HookExecutionResult;
  teardownResult?: HookExecutionResult;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

export interface RunOptions {
  suitePaths: string[];
  environment?: string;
  environmentFile?: string;
  globalConfigFile?: string;
  tags?: string[];
  excludeTags?: string[];
  concurrency?: number;
  onlyFailed?: boolean;
  failedFile?: string;
  outputDir?: string;
  htmlReport?: boolean;
  jsonReport?: boolean;
  junitReport?: boolean;
  updateSnapshots?: boolean;
  baseUrl?: string;
  variables?: Record<string, any>;
  stopOnFailure?: boolean;
  verbose?: boolean;
  silent?: boolean;
  ciExitCode?: boolean;
}

export interface RunSummary {
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  duration: number;
  startTime: number;
  endTime: number;
  suiteResults: SuiteExecutionResult[];
}

export type VariableSource = 'environment' | 'global' | 'suite' | 'extracted' | 'runtime';

export interface ContractDiff {
  type: 'added' | 'removed' | 'changed' | 'typeChanged';
  path: string;
  oldValue?: any;
  newValue?: any;
  oldType?: string;
  newType?: string;
}
