import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import $RefParser from 'json-schema-ref-parser';
import { JSONPath } from 'jsonpath-plus';
import { AssertionConfig, AssertionResult, AssertionOperator, SeverityLevel } from '../types';
import { ReceivedResponse } from './httpClient';
import { VariableResolver } from './variables';
import { ContractManager, ContractCheckResult } from './contract';

export class AssertionEngine {
  private ajv: Ajv;
  private contractManager: ContractManager;
  private resolver: VariableResolver;
  private updateSnapshots: boolean;

  constructor(
    resolver: VariableResolver,
    snapshotDir: string,
    updateSnapshots: boolean = false
  ) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      verbose: true,
      logger: false
    });
    addFormats(this.ajv);
    this.contractManager = new ContractManager(snapshotDir);
    this.resolver = resolver;
    this.updateSnapshots = updateSnapshots;
  }

  async runAssertions(
    assertions: AssertionConfig[],
    response: ReceivedResponse | null,
    testCaseId: string,
    testCaseName: string
  ): Promise<AssertionResult[]> {
    const results: AssertionResult[] = [];

    for (let i = 0; i < assertions.length; i++) {
      const assertion = assertions[i];
      const assertionId = assertion.id || `${testCaseId}-assertion-${i + 1}`;
      const severity = assertion.severity || 'high';

      if (!response) {
        results.push({
          assertionId,
          type: this.getAssertionType(assertion),
          severity,
          passed: false,
          message: '无法执行断言：未收到响应',
          description: assertion.description
        });
        continue;
      }

      try {
        const resolvedAssertion = this.resolver.resolve(assertion);
        const result = await this.runSingleAssertion(
          resolvedAssertion,
          assertionId,
          response,
          testCaseId,
          testCaseName,
          severity
        );
        results.push(result);
      } catch (error: any) {
        results.push({
          assertionId,
          type: this.getAssertionType(assertion),
          severity,
          passed: false,
          message: `断言执行异常: ${error.message}`,
          description: assertion.description
        });
      }
    }

    return results;
  }

  private async runSingleAssertion(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    testCaseId: string,
    testCaseName: string,
    severity: SeverityLevel
  ): Promise<AssertionResult> {
    if (assertion.statusCode !== undefined) {
      return this.assertStatusCode(assertion, assertionId, response, severity);
    }

    if (assertion.responseTime !== undefined) {
      return this.assertResponseTime(assertion, assertionId, response, severity);
    }

    if (assertion.jsonPath) {
      return this.assertJsonPath(assertion, assertionId, response, severity);
    }

    if (assertion.jsonSchema) {
      return this.assertJsonSchema(assertion, assertionId, response, severity);
    }

    if (assertion.headerExists) {
      return this.assertHeaderExists(assertion, assertionId, response, severity);
    }

    if (assertion.headerEquals) {
      return this.assertHeaderEquals(assertion, assertionId, response, severity);
    }

    if (assertion.bodyContains) {
      return this.assertBodyContains(assertion, assertionId, response, severity);
    }

    if (assertion.contract) {
      return this.assertContract(assertion, assertionId, response, testCaseId, testCaseName, severity);
    }

    return {
      assertionId,
      type: 'unknown',
      severity,
      passed: false,
      message: '不支持的断言类型',
      description: assertion.description
    };
  }

  private assertStatusCode(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const expected = assertion.statusCode!;
    const actual = response.status;
    const passed = actual === expected;

    return {
      assertionId,
      type: 'statusCode',
      severity,
      passed,
      message: passed
        ? `状态码匹配: ${actual}`
        : `状态码不匹配。期望: ${expected}, 实际: ${actual}`,
      expected,
      actual,
      description: assertion.description
    };
  }

  private assertResponseTime(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const maxTime = assertion.responseTime!;
    const actual = response.time;
    const passed = actual <= maxTime;

    return {
      assertionId,
      type: 'responseTime',
      severity,
      passed,
      message: passed
        ? `响应时间符合要求: ${actual}ms (上限: ${maxTime}ms)`
        : `响应时间超过上限。上限: ${maxTime}ms, 实际: ${actual}ms`,
      expected: maxTime,
      actual,
      description: assertion.description
    };
  }

  private assertJsonPath(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const { path, operator, expected } = assertion.jsonPath!;

    let actualValue: any;
    try {
      if (path.startsWith('$')) {
        actualValue = JSONPath({
          path,
          json: response.body,
          wrap: false
        });
      } else {
        actualValue = this.getNestedValue(response.body, path);
      }
    } catch (e: any) {
      return {
        assertionId,
        type: 'jsonPath',
        severity,
        passed: false,
        message: `JSONPath解析失败: ${e.message}`,
        description: assertion.description
      };
    }

    const { passed, message } = this.compareWithOperator(actualValue, operator, expected, path);

    return {
      assertionId,
      type: 'jsonPath',
      severity,
      passed,
      message,
      expected,
      actual: actualValue,
      description: assertion.description
    };
  }

  private compareWithOperator(
    actual: any,
    operator: AssertionOperator,
    expected: any,
    path: string
  ): { passed: boolean; message: string } {
    const actualStr = this.stringifyValue(actual);
    const expectedStr = this.stringifyValue(expected);

    switch (operator) {
      case 'eq': {
        const passed = this.deepEqual(actual, expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 等于期望值`
            : `JSONPath [${path}] 不等于期望值。期望: ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'neq': {
        const passed = !this.deepEqual(actual, expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 不等于期望值（符合预期）`
            : `JSONPath [${path}] 等于期望值（不符合预期）。值: ${expectedStr}`
        };
      }

      case 'contains': {
        const passed = this.contains(actual, expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 包含期望值`
            : `JSONPath [${path}] 不包含期望值。期望包含: ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'notContains': {
        const passed = !this.contains(actual, expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 不包含期望值（符合预期）`
            : `JSONPath [${path}] 包含期望值（不符合预期）。值: ${expectedStr}`
        };
      }

      case 'regex': {
        if (actual === null || actual === undefined) {
          return { passed: false, message: `JSONPath [${path}] 值为null或undefined，无法进行正则匹配` };
        }
        const regex = typeof expected === 'string' ? new RegExp(expected) : expected as RegExp;
        const passed = regex.test(String(actual));
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 匹配正则`
            : `JSONPath [${path}] 不匹配正则。正则: ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'gt': {
        const passed = Number(actual) > Number(expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 大于期望值`
            : `JSONPath [${path}] 不大于期望值。期望 > ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'gte': {
        const passed = Number(actual) >= Number(expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 大于等于期望值`
            : `JSONPath [${path}] 小于期望值。期望 >= ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'lt': {
        const passed = Number(actual) < Number(expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 小于期望值`
            : `JSONPath [${path}] 不小于期望值。期望 < ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'lte': {
        const passed = Number(actual) <= Number(expected);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 小于等于期望值`
            : `JSONPath [${path}] 大于期望值。期望 <= ${expectedStr}, 实际: ${actualStr}`
        };
      }

      case 'exists': {
        const passed = actual !== undefined && actual !== null;
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 存在`
            : `JSONPath [${path}] 不存在（值为null或undefined）`
        };
      }

      case 'notExists': {
        const passed = actual === undefined || actual === null;
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 不存在（符合预期）`
            : `JSONPath [${path}] 存在（不符合预期）。值: ${actualStr}`
        };
      }

      case 'isEmpty': {
        const passed = this.isEmpty(actual);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 为空`
            : `JSONPath [${path}] 不为空。实际值: ${actualStr}`
        };
      }

      case 'isNotEmpty': {
        const passed = !this.isEmpty(actual);
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 不为空`
            : `JSONPath [${path}] 为空`
        };
      }

      case 'type': {
        const actualType = this.getTypeName(actual);
        const expectedType = String(expected).toLowerCase();
        const passed = actualType === expectedType;
        return {
          passed,
          message: passed
            ? `JSONPath [${path}] 类型匹配: ${actualType}`
            : `JSONPath [${path}] 类型不匹配。期望类型: ${expectedType}, 实际类型: ${actualType}`
        };
      }

      default:
        return { passed: false, message: `未知的操作符: ${operator}` };
    }
  }

  private assertJsonSchema(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const schema = assertion.jsonSchema!;

    try {
      let resolvedSchema: Record<string, any> = schema;
      if (schema.$ref || JSON.stringify(schema).includes('"$ref"')) {
        try {
          const parser = new ($RefParser as any)();
          if (typeof parser.dereference === 'function') {
            resolvedSchema = parser.dereference(schema);
          }
        } catch {
          // fallback to using schema as-is
        }
      }

      const validate = this.ajv.compile(schema);
      const valid = validate(response.body);

      if (valid) {
        return {
          assertionId,
          type: 'jsonSchema',
          severity,
          passed: true,
          message: 'JSON Schema校验通过',
          description: assertion.description
        };
      } else {
        const errors = validate.errors || [];
        const errorMessages = errors.map((e: any) => {
          const path = e.instancePath || '/';
          return `${path}: ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`;
        });

        return {
          assertionId,
          type: 'jsonSchema',
          severity,
          passed: false,
          message: `JSON Schema校验失败。\n${errorMessages.join('\n')}`,
          diff: errors,
          description: assertion.description
        };
      }
    } catch (error: any) {
      return {
        assertionId,
        type: 'jsonSchema',
        severity,
        passed: false,
        message: `JSON Schema校验异常: ${error.message}`,
        description: assertion.description
      };
    }
  }

  private assertHeaderExists(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const headerName = assertion.headerExists!;
    const headerKey = Object.keys(response.headers).find(
      h => h.toLowerCase() === headerName.toLowerCase()
    );
    const exists = headerKey !== undefined;

    return {
      assertionId,
      type: 'headerExists',
      severity,
      passed: exists,
      message: exists
        ? `响应头存在: ${headerName}`
        : `响应头不存在: ${headerName}`,
      expected: headerName,
      actual: headerKey ? response.headers[headerKey] : undefined,
      description: assertion.description
    };
  }

  private assertHeaderEquals(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const { name, value } = assertion.headerEquals!;
    const headerKey = Object.keys(response.headers).find(
      h => h.toLowerCase() === name.toLowerCase()
    );

    if (!headerKey) {
      return {
        assertionId,
        type: 'headerEquals',
        severity,
        passed: false,
        message: `响应头不存在: ${name}`,
        expected: value,
        description: assertion.description
      };
    }

    const actual = response.headers[headerKey];
    const passed = String(actual) === String(value);

    return {
      assertionId,
      type: 'headerEquals',
      severity,
      passed,
      message: passed
        ? `响应头匹配: ${name}: ${actual}`
        : `响应头不匹配: ${name}。期望: ${value}, 实际: ${actual}`,
      expected: value,
      actual,
      description: assertion.description
    };
  }

  private assertBodyContains(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    severity: SeverityLevel
  ): AssertionResult {
    const expected = assertion.bodyContains!;
    const bodyStr = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    const passed = bodyStr.includes(expected);

    return {
      assertionId,
      type: 'bodyContains',
      severity,
      passed,
      message: passed
        ? `响应体包含期望内容`
        : `响应体不包含期望内容: ${expected}`,
      expected,
      description: assertion.description
    };
  }

  private async assertContract(
    assertion: AssertionConfig,
    assertionId: string,
    response: ReceivedResponse,
    testCaseId: string,
    testCaseName: string,
    severity: SeverityLevel
  ): Promise<AssertionResult> {
    const contractConfig = assertion.contract!;
    const snapshotPath = contractConfig.snapshotPath;
    const strict = contractConfig.strict !== false;

    let checkResult: ContractCheckResult;
    try {
      checkResult = await this.contractManager.checkContract(
        testCaseId,
        testCaseName,
        assertionId,
        response.body,
        {
          customPath: snapshotPath,
          strict,
          updateSnapshot: this.updateSnapshots
        }
      );
    } catch (error: any) {
      return {
        assertionId,
        type: 'contract',
        severity,
        passed: false,
        message: `契约校验异常: ${error.message}`,
        description: assertion.description
      };
    }

    if (checkResult.isNew) {
      return {
        assertionId,
        type: 'contract',
        severity,
        passed: true,
        message: `首次执行，已生成基线快照: ${checkResult.snapshotPath}`,
        description: assertion.description
      };
    }

    if (checkResult.updated) {
      return {
        assertionId,
        type: 'contract',
        severity,
        passed: true,
        message: `基线快照已更新: ${checkResult.snapshotPath}`,
        diff: checkResult.diffs,
        description: assertion.description
      };
    }

    if (checkResult.passed) {
      return {
        assertionId,
        type: 'contract',
        severity,
        passed: true,
        message: '契约校验通过，响应结构与基线一致',
        description: assertion.description
      };
    }

    const diffMessages = checkResult.diffs!.map(d => {
      switch (d.type) {
        case 'added':
          return `[新增] ${d.path} = ${this.stringifyValue(d.newValue)}`;
        case 'removed':
          return `[缺失] ${d.path}`;
        case 'changed':
          return `[变更] ${d.path}: ${this.stringifyValue(d.oldValue)} → ${this.stringifyValue(d.newValue)}`;
        case 'typeChanged':
          return `[类型变更] ${d.path}: ${d.oldType} → ${d.newType}`;
        default:
          return `${d.path}`;
      }
    });

    return {
      assertionId,
      type: 'contract',
      severity,
      passed: false,
      message: `契约校验失败，发现 ${checkResult.diffs!.length} 处差异:\n${diffMessages.join('\n')}`,
      diff: checkResult.diffs,
      description: assertion.description
    };
  }

  private getAssertionType(assertion: AssertionConfig): string {
    if (assertion.statusCode !== undefined) return 'statusCode';
    if (assertion.responseTime !== undefined) return 'responseTime';
    if (assertion.jsonPath) return 'jsonPath';
    if (assertion.jsonSchema) return 'jsonSchema';
    if (assertion.headerExists) return 'headerExists';
    if (assertion.headerEquals) return 'headerEquals';
    if (assertion.bodyContains) return 'bodyContains';
    if (assertion.contract) return 'contract';
    return 'unknown';
  }

  private getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, key, indexStr] = arrayMatch;
        const index = parseInt(indexStr, 10);
        current = current[key];
        if (Array.isArray(current) && index >= 0 && index < current.length) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        if (typeof current !== 'object' || !(part in current)) {
          return undefined;
        }
        current = current[part];
      }
    }

    return current;
  }

  private deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;

    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
      if (a.length !== (b as any[]).length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.deepEqual(a[i], (b as any[])[i])) return false;
      }
      return true;
    }

    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!this.deepEqual(a[keysA[i]], b[keysB[i]])) return false;
    }
    return true;
  }

  private contains(container: any, target: any): boolean {
    if (container === null || container === undefined) return false;
    if (typeof container === 'string') {
      return container.includes(String(target));
    }
    if (Array.isArray(container)) {
      return container.some(item => this.deepEqual(item, target));
    }
    if (typeof container === 'object' && target !== null && typeof target === 'object') {
      for (const key of Object.keys(target)) {
        if (!this.deepEqual(container[key], (target as Record<string, any>)[key])) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  private isEmpty(value: any): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  private getTypeName(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  private stringifyValue(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
