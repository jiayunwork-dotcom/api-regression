import {
  ExecutionResult,
  SuiteExecutionResult,
  RunSummary,
  AssertionResult,
} from '../../types';
import {
  TestShard,
  ShardExecutionState,
  WorkerInfo,
  MergedReportResult,
  TestCaseStatus,
} from '../../types/distributed';

export class ReportMerger {
  private shards: TestShard[];
  private shardStates: Map<string, ShardExecutionState>;
  private workers: Map<string, WorkerInfo>;
  private retrySuperseded: Map<string, ExecutionResult[]> = new Map();
  private workerErrors: Array<{ workerId: string; error: string; timestamp: number }> = [];
  private finalResults: Map<string, ExecutionResult> = new Map();
  private startTime: number;

  constructor(
    shards: TestShard[],
    shardStates: Map<string, ShardExecutionState>,
    workers: Map<string, WorkerInfo>,
    startTime: number
  ) {
    this.shards = shards;
    this.shardStates = shardStates;
    this.workers = workers;
    this.startTime = startTime;
  }

  addRetrySuperseded(testCaseId: string, result: ExecutionResult): void {
    if (!this.retrySuperseded.has(testCaseId)) {
      this.retrySuperseded.set(testCaseId, []);
    }
    this.retrySuperseded.get(testCaseId)!.push(result);
  }

  addWorkerError(workerId: string, error: string): void {
    this.workerErrors.push({
      workerId,
      error,
      timestamp: Date.now(),
    });
  }

  addFinalResult(testCaseId: string, result: ExecutionResult): void {
    this.finalResults.set(testCaseId, result);
  }

  merge(): MergedReportResult {
    const endTime = Date.now();
    const suiteResults: SuiteExecutionResult[] = [];

    const shardErrors: Array<{
      shardId: string;
      workerId?: string;
      error: string;
      incompleteTestCases: string[];
    }> = [];

    for (const [shardId, state] of this.shardStates) {
      if (state.status === 'error' || state.status === 'timeout') {
        const incompleteTestCases: string[] = [];
        for (const [tcId, tcStatus] of state.testCaseStatus) {
          if (tcStatus === 'pending' || tcStatus === 'running') {
            incompleteTestCases.push(tcId);
          }
        }

        shardErrors.push({
          shardId,
          workerId: state.workerId,
          error: state.error || (state.status === 'timeout' ? '分片执行超时' : '分片执行出错'),
          incompleteTestCases,
        });
      }
    }

    const suiteMap = new Map<string, {
      suite: TestShard['suite'];
      results: ExecutionResult[];
      startTime: number;
      endTime: number;
    }>();

    for (const shard of this.shards) {
      if (!suiteMap.has(shard.suiteId)) {
        suiteMap.set(shard.suiteId, {
          suite: shard.suite,
          results: [],
          startTime: Infinity,
          endTime: 0,
        });
      }

      const state = this.shardStates.get(shard.id);
      const suiteData = suiteMap.get(shard.suiteId)!;

      if (state) {
        if (state.assignedAt && state.assignedAt < suiteData.startTime) {
          suiteData.startTime = state.assignedAt;
        }
        if (state.completedAt && state.completedAt > suiteData.endTime) {
          suiteData.endTime = state.completedAt;
        }
      }

      for (const tc of shard.testCases) {
        let result = this.finalResults.get(tc.id);

        if (!result && state) {
          result = state.results.get(tc.id);
        }

        if (result) {
          suiteData.results.push(result);
          if (result.startTime < suiteData.startTime) {
            suiteData.startTime = result.startTime;
          }
          if (result.endTime > suiteData.endTime) {
            suiteData.endTime = result.endTime;
          }
        } else {
          const state = this.shardStates.get(shard.id);
          const tcStatus = state?.testCaseStatus.get(tc.id);
          const errorMessage = this.getErrorMessageForTestCase(tc.id, shard.id, state);

          const errorResult: ExecutionResult = {
            testCaseId: tc.id,
            testCaseName: tc.name,
            suiteId: shard.suiteId,
            suiteName: shard.suite.name,
            status: 'failed',
            startTime: state?.assignedAt || this.startTime,
            endTime: state?.completedAt || endTime,
            duration: (state?.completedAt || endTime) - (state?.assignedAt || this.startTime),
            request: {
              method: tc.request.method,
              url: tc.request.url,
              headers: tc.request.headers,
              body: tc.request.body,
            },
            response: null,
            assertions: [
              {
                type: 'shard',
                severity: 'critical',
                passed: false,
                message: errorMessage,
              } as AssertionResult,
            ],
            extractedVariables: {},
            error: errorMessage,
          };
          suiteData.results.push(errorResult);
        }
      }
    }

    let totalSuites = 0;
    let passedSuites = 0;
    let failedSuites = 0;

    for (const [, suiteData] of suiteMap) {
      totalSuites++;

      const sortedResults = suiteData.results.sort((a, b) => a.startTime - b.startTime);

      const passed = sortedResults.filter(r => r.status === 'passed').length;
      const failed = sortedResults.filter(r => r.status === 'failed').length;
      const skipped = sortedResults.filter(r => r.status === 'skipped').length;

      const suiteResult: SuiteExecutionResult = {
        suiteId: suiteData.suite.id,
        suiteName: suiteData.suite.name,
        startTime: suiteData.startTime === Infinity ? this.startTime : suiteData.startTime,
        endTime: suiteData.endTime === 0 ? endTime : suiteData.endTime,
        duration:
          (suiteData.endTime === 0 ? endTime : suiteData.endTime) -
          (suiteData.startTime === Infinity ? this.startTime : suiteData.startTime),
        testResults: sortedResults,
        summary: {
          total: sortedResults.length,
          passed,
          failed,
          skipped,
        },
      };

      if (failed > 0) {
        failedSuites++;
      } else {
        passedSuites++;
      }

      suiteResults.push(suiteResult);
    }

    const summary = this.buildRunSummary(
      suiteResults,
      passedSuites,
      failedSuites,
      totalSuites
    );

    const retrySupersededResults: ExecutionResult[] = [];
    for (const [, results] of this.retrySuperseded) {
      retrySupersededResults.push(...results);
    }

    return {
      runSummary: summary,
      retrySupersededResults,
      workerErrors: this.workerErrors,
      shardErrors,
    };
  }

  private getErrorMessageForTestCase(
    testCaseId: string,
    shardId: string,
    state?: ShardExecutionState
  ): string {
    if (!state) {
      return `测试用例 ${testCaseId} 未执行，分片状态未知`;
    }

    const tcStatus = state.testCaseStatus.get(testCaseId);

    switch (state.status) {
      case 'timeout':
        return `分片执行超时，用例 ${testCaseId} 状态: ${tcStatus || 'unknown'}`;
      case 'error':
        return `分片执行出错: ${state.error || '未知错误'}`;
      default:
        if (state.workerId) {
          const worker = this.workers.get(state.workerId);
          if (worker?.status === 'disconnected') {
            return `Worker ${state.workerId} 断开连接，用例 ${testCaseId} 未完成`;
          }
          if (worker?.status === 'unhealthy') {
            return `Worker ${state.workerId} 被标记为不健康，用例 ${testCaseId} 未完成`;
          }
        }
        return `测试用例 ${testCaseId} 未执行，状态: ${tcStatus || 'unknown'}`;
    }
  }

  private buildRunSummary(
    suiteResults: SuiteExecutionResult[],
    passedSuites: number,
    failedSuites: number,
    totalSuites: number
  ): RunSummary {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    let totalAssertions = 0;
    let passedAssertions = 0;
    let failedAssertions = 0;

    for (const suite of suiteResults) {
      totalTests += suite.summary.total;
      passedTests += suite.summary.passed;
      failedTests += suite.summary.failed;
      skippedTests += suite.summary.skipped;

      for (const test of suite.testResults) {
        totalAssertions += test.assertions.length;
        passedAssertions += test.assertions.filter((a: AssertionResult) => a.passed).length;
        failedAssertions += test.assertions.filter((a: AssertionResult) => !a.passed).length;
      }
    }

    return {
      totalSuites,
      passedSuites,
      failedSuites,
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      totalAssertions,
      passedAssertions,
      failedAssertions,
      startTime: this.startTime,
      endTime: Date.now(),
      duration: Date.now() - this.startTime,
      suiteResults,
    };
  }

  getRetrySupersededResults(): ExecutionResult[] {
    const results: ExecutionResult[] = [];
    for (const [, r] of this.retrySuperseded) {
      results.push(...r);
    }
    return results;
  }
}
