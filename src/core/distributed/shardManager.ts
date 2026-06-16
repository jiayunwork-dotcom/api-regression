import toposort from 'toposort';
import { v4 as uuidv4 } from 'uuid';
import { TestSuite, TestCase, EnvironmentConfig, GlobalConfig } from '../../types';
import {
  TestShard,
  VariableGraph,
  ShardExecutionState,
  TestCaseStatus,
} from '../../types/distributed';
import { ConfigParser } from '../parser';
import { VariableResolver } from '../variables';

const VAR_REF_PATTERN = /\$\{([^}]+)\}/g;

export class ShardManager {
  private parser: ConfigParser;
  private suites: TestSuite[] = [];
  private environment?: EnvironmentConfig;
  private globalConfig: GlobalConfig = {};
  private variableGraphs: Map<string, VariableGraph> = new Map();
  private shards: TestShard[] = [];
  private shardStates: Map<string, ShardExecutionState> = new Map();
  private globalVariables: Record<string, any> = {};
  private tags?: string[];
  private excludeTags?: string[];

  constructor(
    suitePaths: string[],
    options: {
      environmentFile?: string;
      configFile?: string;
      variables?: Record<string, any>;
      tags?: string[];
      excludeTags?: string[];
    } = {}
  ) {
    this.parser = new ConfigParser();
    this.tags = options.tags;
    this.excludeTags = options.excludeTags;

    for (const path of suitePaths) {
      const stat = require('fs').statSync(path);
      if (stat.isDirectory()) {
        const discovered = this.parser.discoverSuites(path);
        for (const sp of discovered) {
          this.suites.push(this.parser.parseSuite(sp));
        }
      } else {
        this.suites.push(this.parser.parseSuite(path));
      }
    }

    if (options.configFile) {
      this.globalConfig = this.parser.parseGlobalConfig(options.configFile);
    }

    if (options.environmentFile) {
      this.environment = this.parser.parseEnvironment(options.environmentFile);
    }

    if (this.globalConfig.variables) {
      this.globalVariables = { ...this.globalConfig.variables };
    }

    if (options.variables) {
      this.globalVariables = { ...this.globalVariables, ...options.variables };
    }
  }

  getSuites(): TestSuite[] {
    return this.suites;
  }

  getEnvironment(): EnvironmentConfig | undefined {
    return this.environment;
  }

  getGlobalConfig(): GlobalConfig {
    return this.globalConfig;
  }

  getGlobalVariables(): Record<string, any> {
    return { ...this.globalVariables };
  }

  buildVariableGraph(suite: TestSuite): VariableGraph {
    const testCaseProvides = new Map<string, string[]>();
    const testCaseConsumes = new Map<string, string[]>();
    const variableProviders = new Map<string, string>();
    const variableConsumers = new Map<string, string[]>();
    const dependencies: [string, string][] = [];

    const includedTests = this.filterByTags(suite.tests);

    for (const test of includedTests) {
      testCaseProvides.set(test.id, []);
      testCaseConsumes.set(test.id, []);

      if (test.extracts) {
        for (const extract of test.extracts) {
          const varName = this.extractVariableName(extract.name);
          testCaseProvides.get(test.id)!.push(varName);

          if (variableProviders.has(varName)) {
            throw new Error(
              `变量 ${varName} 被多个用例提取: ${variableProviders.get(varName)} 和 ${test.id}`
            );
          }
          variableProviders.set(varName, test.id);
        }
      }

      const consumedVars = this.extractConsumedVariables(test);
      testCaseConsumes.set(test.id, consumedVars);

      for (const varName of consumedVars) {
        if (!variableConsumers.has(varName)) {
          variableConsumers.set(varName, []);
        }
        variableConsumers.get(varName)!.push(test.id);
      }

      if (test.dependsOn) {
        for (const depId of test.dependsOn) {
          const depExists = includedTests.some(t => t.id === depId);
          if (depExists) {
            dependencies.push([depId, test.id]);
          }
        }
      }
    }

    for (const [varName, providerId] of variableProviders.entries()) {
      const consumers = variableConsumers.get(varName) || [];
      for (const consumerId of consumers) {
        if (consumerId !== providerId) {
          const existingDep = dependencies.some(
            ([from, to]) => from === providerId && to === consumerId
          );
          if (!existingDep) {
            dependencies.push([providerId, consumerId]);
          }
        }
      }
    }

    try {
      const allIds = includedTests.map(t => t.id);
      const sorted = toposort(dependencies);
      for (const id of allIds) {
        if (!sorted.includes(id)) {
          sorted.unshift(id);
        }
      }
    } catch (e: any) {
      throw new Error(`测试用例依赖关系存在循环: ${e.message}`);
    }

    return {
      testCaseProvides,
      testCaseConsumes,
      variableProviders,
      variableConsumers,
      dependencies,
    };
  }

  private extractVariableName(name: string): string {
    const match = name.match(VAR_REF_PATTERN);
    if (match) {
      return match[0].slice(2, -1).trim();
    }
    return name;
  }

  private extractConsumedVariables(test: TestCase): string[] {
    const consumed = new Set<string>();
    const resolver = new VariableResolver();

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
              consumed.add(cleanName);
            }
          }
        }
      } else if (Array.isArray(obj)) {
        obj.forEach(walkObject);
      } else if (typeof obj === 'object') {
        Object.values(obj).forEach(walkObject);
      }
    };

    walkObject(test.request);
    walkObject(test.assertions);
    walkObject(test.extracts);

    return Array.from(consumed);
  }

  private filterByTags(tests: TestCase[]): TestCase[] {
    return tests.filter(test => {
      if (this.excludeTags && this.excludeTags.length > 0) {
        const testTags = test.tags || [];
        if (this.excludeTags.some(tag => testTags.includes(tag))) {
          return false;
        }
      }

      if (this.tags && this.tags.length > 0) {
        const testTags = test.tags || [];
        return this.tags.some(tag => testTags.includes(tag));
      }

      return true;
    });
  }

  createShards(targetShardCount?: number): TestShard[] {
    const allShards: TestShard[] = [];

    for (const suite of this.suites) {
      const graph = this.buildVariableGraph(suite);
      this.variableGraphs.set(suite.id, graph);

      const suiteShards = this.createShardsForSuite(suite, graph, targetShardCount);
      allShards.push(...suiteShards);
    }

    this.shards = allShards;

    for (const shard of allShards) {
      this.shardStates.set(shard.id, {
        shardId: shard.id,
        status: 'pending',
        results: new Map(),
        pendingVariables: new Set(shard.requiredVariables),
        testCaseStatus: new Map(
          shard.testCases.map((tc: TestCase) => [tc.id, 'pending' as TestCaseStatus])
        ),
      });
    }

    return allShards;
  }

  private createShardsForSuite(
    suite: TestSuite,
    graph: VariableGraph,
    targetShardCount?: number
  ): TestShard[] {
    const includedTests = this.filterByTags(suite.tests);
    if (includedTests.length === 0) return [];

    const allIds = new Set(includedTests.map(t => t.id));
    const sortedIds = toposort(graph.dependencies);
    for (const id of allIds) {
      if (!sortedIds.includes(id)) {
        sortedIds.unshift(id);
      }
    }

    const idToTest = new Map(includedTests.map(t => [t.id, t]));

    const groups: string[][] = [];
    const inDegree = new Map<string, number>();

    for (const id of allIds) {
      let degree = 0;
      for (const [from, to] of graph.dependencies) {
        if (to === id && allIds.has(from)) {
          degree++;
        }
      }
      inDegree.set(id, degree);
    }

    const remaining = new Set(sortedIds);
    while (remaining.size > 0) {
      const currentGroup: string[] = [];
      for (const id of sortedIds) {
        if (remaining.has(id) && (inDegree.get(id) || 0) === 0) {
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
        for (const [from, to] of graph.dependencies) {
          if (from === id && remaining.has(to)) {
            inDegree.set(to, (inDegree.get(to) || 0) - 1);
          }
        }
      }

      groups.push(currentGroup);
    }

    const numWorkers = targetShardCount || groups.length;
    const shards: TestShard[] = [];

    for (let level = 0; level < groups.length; level++) {
      const groupIds = groups[level];
      const groupTests = groupIds
        .map(id => idToTest.get(id)!)
        .filter(Boolean);

      if (groupTests.length === 0) continue;

      const shardSize = Math.max(1, Math.ceil(groupTests.length / Math.min(numWorkers, groupTests.length)));

      for (let i = 0; i < groupTests.length; i += shardSize) {
        const shardTests = groupTests.slice(i, i + shardSize);
        const shardId = `shard-${suite.id}-${level}-${Math.floor(i / shardSize)}-${uuidv4().slice(0, 8)}`;

        const providedVariables = new Set<string>();
        const requiredVariables = new Set<string>();

        for (const test of shardTests) {
          const provides = graph.testCaseProvides.get(test.id) || [];
          const consumes = graph.testCaseConsumes.get(test.id) || [];

          for (const v of provides) {
            providedVariables.add(v);
          }
          for (const v of consumes) {
            const isProvidedInShard = shardTests.some(t =>
              (graph.testCaseProvides.get(t.id) || []).includes(v)
            );
            if (!isProvidedInShard && !this.isGlobalVariable(v)) {
              requiredVariables.add(v);
            }
          }
        }

        const dependsOnShards: string[] = [];
        for (const existingShard of shards) {
          const hasDependency = shardTests.some((test: TestCase) => {
            const deps = test.dependsOn || [];
            return deps.some((depId: string) =>
              existingShard.testCases.some((tc: TestCase) => tc.id === depId)
            );
          });

          const varDependency = Array.from(requiredVariables).some(v =>
            existingShard.providedVariables.includes(v)
          );

          if (hasDependency || varDependency) {
            if (!dependsOnShards.includes(existingShard.id)) {
              dependsOnShards.push(existingShard.id);
            }
          }
        }

        shards.push({
          id: shardId,
          suiteId: suite.id,
          suite: { ...suite, tests: [] },
          testCases: shardTests,
          dependencyLevel: level,
          requiredVariables: Array.from(requiredVariables),
          providedVariables: Array.from(providedVariables),
          dependsOnShards,
        });
      }
    }

    return shards;
  }

  private isGlobalVariable(varName: string): boolean {
    if (varName in this.globalVariables) return true;
    if (this.environment?.variables && varName in this.environment.variables) return true;
    return false;
  }

  getShards(): TestShard[] {
    return this.shards;
  }

  getShard(shardId: string): TestShard | undefined {
    return this.shards.find(s => s.id === shardId);
  }

  getShardState(shardId: string): ShardExecutionState | undefined {
    return this.shardStates.get(shardId);
  }

  updateShardState(shardId: string, updates: Partial<ShardExecutionState>): void {
    const state = this.shardStates.get(shardId);
    if (state) {
      Object.assign(state, updates);
      this.shardStates.set(shardId, state);
    }
  }

  getReadyShards(): TestShard[] {
    return this.shards.filter(shard => {
      const state = this.shardStates.get(shard.id);
      if (!state || state.status !== 'pending') return false;

      const dependenciesSatisfied = shard.dependsOnShards.every((depShardId: string) => {
        const depState = this.shardStates.get(depShardId);
        return depState && depState.status === 'completed';
      });

      const variablesSatisfied = state.pendingVariables.size === 0;

      return dependenciesSatisfied && variablesSatisfied;
    });
  }

  updateVariableAvailability(shardId: string, variables: Record<string, any>): void {
    const varNames = Object.keys(variables);

    for (const [, state] of this.shardStates) {
      if (state.shardId === shardId) continue;

      for (const varName of varNames) {
        if (state.pendingVariables.has(varName)) {
          state.pendingVariables.delete(varName);
        }
      }
    }
  }

  getTotalTestCaseCount(): number {
    return this.shards.reduce((sum, shard) => sum + shard.testCases.length, 0);
  }

  getVariableGraph(suiteId: string): VariableGraph | undefined {
    return this.variableGraphs.get(suiteId);
  }
}
