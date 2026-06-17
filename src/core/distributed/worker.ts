import WebSocket from 'ws';
import chalk from 'chalk';
import {
  TestCase,
  TestSuite,
  ExecutionResult,
  RunSummary,
  AssertionResult,
  RunOptions,
  EnvironmentConfig,
} from '../../types';
import {
  WorkerConfig,
  ShardAssignment,
  StatusUpdate,
  ShardComplete,
  WorkerMessage,
  CoordinatorMessage,
  AuthMessage,
  AuthSuccessMessage,
  AuthFailedMessage,
  AssignShardMessage,
  StatusUpdateMessage,
  ShardCompleteMessage,
  SyncVariablesMessage,
  SyncVariables,
  RetryTestMessage,
  WorkerHeartbeatMessage,
  NoMoreShardsMessage,
  ExecutionCompleteMessage,
  ErrorMessage,
  TestCaseStatus,
  StealRequestMessage,
} from '../../types/distributed';
import { TestRunner } from '../runner';
import { VariableResolver } from '../variables';
import { HttpClient } from '../httpClient';
import { AuthManager } from '../auth';
import { AssertionEngine } from '../assertions';
import { ConfigParser } from '../parser';

const HEARTBEAT_INTERVAL = 10000;
const RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;
const STEAL_INTERVAL = 5000;
const DEFAULT_VARIABLE_TIMEOUT = 30000;
const VAR_REF_PATTERN = /\$\{([^}]+)\}/g;

export class TestWorker {
  private config: WorkerConfig;
  private ws!: WebSocket;
  private workerId: string;
  private authenticated: boolean = false;
  private currentShard?: ShardAssignment;
  private variableResolver: VariableResolver = new VariableResolver();
  private isRunning: boolean = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private stealTimer?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private resolveComplete!: (value: RunSummary | null) => void;
  private rejectComplete!: (reason: any) => void;
  private completionPromise: Promise<RunSummary | null>;
  private currentVariables: Record<string, any> = {};
  private variableResolveCallbacks: Map<string, Array<() => void>> = new Map();

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workerId = config.workerId;
    this.completionPromise = new Promise<RunSummary | null>((resolve, reject) => {
      this.resolveComplete = resolve;
      this.rejectComplete = reject;
    });
  }

  async start(): Promise<RunSummary | null> {
    console.log(chalk.cyan(`\n🔧 Worker ${this.workerId} 启动`));
    console.log(chalk.cyan(`   连接 Coordinator: ${this.config.coordinatorUrl}`));

    await this.connect();

    return this.completionPromise;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.coordinatorUrl);

        this.ws.on('open', () => {
          console.log(chalk.green(`✅ WebSocket 连接成功`));
          this.sendAuth();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message: CoordinatorMessage = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (e: any) {
            console.error(chalk.red(`❌ 解析消息失败: ${e.message}`));
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(chalk.yellow(`⚠️  连接关闭: ${code} ${reason}`));
          this.handleDisconnect();
        });

        this.ws.on('error', (error) => {
          console.error(chalk.red(`❌ 连接错误: ${error.message}`));
        });
      } catch (e: any) {
          reject(e);
        }
    });
  }

  private sendAuth(): void {
    const secret = this.config.secret || process.env.API_REGRESSION_SECRET || '';
    const message: AuthMessage = {
      type: 'auth',
      workerId: this.workerId,
      secret,
    };
    this.send(message);
  }

  private handleMessage(message: CoordinatorMessage): void {
    switch (message.type) {
      case 'auth_success':
        this.handleAuthSuccess(message as AuthSuccessMessage);
        break;
      case 'auth_failed':
        this.handleAuthFailed(message as AuthFailedMessage);
        break;
      case 'assign_shard':
        this.handleAssignShard(message as AssignShardMessage);
        break;
      case 'sync_variables':
        this.handleSyncVariables(message as SyncVariablesMessage);
        break;
      case 'retry_test':
        this.handleRetryTest(message as RetryTestMessage);
        break;
      case 'no_more_shards':
        this.handleNoMoreShards();
        break;
      case 'execution_complete':
        this.handleExecutionComplete(message as ExecutionCompleteMessage);
        break;
      case 'error':
        console.error(chalk.red(`❌ Coordinator 错误: ${(message as ErrorMessage).message}`));
        break;
    }
  }

  private handleAuthSuccess(message: AuthSuccessMessage): void {
    this.authenticated = true;
    console.log(chalk.green(`✅ 认证成功，Worker ID: ${message.workerId}`));
    this.startHeartbeat();
  }

  private handleAuthFailed(message: AuthFailedMessage): void {
    console.error(chalk.red(`❌ 认证失败: ${message.reason}`));
    this.ws.close();
    this.rejectComplete(new Error(`认证失败: ${message.reason}`));
  }

  private async handleAssignShard(message: AssignShardMessage): Promise<void> {
    const assignment = message.assignment;
    console.log(chalk.cyan(`📥 收到分片分配: ${assignment.shardId} (${assignment.testCases.length} 个用例)`));

    this.stopStealTimer();
    this.currentShard = assignment;
    this.currentVariables = { ...assignment.variables };

    if (assignment.environment?.variables) {
      this.currentVariables = {
        ...this.currentVariables,
        ...assignment.environment.variables,
      };
    }

    await this.executeShard(assignment);
  }

  private async handleSyncVariables(message: SyncVariablesMessage): Promise<void> {
    const sync = message.sync;
    console.log(chalk.blue(`🔄 收到变量同步，来源: ${sync.sourceShardId}`));
    console.log(chalk.blue(`   变量: ${Object.keys(sync.variables).join(', ')}`));

    for (const [key, value] of Object.entries(sync.variables)) {
      this.currentVariables[key] = value;
      this.variableResolver.addExtractedVar(key, value);

      const callbacks = this.variableResolveCallbacks.get(key);
      if (callbacks) {
        for (const cb of callbacks) {
          try { cb(); } catch { /* ignore */ }
        }
        this.variableResolveCallbacks.delete(key);
      }
    }
  }

  private async handleRetryTest(message: RetryTestMessage): Promise<void> {
    const assignment = message.assignment;
    const retry = message.retry;

    console.log(chalk.yellow(
      `🔄 收到重试任务: ${retry.testCaseId} (尝试 ${retry.retryAttempt})`
    ));

    this.stopStealTimer();
    this.currentShard = assignment;
    this.currentVariables = { ...assignment.variables };

    if (assignment.environment?.variables) {
      this.currentVariables = {
        ...this.currentVariables,
        ...assignment.environment.variables,
      };
    }

    await this.executeShard(assignment, retry.retryAttempt);
  }

  private handleNoMoreShards(): void {
    console.log(chalk.cyan('📭 没有更多分片，等待执行完成'));
    this.stopHeartbeat();
    this.startStealTimer();
  }

  private startStealTimer(): void {
    if (this.stealTimer) return;

    this.stealTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN && this.authenticated && !this.isRunning) {
        const stealMsg: StealRequestMessage = {
          type: 'steal_request',
          workerId: this.workerId,
        };
        this.send(stealMsg);
      }
    }, STEAL_INTERVAL);
  }

  private stopStealTimer(): void {
    if (this.stealTimer) {
      clearInterval(this.stealTimer);
      this.stealTimer = undefined;
    }
  }

  private handleExecutionComplete(message: ExecutionCompleteMessage): void {
    console.log(chalk.green('\n🎉 执行完成'));
    this.stopHeartbeat();
    this.stopStealTimer();
    this.ws.close();
    this.resolveComplete(message.summary);
  }

  private async executeShard(
    assignment: ShardAssignment,
    retryAttempt?: number
  ): Promise<void> {
    if (!this.currentShard) return;

    this.isRunning = true;

    const results: ExecutionResult[] = [];
    let success = true;
    let error: string | undefined;

    try {
      const resolver = new VariableResolver();

      resolver.setGlobalVars(this.currentVariables);

      if (assignment.environment?.variables) {
        resolver.setEnvironmentVars(assignment.environment.variables);
      }

      if (this.config.variables) {
        resolver.setGlobalVars({
          ...resolver['globalVars'],
          ...this.config.variables,
        });
      }

      if (assignment.environment?.baseUrl) {
        resolver.setEnvironmentVars({
          ...resolver['environmentVars'],
          base_url: assignment.environment.baseUrl,
        });
      }

      if (this.config.baseUrl) {
        resolver.setEnvironmentVars({
          ...resolver['environmentVars'],
          base_url: this.config.baseUrl,
        });
      }

      if (assignment.suite.before?.variables) {
        resolver.setSuiteVars(assignment.suite.before.variables);
      }

      if (assignment.suite.baseUrl) {
        resolver.setSuiteVars({
          ...resolver['suiteVars'],
          suite_base_url: assignment.suite.baseUrl,
        });
      }

      this.variableResolver = resolver;

      const sortedTestCases = this.sortTestCases(assignment.testCases, assignment.suite);

      const variableTimeout = (assignment.variableTimeout ?? this.config.variableTimeout ?? DEFAULT_VARIABLE_TIMEOUT);

      for (const testCase of sortedTestCases) {
        if (testCase.skip) {
          const skipResult = this.createSkippedResult(testCase, assignment.suite, '用例标记为跳过');
          results.push(skipResult);
          this.sendStatusUpdate(assignment.shardId, testCase.id, 'skipped');
          continue;
        }

        const requiredVars = this.extractRequiredVariables(testCase);
        const varsReady = await this.waitForVariables(requiredVars, variableTimeout);

        if (!varsReady) {
          const missingVars = requiredVars.filter(v => !(v in this.currentVariables));
          const skipResult = this.createSkippedResult(
            testCase,
            assignment.suite,
            `variable_timeout: 等待变量 [${missingVars.join(', ')}] 超时`
          );
          results.push(skipResult);
          this.sendStatusUpdate(assignment.shardId, testCase.id, 'skipped', undefined, undefined, undefined, undefined, undefined, 'variable_timeout');
          continue;
        }

        this.sendStatusUpdate(assignment.shardId, testCase.id, 'running');

        try {
          const result = await this.executeTestCase(testCase, assignment.suite, resolver);
          results.push(result);

          const status: TestCaseStatus = result.status;

          this.sendStatusUpdate(
            assignment.shardId,
            testCase.id,
            status,
            result.duration,
            result.startTime,
            result.endTime,
            result.assertions,
            result.extractedVariables
          );

          if (Object.keys(result.extractedVariables).length > 0) {
            for (const [key, value] of Object.entries(result.extractedVariables)) {
              resolver.addExtractedVar(key, value);
              this.variableResolver.addExtractedVar(key, value);
              this.currentVariables[key] = value;

              const callbacks = this.variableResolveCallbacks.get(key);
              if (callbacks) {
                for (const cb of callbacks) {
                  try { cb(); } catch { /* ignore */ }
                }
                this.variableResolveCallbacks.delete(key);
              }
            }
          }

          if (result.status === 'failed') {
            success = false;
          }
        } catch (e: any) {
          success = false;
          const errorResult: ExecutionResult = {
            testCaseId: testCase.id,
            testCaseName: testCase.name,
            suiteId: assignment.suite.id,
            suiteName: assignment.suite.name,
            status: 'failed',
            startTime: Date.now(),
            endTime: Date.now(),
            duration: 0,
            request: {
              method: testCase.request.method,
              url: testCase.request.url,
              headers: testCase.request.headers,
              body: testCase.request.body,
            },
            response: null,
            assertions: [
              {
                type: 'execution',
                severity: 'critical',
                passed: false,
                message: e.message || '执行失败',
              } as AssertionResult,
            ],
            extractedVariables: {},
            error: e.stack || e.message,
            retryAttempts: retryAttempt,
          };
          results.push(errorResult);
          this.sendStatusUpdate(
            assignment.shardId,
            testCase.id,
            'failed',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            e.message
          );
        }
      }
    } catch (e: any) {
      success = false;
      error = e.message || '分片执行失败';
      console.error(chalk.red(`❌ 分片执行失败: ${error}`));
    } finally {
      this.isRunning = false;

      const completeMessage: ShardCompleteMessage = {
        type: 'shard_complete',
        complete: {
          shardId: assignment.shardId,
          workerId: this.workerId,
          results,
          success,
          error,
        } as ShardComplete,
      };

      this.send(completeMessage);

      console.log(chalk.green(
        `✅ 分片 ${assignment.shardId} 执行完成，成功: ${success}`
      ));

      this.startStealTimer();
    }
  }

  private sortTestCases(testCases: TestCase[], suite: TestSuite): TestCase[] {
    const toposort = require('toposort');
    const graph: [string, string][] = [];
    const idToTest = new Map<string, TestCase>();
    const allIds = new Set<string>();

    for (const test of testCases) {
      idToTest.set(test.id, test);
      allIds.add(test.id);
    }

    for (const test of testCases) {
      const deps = test.dependsOn || [];
      for (const depId of deps) {
        if (allIds.has(depId)) {
          graph.push([depId, test.id]);
        }
      }
    }

    try {
      const sortedIds = toposort(graph);
      for (const id of allIds) {
        if (!sortedIds.includes(id)) {
          sortedIds.unshift(id);
        }
      }
      return sortedIds.map((id: string) => idToTest.get(id)!).filter(Boolean);
    } catch (e: any) {
      console.error(chalk.yellow(`⚠️  依赖排序失败，按原顺序执行: ${e.message}`));
      return testCases;
    }
  }

  private async executeTestCase(
    testCase: TestCase,
    suite: TestSuite,
    resolver: VariableResolver
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    const runOptions: RunOptions = {
      suitePaths: [],
      baseUrl: this.config.baseUrl,
      environmentFile: this.config.environmentFile,
      concurrency: 1,
      outputDir: './reports',
      htmlReport: false,
      jsonReport: false,
      junitReport: false,
      silent: true,
    };

    const runner = new TestRunner(runOptions);
    const parser = new ConfigParser();

    const suiteWithSingleTest: TestSuite = {
      ...suite,
      tests: [testCase],
    };

    const httpClient = runner.createHttpClient(suiteWithSingleTest);
    const authManager = runner.createAuthManager(resolver);
    const assertionEngine = runner.createAssertionEngine(
      resolver,
      './reports/snapshots',
      false
    );

    let envConfig: EnvironmentConfig | undefined;
    if (this.config.environmentFile) {
      envConfig = parser.parseEnvironment(this.config.environmentFile);
    }

    if (suiteWithSingleTest.auth?.type === 'oauth2_client_credentials') {
      try {
        await authManager.resolveAuthHeaderAsync(suiteWithSingleTest.auth);
      } catch (e: any) {
        throw new Error(`OAuth2 认证失败: ${e.message}`);
      }
    }

    const testNode = {
      test: testCase,
      expandedId: testCase.id,
      originalId: testCase.id,
    };

    const result = await runner.runTestCase(
      testNode,
      suiteWithSingleTest,
      resolver,
      httpClient,
      assertionEngine,
      authManager,
      envConfig
    );

    return result;
  }

  private extractRequiredVariables(testCase: TestCase): string[] {
    const required = new Set<string>();

    const walkObject = (obj: any): void => {
      if (obj === null || obj === undefined) return;
      if (typeof obj === 'string') {
        const matches = obj.match(VAR_REF_PATTERN);
        if (matches) {
          for (const match of matches) {
            const varName = match.slice(2, -1).trim();
            const cleanName = varName.includes(':')
              ? varName.split(':').slice(1).join(':')
              : varName;
            if (!varName.startsWith('process.env.') &&
                !varName.startsWith('env:') &&
                !varName.startsWith('global:') &&
                !varName.startsWith('suite:')) {
              required.add(cleanName);
            }
          }
        }
      } else if (Array.isArray(obj)) {
        obj.forEach(walkObject);
      } else if (typeof obj === 'object') {
        Object.values(obj).forEach(walkObject);
      }
    };

    walkObject(testCase.request);
    walkObject(testCase.assertions);
    walkObject(testCase.extracts);

    return Array.from(required);
  }

  private waitForVariables(varNames: string[], timeoutMs: number): Promise<boolean> {
    const missingVars = varNames.filter(v => !(v in this.currentVariables));
    if (missingVars.length === 0) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let pendingCount = missingVars.length;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          for (const v of missingVars) {
            const callbacks = this.variableResolveCallbacks.get(v);
            if (callbacks) {
              const idx = callbacks.indexOf(onVarResolved);
              if (idx > -1) callbacks.splice(idx, 1);
            }
          }
          resolve(false);
        }
      }, timeoutMs);

      const onVarResolved = () => {
        if (resolved) return;
        pendingCount--;
        if (pendingCount <= 0) {
          resolved = true;
          clearTimeout(timeout);
          resolve(true);
        }
      };

      for (const v of missingVars) {
        if (!this.variableResolveCallbacks.has(v)) {
          this.variableResolveCallbacks.set(v, []);
        }
        this.variableResolveCallbacks.get(v)!.push(onVarResolved);
      }
    });
  }

  private createSkippedResult(
    testCase: TestCase,
    suite: TestSuite,
    reason: string
  ): ExecutionResult {
    const now = Date.now();
    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      suiteId: suite.id,
      suiteName: suite.name,
      status: 'skipped',
      startTime: now,
      endTime: now,
      duration: 0,
      request: {
        method: testCase.request.method,
        url: testCase.request.url,
        headers: testCase.request.headers,
        body: testCase.request.body,
      },
      response: null,
      assertions: [],
      extractedVariables: {},
      skippedReason: reason,
    };
  }

  private sendStatusUpdate(
    shardId: string,
    testCaseId: string,
    status: TestCaseStatus,
    duration?: number,
    startTime?: number,
    endTime?: number,
    assertions?: ExecutionResult['assertions'],
    extractedVariables?: Record<string, any>,
    error?: string
  ): void {
    const update: StatusUpdate = {
      shardId,
      testCaseId,
      status,
      duration,
      startTime,
      endTime,
      assertions: assertions?.map((a: AssertionResult) => ({
        assertionId: a.assertionId,
        type: a.type,
        severity: a.severity,
        passed: a.passed,
        message: a.message,
        expected: a.expected,
        actual: a.actual,
      })),
      extractedVariables,
      error,
      workerId: this.workerId,
    };

    const message: StatusUpdateMessage = {
      type: 'status_update',
      update,
    };

    this.send(message);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN && this.authenticated) {
        const heartbeat: WorkerHeartbeatMessage = {
          type: 'worker_heartbeat',
          workerId: this.workerId,
          currentShardId: this.currentShard?.shardId,
          currentTestCaseId: this.isRunning ? this.currentShard?.testCases[0]?.id : undefined,
        };
        this.send(heartbeat);
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      console.log(chalk.yellow(
        `🔄 尝试重连 (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
      ));

      setTimeout(async () => {
        try {
          await this.connect();
        } catch (e: any) {
          console.error(chalk.red(`❌ 重连失败: ${e.message}`));
          this.handleDisconnect();
        }
      }, RECONNECT_INTERVAL);
    } else {
      console.error(chalk.red(`❌ 重连次数超过最大值，退出`));
      this.rejectComplete(new Error('连接断开，重连失败'));
    }
  }

  private send(message: WorkerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  stop(): void {
    this.stopHeartbeat();
    this.stopStealTimer();
    this.ws.close();
  }
}
