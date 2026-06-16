import toposort from 'toposort';
import path from 'path';
import {
  TestSuite,
  TestCase,
  ExecutionResult,
  SuiteExecutionResult,
  RunOptions,
  RunSummary,
  AssertionResult,
  SeverityLevel,
  EnvironmentConfig,
  GlobalConfig
} from '../types';
import { HttpClient, HttpRequestError, ReceivedResponse, SentRequest } from './httpClient';
import { VariableResolver } from './variables';
import { AssertionEngine } from './assertions';
import { ConfigParser } from './parser';

export interface TestRunContext {
  suite: TestSuite;
  options: RunOptions;
  environment?: EnvironmentConfig;
  globalConfig: GlobalConfig;
}

type TestNode = {
  test: TestCase;
  dataRow?: Record<string, any>;
  dataRowIndex?: number;
  expandedId: string;
  originalId: string;
};

export class TestRunner {
  private parser: ConfigParser;
  private baseResolver: VariableResolver;
  private globalConfig: GlobalConfig;
  private options: RunOptions;

  constructor(options: RunOptions) {
    this.options = options;
    this.parser = new ConfigParser();
    this.baseResolver = new VariableResolver();
    this.globalConfig = {};
  }

  async run(): Promise<RunSummary> {
    const startTime = Date.now();

    await this.initialize();

    const suiteResults: SuiteExecutionResult[] = [];
    let passedSuites = 0;
    let failedSuites = 0;

    for (const suitePath of this.options.suitePaths) {
      const suite = this.parser.parseSuite(suitePath);
      const suiteResult = await this.runSuite(suite);
      suiteResults.push(suiteResult);

      if (suiteResult.summary.failed > 0) {
        failedSuites++;
      } else {
        passedSuites++;
      }
    }

    const endTime = Date.now();
    const summary = this.buildSummary(suiteResults, startTime, endTime, passedSuites, failedSuites);

    return summary;
  }

  private async initialize(): Promise<void> {
    if (this.options.globalConfigFile) {
      this.globalConfig = this.parser.parseGlobalConfig(this.options.globalConfigFile);
    }

    if (this.globalConfig.variables) {
      this.baseResolver.setGlobalVars(this.globalConfig.variables);
    }

    if (this.options.variables) {
      this.baseResolver.setGlobalVars({
        ...this.baseResolver['globalVars'],
        ...this.options.variables
      });
    }
  }

  private async runSuite(suite: TestSuite): Promise<SuiteExecutionResult> {
    const startTime = Date.now();
    const resolver = this.createSuiteResolver(suite);
    const snapshotDir = this.options.outputDir
      ? `${this.options.outputDir}/snapshots`
      : (this.globalConfig.output?.snapshots || './reports/snapshots');
    const httpClient = this.createHttpClient(suite);
    const assertionEngine = new AssertionEngine(
      resolver,
      snapshotDir,
      this.options.updateSnapshots || false
    );

    const nodes = this.expandTestCases(suite, resolver);
    const executionGroups = this.buildExecutionGroups(nodes);

    const failedCaseIds = new Set<string>();
    const skippedCaseIds = new Set<string>();
    const testResults: ExecutionResult[] = [];
    const concurrency = this.options.concurrency ?? this.globalConfig.concurrency ?? 5;

    let stopSuite = false;

    for (const group of executionGroups) {
      if (stopSuite) {
        for (const node of group) {
          const skipResult = this.createSkippedResult(node, suite, '因停止执行而跳过');
          testResults.push(skipResult);
        }
        continue;
      }

      const independentNodes = group.filter(node => {
        const skippedByDependency = node.test.dependsOn?.some(depId =>
          failedCaseIds.has(depId) || skippedCaseIds.has(depId)
        );
        if (skippedByDependency) {
          const failedDep = node.test.dependsOn!.find(depId => failedCaseIds.has(depId));
          const skipReason = failedDep
            ? `依赖的用例 [${failedDep}] 执行失败`
            : `依赖的用例已跳过`;
          const skipResult = this.createSkippedResult(node, suite, skipReason);
          testResults.push(skipResult);
          skippedCaseIds.add(node.originalId);
          return false;
        }

        if (this.options.onlyFailed) {
          const savedFailed = this.loadFailedCases();
          if (!savedFailed.includes(node.originalId)) {
            const skipResult = this.createSkippedResult(node, suite, '仅执行失败用例模式，本次跳过');
            testResults.push(skipResult);
            return false;
          }
        }

        if (node.test.skip) {
          const skipResult = this.createSkippedResult(node, suite, '用例标记为跳过');
          testResults.push(skipResult);
          return false;
        }

        return true;
      });

      const chunkSize = Math.max(1, concurrency);
      for (let i = 0; i < independentNodes.length; i += chunkSize) {
        const chunk = independentNodes.slice(i, i + chunkSize);
        const results = await Promise.all(
          chunk.map(node => this.runTestCase(node, suite, resolver, httpClient, assertionEngine))
        );

        for (let j = 0; j < chunk.length; j++) {
          const node = chunk[j];
          const result = results[j];
          testResults.push(result);

          if (result.status === 'failed') {
            failedCaseIds.add(node.originalId);
            if (this.options.stopOnFailure) {
              stopSuite = true;
            }
          }

          if (Object.keys(result.extractedVariables).length > 0) {
            for (const [key, value] of Object.entries(result.extractedVariables)) {
              resolver.addExtractedVar(key, value);
            }
          }
        }
      }
    }

    const endTime = Date.now();
    const summary = {
      total: testResults.length,
      passed: testResults.filter(r => r.status === 'passed').length,
      failed: testResults.filter(r => r.status === 'failed').length,
      skipped: testResults.filter(r => r.status === 'skipped').length
    };

    return {
      suiteId: suite.id,
      suiteName: suite.name,
      startTime,
      endTime,
      duration: endTime - startTime,
      testResults,
      summary
    };
  }

  private createSuiteResolver(suite: TestSuite): VariableResolver {
    const resolver = new VariableResolver();

    if (this.globalConfig.variables) {
      resolver.setGlobalVars(this.globalConfig.variables);
    }

    if (this.options.variables) {
      resolver.setGlobalVars({
        ...resolver['globalVars'],
        ...this.options.variables
      });
    }

    let envConfig: EnvironmentConfig | undefined;
    if (this.options.environmentFile) {
      envConfig = this.parser.parseEnvironment(this.options.environmentFile);
    }

    if (envConfig) {
      resolver.setEnvironmentVars({
        ...(envConfig.variables || {}),
        base_url: envConfig.baseUrl,
        env_name: envConfig.name
      });
      if (envConfig.headers) {
        resolver.setEnvironmentVars({
          ...resolver['environmentVars'],
          __env_headers: envConfig.headers
        });
      }
    }

    if (this.options.baseUrl) {
      resolver.setEnvironmentVars({
        ...resolver['environmentVars'],
        base_url: this.options.baseUrl
      });
    }

    if (suite.before?.variables) {
      resolver.setSuiteVars(suite.before.variables);
    }

    if (suite.baseUrl) {
      resolver.setSuiteVars({
        ...resolver['suiteVars'],
        suite_base_url: suite.baseUrl
      });
    }

    return resolver;
  }

  private createHttpClient(suite: TestSuite): HttpClient {
    const defaultTimeout =
      this.options.concurrency !== undefined ? undefined :
      suite.defaults?.timeout ??
      this.globalConfig.timeout ??
      30000;

    const defaultHeaders: Record<string, string> = {
      ...(this.globalConfig.headers || {}),
      ...(suite.defaults?.headers || {})
    };

    return new HttpClient(defaultTimeout, defaultHeaders);
  }

  private expandTestCases(suite: TestSuite, resolver: VariableResolver): TestNode[] {
    const nodes: TestNode[] = [];
    const includedTests = this.filterByTags(suite.tests);

    for (const test of includedTests) {
      if (test.dataSource) {
        const resolvedDataSource = resolver.resolve(test.dataSource);
        const baseDir = suite.filePath ? path.dirname(suite.filePath) : process.cwd();
        const dataRows = this.parser.parseDataFile(
          resolvedDataSource.file,
          resolvedDataSource.type,
          baseDir
        );

        dataRows.forEach((row, index) => {
          nodes.push({
            test,
            dataRow: row,
            dataRowIndex: index,
            expandedId: `${test.id}__row${index}`,
            originalId: test.id
          });
        });

        if (dataRows.length === 0) {
          nodes.push({
            test,
            expandedId: test.id,
            originalId: test.id
          });
        }
      } else {
        nodes.push({
          test,
          expandedId: test.id,
          originalId: test.id
        });
      }
    }

    return nodes;
  }

  private filterByTags(tests: TestCase[]): TestCase[] {
    const includeTags = this.options.tags;
    const excludeTags = this.options.excludeTags;

    return tests.filter(test => {
      if (excludeTags && excludeTags.length > 0) {
        const testTags = test.tags || [];
        if (excludeTags.some(tag => testTags.includes(tag))) {
          return false;
        }
      }

      if (includeTags && includeTags.length > 0) {
        const testTags = test.tags || [];
        return includeTags.some(tag => testTags.includes(tag));
      }

      return true;
    });
  }

  private buildExecutionGroups(nodes: TestNode[]): TestNode[][] {
    const graph: [string, string][] = [];
    const idToNode = new Map<string, TestNode>();
    const allIds = new Set<string>();

    for (const node of nodes) {
      idToNode.set(node.expandedId, node);
      allIds.add(node.expandedId);
    }

    const originalIdToExpandedIds = new Map<string, string[]>();
    for (const node of nodes) {
      if (!originalIdToExpandedIds.has(node.originalId)) {
        originalIdToExpandedIds.set(node.originalId, []);
      }
      originalIdToExpandedIds.get(node.originalId)!.push(node.expandedId);
    }

    for (const node of nodes) {
      const dependsOn = node.test.dependsOn || [];
      for (const depOriginalId of dependsOn) {
        const depExpandedIds = originalIdToExpandedIds.get(depOriginalId) || [depOriginalId];
        for (const depExpandedId of depExpandedIds) {
          if (allIds.has(depExpandedId)) {
            graph.push([depExpandedId, node.expandedId]);
          }
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

      const groups: TestNode[][] = [];
      const inDegree = new Map<string, number>();

      for (const id of allIds) {
        inDegree.set(id, 0);
      }
      for (const [from] of graph) {
        const toNode = graph.find(([, to]) => {
          const toNodeData = idToNode.get(to);
          return toNodeData?.test.dependsOn?.includes(idToNode.get(from)?.originalId || '');
        });
      }

      const depCount = new Map<string, number>();
      for (const node of nodes) {
        const deps = node.test.dependsOn || [];
        let count = 0;
        for (const dep of deps) {
          const depIds = originalIdToExpandedIds.get(dep) || [];
          count += depIds.filter(id => allIds.has(id)).length;
        }
        depCount.set(node.expandedId, count);
      }

      const remaining = new Set(sortedIds);
      while (remaining.size > 0) {
        const currentGroup: string[] = [];
        for (const id of sortedIds) {
          if (remaining.has(id) && (depCount.get(id) || 0) === 0) {
            currentGroup.push(id);
            remaining.delete(id);
          }
        }

        if (currentGroup.length === 0) {
          const firstRemaining = remaining.values().next();
          if (firstRemaining.value !== undefined) {
            currentGroup.push(firstRemaining.value);
            remaining.delete(firstRemaining.value);
          }
        }

        for (const id of currentGroup) {
          const nodeData = idToNode.get(id);
          if (nodeData) {
            for (const otherNode of nodes) {
              if (otherNode.test.dependsOn?.includes(nodeData.originalId)) {
                depCount.set(otherNode.expandedId, (depCount.get(otherNode.expandedId) || 0) - 1);
              }
            }
          }
        }

        groups.push(currentGroup.map(id => idToNode.get(id)!).filter(Boolean));
      }

      return groups;
    } catch (e: any) {
      throw new Error(`测试用例依赖关系存在循环: ${e.message}`);
    }
  }

  private async runTestCase(
    node: TestNode,
    suite: TestSuite,
    resolver: VariableResolver,
    httpClient: HttpClient,
    assertionEngine: AssertionEngine
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const test = node.test;

    let runtimeVars: Record<string, any> = {};
    if (node.dataRow) {
      const prefix = test.dataSource?.varPrefix || 'data';
      for (const [key, value] of Object.entries(node.dataRow)) {
        runtimeVars[`${prefix}_${key}`] = value;
      }
      runtimeVars['__data_row'] = node.dataRow;
      runtimeVars['__data_row_index'] = node.dataRowIndex;
    }

    resolver.setRuntimeVars(runtimeVars);

    let finalBaseUrl: string | undefined;
    const allVars = resolver.getAllVars();
    finalBaseUrl = (allVars.base_url as string) || (allVars.suite_base_url as string) || suite.baseUrl;

    const globalHeaders = (allVars.__env_headers as Record<string, string>) || {};
    if (Object.keys(globalHeaders).length > 0) {
      httpClient.setDefaultHeaders(globalHeaders);
    }

    const maxAttempts = test.retry?.maxAttempts ?? this.globalConfig.retries ?? 1;
    const retryDelay = test.retry?.delayMs ?? 1000;

    let lastResult: ExecutionResult | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const { request, response } = await httpClient.send(
          test.request,
          resolver,
          finalBaseUrl
        );

        let extractedVars: Record<string, any> = {};
        if (test.extracts && test.extracts.length > 0) {
          extractedVars = resolver.extractFromResponse(test.extracts, {
            status: response.status,
            headers: response.headers,
            body: response.body,
            cookies: response.cookies
          });
        }

        const assertionResults = await assertionEngine.runAssertions(
          test.assertions,
          response,
          test.id,
          test.name
        );

        const allPassed = assertionResults.every(a => a.passed);

        lastResult = {
          testCaseId: test.id,
          testCaseName: test.name + (node.dataRow !== undefined ? ` [数据行 ${node.dataRowIndex! + 1}]` : ''),
          suiteId: suite.id,
          suiteName: suite.name,
          status: allPassed ? 'passed' : 'failed',
          startTime,
          endTime: Date.now(),
          duration: Date.now() - startTime,
          request: {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            time: response.time
          },
          assertions: assertionResults,
          extractedVariables: extractedVars,
          dataRow: node.dataRow,
          dataRowIndex: node.dataRowIndex,
          retryAttempts: attempts
        };

        if (allPassed || attempt >= maxAttempts) {
          break;
        }
      } catch (error: any) {
        const httpError = error as HttpRequestError;
        lastResult = {
          testCaseId: test.id,
          testCaseName: test.name + (node.dataRow !== undefined ? ` [数据行 ${node.dataRowIndex! + 1}]` : ''),
          suiteId: suite.id,
          suiteName: suite.name,
          status: 'failed',
          startTime,
          endTime: Date.now(),
          duration: Date.now() - startTime,
          request: {
            method: test.request.method,
            url: this.buildUrlForError(test, resolver, finalBaseUrl),
            headers: test.request.headers,
            body: test.request.body
          },
          response: null,
          assertions: [{
            type: 'request',
            severity: 'critical',
            passed: false,
            message: error.message || '请求发送失败'
          }],
          extractedVariables: {},
          error: error.stack || error.message,
          dataRow: node.dataRow,
          dataRowIndex: node.dataRowIndex,
          retryAttempts: attempts
        };

        if (attempt >= maxAttempts) {
          break;
        }
      }

      await this.sleep(retryDelay);
    }

    return lastResult!;
  }

  private createSkippedResult(
    node: TestNode,
    suite: TestSuite,
    reason: string
  ): ExecutionResult {
    const now = Date.now();
    return {
      testCaseId: node.test.id,
      testCaseName: node.test.name + (node.dataRow !== undefined ? ` [数据行 ${node.dataRowIndex! + 1}]` : ''),
      suiteId: suite.id,
      suiteName: suite.name,
      status: 'skipped',
      startTime: now,
      endTime: now,
      duration: 0,
      request: {
        method: node.test.request.method,
        url: node.test.request.url,
        headers: node.test.request.headers,
        body: node.test.request.body
      },
      response: null,
      assertions: [],
      extractedVariables: {},
      skippedReason: reason,
      dataRow: node.dataRow,
      dataRowIndex: node.dataRowIndex
    };
  }

  private buildUrlForError(
    test: TestCase,
    resolver: VariableResolver,
    baseUrl?: string
  ): string {
    try {
      const resolvedUrl = resolver.resolve(test.request.url);
      if (baseUrl && !/^https?:\/\//i.test(resolvedUrl)) {
        const cleanedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const cleanedUrl = resolvedUrl.startsWith('/') ? resolvedUrl : '/' + resolvedUrl;
        return cleanedBase + cleanedUrl;
      }
      return resolvedUrl;
    } catch {
      return test.request.url;
    }
  }

  private buildSummary(
    suiteResults: SuiteExecutionResult[],
    startTime: number,
    endTime: number,
    passedSuites: number,
    failedSuites: number
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
        passedAssertions += test.assertions.filter(a => a.passed).length;
        failedAssertions += test.assertions.filter(a => !a.passed).length;
      }
    }

    return {
      totalSuites: suiteResults.length,
      passedSuites,
      failedSuites,
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      totalAssertions,
      passedAssertions,
      failedAssertions,
      startTime,
      endTime,
      duration: endTime - startTime,
      suiteResults
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getFailedFilePath(): string {
    if (this.options.failedFile) {
      return this.options.failedFile;
    }
    if (this.globalConfig.output?.failed) {
      return this.globalConfig.output.failed;
    }
    return './.api-regression/failed-tests.json';
  }

  private loadFailedCases(): string[] {
    const failedFile = this.getFailedFilePath();

    try {
      const fs = require('fs');
      const path = require('path');
      const fullPath = path.resolve(failedFile);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(content);
        return Array.isArray(data) ? data : [];
      }
    } catch {
      // ignore
    }
    return [];
  }

  saveFailedCases(summary: RunSummary, outputDir?: string): void {
    const fs = require('fs');
    const path = require('path');

    const failedFile = this.getFailedFilePath();

    const fullPath = path.resolve(failedFile);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const failedIds: string[] = [];
    for (const suite of summary.suiteResults) {
      for (const test of suite.testResults) {
        if (test.status === 'failed') {
          failedIds.push(test.testCaseId);
        }
      }
    }

    fs.writeFileSync(fullPath, JSON.stringify(Array.from(new Set(failedIds)), null, 2), 'utf-8');
  }

  shouldExitNonZero(summary: RunSummary): boolean {
    const criticalLevels: SeverityLevel[] = ['critical', 'high'];
    if (!this.options.ciExitCode && this.options.ciExitCode !== undefined) {
      return false;
    }

    for (const suite of summary.suiteResults) {
      for (const test of suite.testResults) {
        for (const assertion of test.assertions) {
          if (!assertion.passed && criticalLevels.includes(assertion.severity)) {
            return true;
          }
        }
      }
    }

    return summary.failedTests > 0;
  }
}
