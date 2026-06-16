import { TestSuite, TestCase, ExecutionResult, SuiteExecutionResult, RunSummary } from './index';

export type TestCaseStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';

export type WorkerStatus = 'idle' | 'running' | 'disconnected' | 'unhealthy';

export interface TestShard {
  id: string;
  suiteId: string;
  suite: TestSuite;
  testCases: TestCase[];
  dependencyLevel: number;
  requiredVariables: string[];
  providedVariables: string[];
  dependsOnShards: string[];
}

export interface VariableDependency {
  variableName: string;
  providedByTestCase: string;
  consumedByTestCases: string[];
}

export interface VariableGraph {
  testCaseProvides: Map<string, string[]>;
  testCaseConsumes: Map<string, string[]>;
  variableProviders: Map<string, string>;
  variableConsumers: Map<string, string[]>;
  dependencies: [string, string][];
}

export interface ShardAssignment {
  shardId: string;
  suite: TestSuite;
  testCases: TestCase[];
  variables: Record<string, any>;
  environment?: {
    baseUrl?: string;
    variables?: Record<string, any>;
    headers?: Record<string, string>;
  };
}

export interface StatusUpdate {
  shardId: string;
  testCaseId: string;
  status: TestCaseStatus;
  duration?: number;
  startTime?: number;
  endTime?: number;
  assertions?: Array<{
    assertionId?: string;
    type: string;
    severity: string;
    passed: boolean;
    message: string;
    expected?: any;
    actual?: any;
  }>;
  extractedVariables?: Record<string, any>;
  error?: string;
  workerId: string;
}

export interface ShardComplete {
  shardId: string;
  workerId: string;
  results: ExecutionResult[];
  success: boolean;
  error?: string;
}

export interface SyncVariables {
  shardId: string;
  variables: Record<string, any>;
  sourceShardId: string;
}

export interface RetryAssignment {
  testCaseId: string;
  originalWorkerId: string;
  previousResults: ExecutionResult[];
  retryAttempt: number;
}

export interface WorkerInfo {
  id: string;
  status: WorkerStatus;
  currentShardId?: string;
  currentTestCaseId?: string;
  connectedAt: number;
  lastHeartbeat: number;
  failureCount: number;
  completedShards: number;
  ip?: string;
}

export interface CoordinatorStatus {
  startTime: number;
  totalTestCases: number;
  completedTestCases: number;
  passedTestCases: number;
  failedTestCases: number;
  skippedTestCases: number;
  errorTestCases: number;
  totalShards: number;
  completedShards: number;
  workers: WorkerInfo[];
  shards: Array<{
    id: string;
    suiteId: string;
    status: 'pending' | 'running' | 'completed' | 'error' | 'timeout';
    workerId?: string;
    testCaseCount: number;
    completedCount: number;
  }>;
}

export interface CoordinatorConfig {
  port: number;
  suitePaths: string[];
  shardTimeout: number;
  maxRetries: number;
  secret?: string;
  outputDir: string;
  htmlReport: boolean;
  jsonReport: boolean;
  junitReport: boolean;
  environmentFile?: string;
  configFile?: string;
  baseUrl?: string;
  variables?: Record<string, any>;
  tags?: string[];
  excludeTags?: string[];
  targetShardCount?: number;
}

export interface WorkerConfig {
  coordinatorUrl: string;
  workerId: string;
  secret?: string;
  concurrency?: number;
  environmentFile?: string;
  baseUrl?: string;
  variables?: Record<string, any>;
}

export type MessageType =
  | 'auth'
  | 'auth_success'
  | 'auth_failed'
  | 'assign_shard'
  | 'status_update'
  | 'shard_complete'
  | 'sync_variables'
  | 'retry_test'
  | 'worker_heartbeat'
  | 'no_more_shards'
  | 'execution_complete'
  | 'error';

export interface BaseMessage {
  type: MessageType;
}

export interface AuthMessage extends BaseMessage {
  type: 'auth';
  workerId: string;
  secret: string;
}

export interface AuthSuccessMessage extends BaseMessage {
  type: 'auth_success';
  workerId: string;
}

export interface AuthFailedMessage extends BaseMessage {
  type: 'auth_failed';
  reason: string;
}

export interface AssignShardMessage extends BaseMessage {
  type: 'assign_shard';
  assignment: ShardAssignment;
}

export interface StatusUpdateMessage extends BaseMessage {
  type: 'status_update';
  update: StatusUpdate;
}

export interface ShardCompleteMessage extends BaseMessage {
  type: 'shard_complete';
  complete: ShardComplete;
}

export interface SyncVariablesMessage extends BaseMessage {
  type: 'sync_variables';
  sync: SyncVariables;
}

export interface RetryTestMessage extends BaseMessage {
  type: 'retry_test';
  assignment: ShardAssignment;
  retry: RetryAssignment;
}

export interface WorkerHeartbeatMessage extends BaseMessage {
  type: 'worker_heartbeat';
  workerId: string;
  currentShardId?: string;
  currentTestCaseId?: string;
}

export interface NoMoreShardsMessage extends BaseMessage {
  type: 'no_more_shards';
}

export interface ExecutionCompleteMessage extends BaseMessage {
  type: 'execution_complete';
  summary: RunSummary;
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  message: string;
  code?: string;
}

export type CoordinatorMessage =
  | AuthSuccessMessage
  | AuthFailedMessage
  | AssignShardMessage
  | SyncVariablesMessage
  | RetryTestMessage
  | NoMoreShardsMessage
  | ExecutionCompleteMessage
  | ErrorMessage;

export type WorkerMessage =
  | AuthMessage
  | StatusUpdateMessage
  | ShardCompleteMessage
  | WorkerHeartbeatMessage
  | ErrorMessage;

export interface ShardExecutionState {
  shardId: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'timeout';
  workerId?: string;
  assignedAt?: number;
  completedAt?: number;
  lastStatusUpdate?: number;
  results: Map<string, ExecutionResult>;
  pendingVariables: Set<string>;
  testCaseStatus: Map<string, TestCaseStatus>;
  error?: string;
}

export interface MergedReportResult {
  runSummary: RunSummary;
  retrySupersededResults: ExecutionResult[];
  workerErrors: Array<{ workerId: string; error: string; timestamp: number }>;
  shardErrors: Array<{ shardId: string; workerId?: string; error: string; incompleteTestCases: string[] }>;
}
