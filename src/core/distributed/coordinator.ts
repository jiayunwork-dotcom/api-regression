import http from 'http';
import WebSocket from 'ws';
import url from 'url';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import {
  TestSuite,
  TestCase,
  ExecutionResult,
  RunSummary,
  EnvironmentConfig,
  GlobalConfig,
} from '../../types';
import {
  CoordinatorConfig,
  TestShard,
  WorkerInfo,
  WorkerStatus,
  CoordinatorStatus,
  ShardAssignment,
  StatusUpdate,
  ShardComplete,
  SyncVariables,
  RetryAssignment,
  CoordinatorMessage,
  WorkerMessage,
  AuthMessage,
  StatusUpdateMessage,
  ShardCompleteMessage,
  WorkerHeartbeatMessage,
  StealRequestMessage,
  AssignShardMessage,
  SyncVariablesMessage,
  RetryTestMessage,
  ExecutionCompleteMessage,
  AuthSuccessMessage,
  AuthFailedMessage,
  NoMoreShardsMessage,
  ErrorMessage,
  MergedReportResult,
  ShardExecutionState,
  EventMessage,
  TestCaseInShard,
  TestCaseStatus,
} from '../../types/distributed';
import { ShardManager } from './shardManager';
import { ReportMerger } from './reportMerger';
import { ReportGenerator } from '../reporter';

const MAX_WORKER_FAILURES = 3;
const HEARTBEAT_TIMEOUT = 30000;
const SHARD_TIMEOUT_DEFAULT = 300000;

interface WorkerConnection {
  id: string;
  ws: WebSocket;
  info: WorkerInfo;
  authenticated: boolean;
}

export class TestCoordinator {
  private config: CoordinatorConfig;
  private server: http.Server;
  private wss: WebSocket.Server;
  private eventWss: WebSocket.Server;
  private shardManager: ShardManager;
  private workers: Map<string, WorkerConnection> = new Map();
  private eventClients: Set<WebSocket> = new Set();
  private shards: TestShard[] = [];
  private availableVariables: Record<string, any> = {};
  private reportMerger!: ReportMerger;
  private startTime: number = 0;
  private retryQueue: Array<{
    testCase: TestCase;
    suite: TestSuite;
    originalResult: ExecutionResult;
    retryAttempt: number;
    originalWorkerId: string;
  }> = [];
  private allVariables: Record<string, any> = {};
  private environment?: EnvironmentConfig;
  private globalConfig: GlobalConfig = {};
  private timer?: NodeJS.Timeout;
  private isComplete: boolean = false;
  private resolveComplete!: (value: RunSummary) => void;
  private rejectComplete!: (reason: any) => void;
  private completionPromise: Promise<RunSummary>;

  constructor(config: CoordinatorConfig) {
    this.config = config;

    this.shardManager = new ShardManager(config.suitePaths, {
      environmentFile: config.environmentFile,
      configFile: config.configFile,
      variables: config.variables,
      tags: config.tags,
      excludeTags: config.excludeTags,
    });

    this.environment = this.shardManager.getEnvironment();
    this.globalConfig = this.shardManager.getGlobalConfig();
    this.allVariables = this.shardManager.getGlobalVariables();
    if (this.environment?.variables) {
      this.allVariables = { ...this.allVariables, ...this.environment.variables };
    }
    if (config.baseUrl) {
      this.allVariables.base_url = config.baseUrl;
    }

    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocket.Server({ noServer: true });
    this.eventWss = new WebSocket.Server({ noServer: true });

    this.completionPromise = new Promise<RunSummary>((resolve, reject) => {
      this.resolveComplete = resolve;
      this.rejectComplete = reject;
    });
  }

  async start(): Promise<RunSummary> {
    this.startTime = Date.now();

    this.shards = this.shardManager.createShards(this.config.targetShardCount);

    const workerInfoMap = new Map<string, WorkerInfo>();
    for (const [, worker] of this.workers) {
      workerInfoMap.set(worker.id, worker.info);
    }

    const shardStateMap = new Map<string, ShardExecutionState>();
    for (const s of this.shardManager.getShards()) {
      const state = this.shardManager.getShardState(s.id);
      if (state) {
        shardStateMap.set(s.id, state);
      }
    }

    this.reportMerger = new ReportMerger(
      this.shards,
      shardStateMap,
      workerInfoMap,
      this.startTime
    );

    if (this.shards.length === 0) {
      throw new Error('没有可执行的测试用例');
    }

    const totalTests = this.shardManager.getTotalTestCaseCount();
    console.log(chalk.cyan(`\n📦 分布式测试协调器启动`));
    console.log(chalk.cyan(`   端口: ${this.config.port}`));
    console.log(chalk.cyan(`   分片数: ${this.shards.length}`));
    console.log(chalk.cyan(`   测试用例总数: ${totalTests}`));
    console.log(chalk.cyan(`   分片超时: ${(this.config.shardTimeout || SHARD_TIMEOUT_DEFAULT) / 1000}s`));
    console.log(chalk.cyan(`   最大重试次数: ${this.config.maxRetries}`));
    console.log(chalk.yellow(`\n⏳ 等待 Worker 连接...\n`));

    this.server.on('upgrade', (request, socket, head) => {
      const parsedUrl = url.parse(request.url || '');
      const pathname = parsedUrl.pathname;
      if (pathname === '/ws' || pathname === '/' || pathname === '') {
        this.wss.handleUpgrade(request, socket, head, ws => {
          this.handleWebSocketConnection(ws, request);
        });
      } else if (pathname === '/events') {
        this.eventWss.handleUpgrade(request, socket, head, ws => {
          this.handleEventClientConnection(ws);
        });
      } else {
        socket.destroy();
      }
    });

    this.server.listen(this.config.port, () => {
      console.log(chalk.green(`✅ Coordinator 服务已启动: ws://0.0.0.0:${this.config.port}/ws`));
      console.log(chalk.green(`   事件推送: ws://0.0.0.0:${this.config.port}/events`));
      console.log(chalk.green(`   状态接口: http://0.0.0.0:${this.config.port}/status\n`));
    });

    this.timer = setInterval(() => this.checkTimeouts(), 5000);

    return this.completionPromise;
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = url.parse(req.url || '/', true);

    if (req.method === 'GET' && parsedUrl.pathname === '/status') {
      const status = this.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', uptime: Date.now() - this.startTime }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const tempId = uuidv4();

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const message: WorkerMessage = JSON.parse(data.toString());
        this.handleWorkerMessage(tempId, message, ws);
      } catch (e: any) {
        console.error(chalk.red(`❌ 解析消息失败: ${e.message}`));
        this.sendMessage(ws, {
          type: 'error',
          message: `消息解析失败: ${e.message}`,
        } as ErrorMessage);
      }
    });

    ws.on('close', () => {
      this.handleWorkerDisconnect(tempId);
    });

    ws.on('error', (error) => {
      console.error(chalk.red(`❌ Worker 连接错误: ${error.message}`));
      this.handleWorkerDisconnect(tempId);
    });
  }

  private handleEventClientConnection(ws: WebSocket): void {
    this.eventClients.add(ws);

    const snapshot = this.createSnapshotEvent();
    this.sendEventToClient(ws, snapshot);

    ws.on('close', () => {
      this.eventClients.delete(ws);
    });

    ws.on('error', () => {
      this.eventClients.delete(ws);
    });
  }

  private broadcastEvent(event: EventMessage): void {
    for (const client of this.eventClients) {
      this.sendEventToClient(client, event);
    }
  }

  private sendEventToClient(ws: WebSocket, event: EventMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private createSnapshotEvent(): EventMessage {
    const status = this.getStatus();
    return {
      event: 'snapshot',
      timestamp: Date.now(),
      status,
    };
  }

  private handleWorkerMessage(
    tempId: string,
    message: WorkerMessage,
    ws: WebSocket
  ): void {
    if (message.type === 'auth') {
      this.handleAuth(tempId, message as AuthMessage, ws);
      return;
    }

    const worker = this.workers.get(tempId);
    if (!worker || !worker.authenticated) {
      this.sendMessage(ws, {
        type: 'auth_failed',
        reason: '未认证',
      } as AuthFailedMessage);
      ws.close();
      return;
    }

    switch (message.type) {
      case 'status_update':
        this.handleStatusUpdate(worker.id, message as StatusUpdateMessage);
        break;
      case 'shard_complete':
        this.handleShardComplete(worker.id, message as ShardCompleteMessage);
        break;
      case 'worker_heartbeat':
        this.handleHeartbeat(worker.id, message as WorkerHeartbeatMessage);
        break;
      case 'steal_request':
        this.handleStealRequest(worker.id, message as StealRequestMessage);
        break;
      case 'error':
        console.error(chalk.red(`❌ Worker ${worker.id} 错误: ${(message as ErrorMessage).message}`));
        break;
    }
  }

  private handleAuth(tempId: string, message: AuthMessage, ws: WebSocket): void {
    const expectedSecret = this.config.secret || process.env.API_REGRESSION_SECRET;
    if (expectedSecret && message.secret !== expectedSecret) {
      console.log(chalk.yellow(`⚠️  Worker ${message.workerId} 认证失败: secret 不匹配`));
      this.sendMessage(ws, {
        type: 'auth_failed',
        reason: 'Secret 不匹配',
      } as AuthFailedMessage);
      ws.close();
      return;
    }

    const workerExists = this.getWorkerById(message.workerId);
    if (workerExists) {
      console.log(chalk.yellow(`⚠️  Worker ID 重复: ${message.workerId}，拒绝连接`));
      this.sendMessage(ws, {
        type: 'auth_failed',
        reason: 'Worker ID 已存在',
      } as AuthFailedMessage);
      ws.close();
      return;
    }

    const workerInfo: WorkerInfo = {
      id: message.workerId,
      status: 'idle',
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      failureCount: 0,
      completedShards: 0,
      ip: (ws as any)._socket?.remoteAddress,
    };

    this.workers.set(tempId, {
      id: message.workerId,
      ws,
      info: workerInfo,
      authenticated: true,
    });

    console.log(chalk.green(`✅ Worker ${message.workerId} 已连接`));

    this.sendMessage(ws, {
      type: 'auth_success',
      workerId: message.workerId,
    } as AuthSuccessMessage);

    this.broadcastEvent({
      event: 'worker_joined',
      timestamp: Date.now(),
      worker: { ...workerInfo },
    });

    this.assignNextShard(message.workerId);
  }

  private handleStatusUpdate(workerId: string, message: StatusUpdateMessage): void {
    const update = message.update;
    const worker = this.getWorkerById(workerId);
    if (!worker) return;

    worker.info.lastHeartbeat = Date.now();
    worker.info.currentTestCaseId = update.testCaseId;

    const state = this.shardManager.getShardState(update.shardId);
    const shard = this.shardManager.getShard(update.shardId);
    if (state) {
      state.lastStatusUpdate = Date.now();
      state.testCaseStatus.set(update.testCaseId, update.status);

      const isCompleted = update.status === 'passed' || update.status === 'failed' || update.status === 'skipped' || update.status === 'error';
      if (isCompleted) {
        const testCase = shard?.testCases.find(tc => tc.id === update.testCaseId);
        this.broadcastEvent({
          event: 'test_completed',
          timestamp: Date.now(),
          shardId: update.shardId,
          testCaseId: update.testCaseId,
          testCaseName: testCase?.name || update.testCaseId,
          status: update.status,
          duration: update.duration,
          workerId,
        });

        const existingResult = state.results.get(update.testCaseId);
        if (existingResult && existingResult.retryAttempts) {
          const markedResult = {
            ...existingResult,
            status: 'passed' as const,
            retryAttempts: existingResult.retryAttempts,
          };
          this.reportMerger.addRetrySuperseded(update.testCaseId, markedResult);
        }
      }

      if (update.extractedVariables && Object.keys(update.extractedVariables).length > 0) {
        this.handleExtractedVariables(update.shardId, update.extractedVariables);
      }
    }
  }

  private handleExtractedVariables(shardId: string, variables: Record<string, any>): void {
    for (const [key, value] of Object.entries(variables)) {
      this.allVariables[key] = value;
      this.availableVariables[key] = value;
    }

    this.shardManager.updateVariableAvailability(shardId, variables);

    const shard = this.shardManager.getShard(shardId);
    if (!shard) return;

    for (const [, worker] of this.workers) {
      const workerState = this.shardManager.getShardState(shardId);
      if (!workerState || workerState.workerId !== worker.id) {
        const otherShards = this.shards.filter(s =>
          s.requiredVariables.some(v => v in variables)
        );

        for (const otherShard of otherShards) {
          const otherState = this.shardManager.getShardState(otherShard.id);
          if (otherState && otherState.workerId === worker.id && otherState.status === 'running') {
            this.sendMessage(worker.ws, {
              type: 'sync_variables',
              sync: {
                shardId: otherShard.id,
                variables,
                sourceShardId: shardId,
              },
            } as SyncVariablesMessage);
          }
        }
      }
    }

    this.assignReadyShards();
  }

  private handleShardComplete(workerId: string, message: ShardCompleteMessage): void {
    const complete = message.complete;
    const worker = this.getWorkerById(workerId);
    if (!worker) return;

    worker.info.lastHeartbeat = Date.now();
    worker.info.status = 'idle';
    worker.info.currentShardId = undefined;
    worker.info.currentTestCaseId = undefined;

    const state = this.shardManager.getShardState(complete.shardId);
    const shard = this.shardManager.getShard(complete.shardId);

    if (!state || !shard) {
      console.log(chalk.yellow(`⚠️  收到未知分片 ${complete.shardId} 的完成消息`));
      this.assignNextShard(workerId);
      return;
    }

    if (complete.success) {
      state.status = 'completed';
      state.completedAt = Date.now();
      worker.info.completedShards++;

      for (const result of complete.results) {
        state.results.set(result.testCaseId, result);
        state.testCaseStatus.set(result.testCaseId, result.status);
        this.reportMerger.addFinalResult(result.testCaseId, result);

        if (Object.keys(result.extractedVariables).length > 0) {
          this.handleExtractedVariables(complete.shardId, result.extractedVariables);
        }
      }

      console.log(chalk.green(`✅ 分片 ${complete.shardId} 执行完成 (Worker: ${workerId})`));
    } else {
      state.status = 'error';
      state.error = complete.error || '未知错误';
      worker.info.failureCount++;

      if (worker.info.failureCount >= MAX_WORKER_FAILURES) {
        worker.info.status = 'unhealthy';
        console.log(chalk.red(`❌ Worker ${workerId} 失败次数过多，标记为不健康`));
        this.reportMerger.addWorkerError(workerId, `失败次数超过 ${MAX_WORKER_FAILURES} 次，标记为不健康`);
      }

      console.log(chalk.red(`❌ 分片 ${complete.shardId} 执行失败: ${complete.error} (Worker: ${workerId})`));

      for (const tc of shard.testCases) {
        if (!state.results.has(tc.id)) {
          if (this.config.maxRetries > 0) {
            const existingResult = state.results.get(tc.id);
            if (existingResult) {
              this.retryQueue.push({
                testCase: tc,
                suite: shard.suite,
                originalResult: existingResult,
                retryAttempt: (existingResult.retryAttempts || 0) + 1,
                originalWorkerId: workerId,
              });
            } else {
              const fakeResult: ExecutionResult = {
                testCaseId: tc.id,
                testCaseName: tc.name,
                suiteId: shard.suiteId,
                suiteName: shard.suite.name,
                status: 'failed',
                startTime: state.assignedAt || Date.now(),
                endTime: Date.now(),
                duration: Date.now() - (state.assignedAt || Date.now()),
                request: {
                  method: tc.request.method,
                  url: tc.request.url,
                  headers: tc.request.headers,
                  body: tc.request.body,
                },
                response: null,
                assertions: [],
                extractedVariables: {},
                error: complete.error || '分片执行失败',
              };
              this.retryQueue.push({
                testCase: tc,
                suite: shard.suite,
                originalResult: fakeResult,
                retryAttempt: 1,
                originalWorkerId: workerId,
              });
            }
          }
        }
      }
    }

    this.checkRetryQueue();
    this.assignNextShard(workerId);
    this.checkCompletion();
  }

  private handleHeartbeat(workerId: string, message: WorkerHeartbeatMessage): void {
    const worker = this.getWorkerById(workerId);
    if (!worker) return;

    worker.info.lastHeartbeat = Date.now();
    if (message.currentShardId) {
      worker.info.currentShardId = message.currentShardId;
      const state = this.shardManager.getShardState(message.currentShardId);
      if (state) {
        state.lastStatusUpdate = Date.now();
      }
    }
    if (message.currentTestCaseId) {
      worker.info.currentTestCaseId = message.currentTestCaseId;
    }
  }

  private handleWorkerDisconnect(tempId: string): void {
    const worker = this.workers.get(tempId);
    if (!worker) return;

    const workerId = worker.id;
    console.log(chalk.yellow(`⚠️  Worker ${worker.id} 断开连接`));

    this.broadcastEvent({
      event: 'worker_left',
      timestamp: Date.now(),
      workerId,
    });

    worker.info.status = 'disconnected';

    const state = this.shards
      .map(s => this.shardManager.getShardState(s.id))
      .find(s => s?.workerId === worker.id);

    if (state && state.status === 'running') {
      state.status = 'error';
      state.error = `Worker ${worker.id} 断开连接`;

      const shard = this.shards.find(s => s.id === state.shardId);
      if (shard) {
        for (const tc of shard.testCases) {
          const tcStatus = state.testCaseStatus.get(tc.id);
          if (tcStatus !== 'passed' && tcStatus !== 'failed' && tcStatus !== 'skipped') {
            if (this.config.maxRetries > 0) {
              const existingResult = state.results.get(tc.id);
              const fakeResult: ExecutionResult = existingResult || {
                testCaseId: tc.id,
                testCaseName: tc.name,
                suiteId: shard.suiteId,
                suiteName: shard.suite.name,
                status: 'failed',
                startTime: state.assignedAt || Date.now(),
                endTime: Date.now(),
                duration: Date.now() - (state.assignedAt || Date.now()),
                request: {
                  method: tc.request.method,
                  url: tc.request.url,
                  headers: tc.request.headers,
                  body: tc.request.body,
                },
                response: null,
                assertions: [],
                extractedVariables: {},
                error: `Worker ${worker.id} 断开连接`,
              };

              if (!existingResult) {
                this.retryQueue.push({
                  testCase: tc,
                  suite: shard.suite,
                  originalResult: fakeResult,
                  retryAttempt: 1,
                  originalWorkerId: worker.id,
                });
              }
            }
          }
        }
      }

      this.reportMerger.addWorkerError(worker.id, `Worker 断开连接`);
      this.checkRetryQueue();
    }

    this.workers.delete(tempId);
    this.checkCompletion();
  }

  private handleStealRequest(workerId: string, message: StealRequestMessage): void {
    const worker = this.getWorkerById(workerId);
    if (!worker || worker.info.status === 'unhealthy') {
      return;
    }

    if (worker.info.status !== 'idle') {
      return;
    }

    const hasRetry = this.retryQueue.length > 0;

    const readyShards = this.shardManager.getReadyShards();
    const availableShards = readyShards.filter(s => {
      const state = this.shardManager.getShardState(s.id);
      return state && state.status === 'pending' && !state.workerId;
    });
    const hasAvailableShard = availableShards.length > 0;

    if (!hasRetry && !hasAvailableShard) {
      this.sendMessage(worker.ws, {
        type: 'no_more_shards',
      } as NoMoreShardsMessage);
      return;
    }

    this.assignNextShard(workerId);

    if (worker.info.status === 'idle') {
      this.sendMessage(worker.ws, {
        type: 'no_more_shards',
      } as NoMoreShardsMessage);
    }
  }

  private assignNextShard(workerId: string): void {
    const worker = this.getWorkerById(workerId);
    if (!worker || worker.info.status === 'unhealthy') return;

    if (this.retryQueue.length > 0) {
      const retryItem = this.retryQueue.shift()!;
      if (retryItem.retryAttempt > this.config.maxRetries) {
        this.reportMerger.addFinalResult(retryItem.testCase.id, {
          ...retryItem.originalResult,
          error: `重试次数超过最大值 ${this.config.maxRetries}`,
        });
        this.checkCompletion();
        this.assignNextShard(workerId);
        return;
      }

      if (retryItem.originalWorkerId === workerId && this.retryQueue.length > 0) {
        this.retryQueue.push(retryItem);
        const nextRetry = this.retryQueue.shift()!;
        this.assignRetry(worker, nextRetry);
      } else {
        this.assignRetry(worker, retryItem);
      }
      return;
    }

    const readyShards = this.shardManager.getReadyShards();
    const availableShards = readyShards.filter(s => {
      const state = this.shardManager.getShardState(s.id);
      return state && state.status === 'pending' && !state.workerId;
    });

    if (availableShards.length === 0) {
      const pendingCount = this.shards.filter(s => {
        const state = this.shardManager.getShardState(s.id);
        return state && (state.status === 'pending' || state.status === 'running');
      }).length;

      if (pendingCount === 0 && this.retryQueue.length === 0) {
        this.sendMessage(worker.ws, {
          type: 'no_more_shards',
        } as NoMoreShardsMessage);
      }
      return;
    }

    const shard = availableShards[0];
    this.assignShardToWorker(worker, shard);
  }

  private assignShardToWorker(worker: WorkerConnection, shard: TestShard): void {
    const state = this.shardManager.getShardState(shard.id);
    if (!state) return;

    state.status = 'running';
    state.workerId = worker.id;
    state.assignedAt = Date.now();
    state.lastStatusUpdate = Date.now();

    worker.info.status = 'running';
    worker.info.currentShardId = shard.id;

    const assignment: ShardAssignment = {
      shardId: shard.id,
      suite: {
        ...shard.suite,
        tests: shard.testCases,
      },
      testCases: shard.testCases,
      variables: {
        ...this.allVariables,
      },
      environment: {
        baseUrl: this.config.baseUrl || this.environment?.baseUrl,
        variables: this.environment?.variables,
        headers: this.environment?.headers,
      },
      variableTimeout: this.config.variableTimeout,
    };

    console.log(chalk.cyan(`📤 分配分片 ${shard.id} 给 Worker ${worker.id} (${shard.testCases.length} 个用例)`));

    this.broadcastEvent({
      event: 'shard_assigned',
      timestamp: Date.now(),
      shardId: shard.id,
      workerId: worker.id,
      testCaseCount: shard.testCases.length,
    });

    this.sendMessage(worker.ws, {
      type: 'assign_shard',
      assignment,
    } as AssignShardMessage);
  }

  private assignRetry(
    worker: WorkerConnection,
    retryItem: {
      testCase: TestCase;
      suite: TestSuite;
      originalResult: ExecutionResult;
      retryAttempt: number;
      originalWorkerId: string;
    }
  ): void {
    const shardId = `retry-${retryItem.testCase.id}-${uuidv4().slice(0, 8)}`;

    const retryShard: TestShard = {
      id: shardId,
      suiteId: retryItem.suite.id,
      suite: retryItem.suite,
      testCases: [retryItem.testCase],
      dependencyLevel: 999,
      requiredVariables: [],
      providedVariables: [],
      dependsOnShards: [],
    };

    this.shards.push(retryShard);
    this.shardManager['shards'].push(retryShard);
    this.shardManager['shardStates'].set(shardId, {
      shardId,
      status: 'running',
      workerId: worker.id,
      assignedAt: Date.now(),
      lastStatusUpdate: Date.now(),
      results: new Map(),
      pendingVariables: new Set(),
      testCaseStatus: new Map([[retryItem.testCase.id, 'running' as const]]),
    });

    worker.info.status = 'running';
    worker.info.currentShardId = shardId;

    const assignment: ShardAssignment = {
      shardId,
      suite: {
        ...retryItem.suite,
        tests: [retryItem.testCase],
      },
      testCases: [retryItem.testCase],
      variables: {
        ...this.allVariables,
      },
      environment: {
        baseUrl: this.config.baseUrl || this.environment?.baseUrl,
        variables: this.environment?.variables,
        headers: this.environment?.headers,
      },
      variableTimeout: this.config.variableTimeout,
    };

    const retry: RetryAssignment = {
      testCaseId: retryItem.testCase.id,
      originalWorkerId: retryItem.originalWorkerId,
      previousResults: [retryItem.originalResult],
      retryAttempt: retryItem.retryAttempt,
    };

    console.log(chalk.yellow(
      `🔄 重试用例 ${retryItem.testCase.id} (尝试 ${retryItem.retryAttempt}/${this.config.maxRetries}) 分配给 Worker ${worker.id}`
    ));

    this.reportMerger.addRetrySuperseded(retryItem.testCase.id, retryItem.originalResult);

    this.sendMessage(worker.ws, {
      type: 'retry_test',
      assignment,
      retry,
    } as RetryTestMessage);
  }

  private assignReadyShards(): void {
    for (const [, worker] of this.workers) {
      if (worker.info.status === 'idle') {
        this.assignNextShard(worker.id);
      }
    }
  }

  private checkRetryQueue(): void {
    if (this.retryQueue.length > 0) {
      for (const [, worker] of this.workers) {
        if (worker.info.status === 'idle') {
          this.assignNextShard(worker.id);
        }
      }
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    const shardTimeout = this.config.shardTimeout || SHARD_TIMEOUT_DEFAULT;

    for (const shard of this.shards) {
      const state = this.shardManager.getShardState(shard.id);
      if (!state || state.status !== 'running') continue;

      if (state.lastStatusUpdate && now - state.lastStatusUpdate > shardTimeout) {
        console.log(chalk.red(`⏰ 分片 ${shard.id} 执行超时`));
        state.status = 'timeout';
        state.error = '分片执行超时';

        const worker = state.workerId ? this.getWorkerById(state.workerId) : undefined;
        if (worker) {
          worker.info.status = 'idle';
          worker.info.currentShardId = undefined;
          worker.info.currentTestCaseId = undefined;
          worker.info.failureCount++;

          if (worker.info.failureCount >= MAX_WORKER_FAILURES) {
            worker.info.status = 'unhealthy';
            this.reportMerger.addWorkerError(worker.id, '分片超时导致失败次数过多');
          }
        }

        for (const tc of shard.testCases) {
          const tcStatus = state.testCaseStatus.get(tc.id);
          if (tcStatus !== 'passed' && tcStatus !== 'failed' && tcStatus !== 'skipped') {
            if (this.config.maxRetries > 0) {
              const fakeResult: ExecutionResult = {
                testCaseId: tc.id,
                testCaseName: tc.name,
                suiteId: shard.suiteId,
                suiteName: shard.suite.name,
                status: 'failed',
                startTime: state.assignedAt || now,
                endTime: now,
                duration: now - (state.assignedAt || now),
                request: {
                  method: tc.request.method,
                  url: tc.request.url,
                  headers: tc.request.headers,
                  body: tc.request.body,
                },
                response: null,
                assertions: [],
                extractedVariables: {},
                error: '分片执行超时',
              };
              this.retryQueue.push({
                testCase: tc,
                suite: shard.suite,
                originalResult: fakeResult,
                retryAttempt: 1,
                originalWorkerId: state.workerId || 'unknown',
              });
            }
          }
        }

        this.reportMerger.addWorkerError(state.workerId || 'unknown', '分片执行超时');
        this.checkRetryQueue();
        this.assignNextShard(state.workerId || '');
        this.checkCompletion();
      }
    }

    for (const [, worker] of this.workers) {
      if (now - worker.info.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        console.log(chalk.yellow(`⏰ Worker ${worker.id} 心跳超时，断开连接`));
        worker.ws.close();
      }
    }
  }

  private checkCompletion(): void {
    if (this.isComplete) return;

    const allDone = this.shards.every(shard => {
      const state = this.shardManager.getShardState(shard.id);
      return state && (state.status === 'completed' || state.status === 'error' || state.status === 'timeout');
    });

    if (allDone && this.retryQueue.length === 0) {
      this.isComplete = true;
      this.completeExecution();
    }
  }

  private completeExecution(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    const oldRetrySuperseded = this.reportMerger.getRetrySupersededResults();

    const workerInfoMap = new Map<string, WorkerInfo>();
    for (const [, worker] of this.workers) {
      workerInfoMap.set(worker.id, worker.info);
    }

    const shardStateMap = new Map<string, ShardExecutionState>();
    for (const s of this.shards) {
      const state = this.shardManager.getShardState(s.id);
      if (state) {
        shardStateMap.set(s.id, state);
      }
    }

    const allFinalResults = new Map<string, ExecutionResult>();
    for (const [, state] of shardStateMap) {
      for (const [tcId, result] of state.results) {
        allFinalResults.set(tcId, result);
      }
    }

    this.reportMerger = new ReportMerger(
      this.shards,
      shardStateMap,
      workerInfoMap,
      this.startTime
    );

    for (const result of oldRetrySuperseded) {
      this.reportMerger.addRetrySuperseded(result.testCaseId, result);
    }

    for (const [tcId, result] of allFinalResults) {
      this.reportMerger.addFinalResult(tcId, result);
    }

    const mergedResult = this.reportMerger.merge();

    console.log(chalk.cyan('\n' + '═'.repeat(70)));
    console.log(chalk.cyan('  📊 分布式测试执行完成'));
    console.log(chalk.cyan('═'.repeat(70) + '\n'));

    const status = this.getStatus();
    this.broadcastEvent({
      event: 'all_done',
      timestamp: Date.now(),
      summary: {
        totalTestCases: status.totalTestCases,
        passedTestCases: status.passedTestCases,
        failedTestCases: status.failedTestCases,
        skippedTestCases: status.skippedTestCases,
        errorTestCases: status.errorTestCases,
        totalShards: this.shards.length,
        completedShards: status.completedShards,
        totalDuration: mergedResult.runSummary.duration,
      },
    });

    this.generateReports(mergedResult);

    for (const [, worker] of this.workers) {
      try {
        this.sendMessage(worker.ws, {
          type: 'execution_complete',
          summary: mergedResult.runSummary,
        } as ExecutionCompleteMessage);
      } catch {
        // ignore
      }
    }

    setTimeout(() => {
      this.server.close();
      this.resolveComplete(mergedResult.runSummary);
    }, 1000);
  }

  private generateReports(mergedResult: MergedReportResult): void {
    const outputDir = this.config.outputDir;
    const reporter = new ReportGenerator(outputDir);

    if (this.config.jsonReport) {
      const jsonPath = reporter.generateJsonReport(mergedResult.runSummary);
      console.log(chalk.green(`  📄 JSON 报告: ${jsonPath}`));
    }

    if (this.config.junitReport) {
      const junitPath = reporter.generateJunitReport(mergedResult.runSummary);
      console.log(chalk.green(`  📄 JUnit 报告: ${junitPath}`));
    }

    if (this.config.htmlReport) {
      const htmlPath = reporter.generateHtmlReport(mergedResult.runSummary);
      console.log(chalk.green(`  📄 HTML 报告: ${htmlPath}`));
    }

    if (mergedResult.workerErrors.length > 0) {
      console.log(chalk.yellow(`\n  ⚠️  Worker 错误 (${mergedResult.workerErrors.length} 个):`));
      for (const err of mergedResult.workerErrors) {
        console.log(chalk.yellow(`     - [${new Date(err.timestamp).toLocaleTimeString()}] ${err.workerId}: ${err.error}`));
      }
    }

    if (mergedResult.shardErrors.length > 0) {
      console.log(chalk.red(`\n  ❌ 分片错误 (${mergedResult.shardErrors.length} 个):`));
      for (const err of mergedResult.shardErrors) {
        console.log(chalk.red(`     - ${err.shardId} (Worker: ${err.workerId || 'unknown'}): ${err.error}`));
        if (err.incompleteTestCases.length > 0) {
          console.log(chalk.red(`       未完成用例: ${err.incompleteTestCases.join(', ')}`));
        }
      }
    }

    if (mergedResult.retrySupersededResults.length > 0) {
      console.log(chalk.yellow(`\n  🔄 重试历史 (${mergedResult.retrySupersededResults.length} 条):`));
      for (const result of mergedResult.retrySupersededResults) {
        console.log(chalk.yellow(`     - ${result.testCaseId}: ${result.status}`));
      }
    }

    reporter.printTerminalSummary(mergedResult.runSummary);
  }

  private getStatus(): CoordinatorStatus {
    const shardStatuses = this.shards.map(shard => {
      const state = this.shardManager.getShardState(shard.id);
      const completedCount = shard.testCases.filter(tc => {
        const status = state?.testCaseStatus.get(tc.id);
        return status === 'passed' || status === 'failed' || status === 'skipped';
      }).length;

      const testCases: TestCaseInShard[] = shard.testCases.map(tc => {
        const status = (state?.testCaseStatus.get(tc.id) || 'pending') as TestCaseStatus;
        const result = state?.results.get(tc.id);
        return {
          id: tc.id,
          name: tc.name,
          status,
          duration: result?.duration,
        };
      });

      return {
        id: shard.id,
        suiteId: shard.suiteId,
        status: state?.status || 'pending',
        workerId: state?.workerId,
        testCaseCount: shard.testCases.length,
        completedCount,
        testCases,
      };
    });

    let completedTestCases = 0;
    let passedTestCases = 0;
    let failedTestCases = 0;
    let skippedTestCases = 0;
    let errorTestCases = 0;

    for (const shard of this.shards) {
      const state = this.shardManager.getShardState(shard.id);
      if (!state) continue;

      for (const tc of shard.testCases) {
        const status = state.testCaseStatus.get(tc.id);
        if (status === 'passed' || status === 'failed' || status === 'skipped') {
          completedTestCases++;
          if (status === 'passed') passedTestCases++;
          else if (status === 'failed') failedTestCases++;
          else if (status === 'skipped') skippedTestCases++;
        } else if (status === 'error') {
          errorTestCases++;
          completedTestCases++;
        }
      }
    }

    const completedShards = this.shards.filter(s => {
      const state = this.shardManager.getShardState(s.id);
      return state?.status === 'completed';
    }).length;

    return {
      startTime: this.startTime,
      totalTestCases: this.shardManager.getTotalTestCaseCount(),
      completedTestCases,
      passedTestCases,
      failedTestCases,
      skippedTestCases,
      errorTestCases,
      totalShards: this.shards.length,
      completedShards,
      workers: Array.from(this.workers.values()).map(w => ({ ...w.info })),
      shards: shardStatuses,
    };
  }

  private getWorkerById(workerId: string): WorkerConnection | undefined {
    for (const [, worker] of this.workers) {
      if (worker.id === workerId) {
        return worker;
      }
    }
    return undefined;
  }

  private sendMessage(ws: WebSocket, message: CoordinatorMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.server.close();
    for (const [, worker] of this.workers) {
      worker.ws.close();
    }
    for (const client of this.eventClients) {
      client.close();
    }
    this.eventClients.clear();
  }
}
