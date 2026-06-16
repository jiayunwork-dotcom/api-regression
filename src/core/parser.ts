import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { TestSuite, TestCase, EnvironmentConfig, GlobalConfig } from '../types';

export class ConfigParser {
  parseSuite(filePath: string): TestSuite {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`测试套件文件不存在: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = YAML.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`测试套件文件格式无效: ${absolutePath}`);
    }

    return this.validateAndTransformSuite(parsed, absolutePath);
  }

  parseEnvironment(filePath: string): EnvironmentConfig {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`环境配置文件不存在: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = YAML.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`环境配置文件格式无效: ${absolutePath}`);
    }

    return this.validateEnvironment(parsed, absolutePath);
  }

  parseGlobalConfig(filePath: string): GlobalConfig {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`全局配置文件不存在: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = YAML.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return this.validateGlobalConfig(parsed);
  }

  parseDataFile(filePath: string, type: 'csv' | 'json', baseDir?: string): Record<string, any>[] {
    let absolutePath: string;
    if (baseDir && !path.isAbsolute(filePath)) {
      absolutePath = path.resolve(baseDir, filePath);
    } else {
      absolutePath = path.resolve(filePath);
    }
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`数据文件不存在: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');

    if (type === 'json') {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error(`JSON数据文件必须是数组格式: ${absolutePath}`);
      }
      return parsed;
    } else {
      return this.parseCsv(content);
    }
  }

  private parseCsv(content: string): Record<string, any>[] {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length === 0) {
      return [];
    }

    const headers = this.parseCsvLine(lines[0]);
    const rows: Record<string, any>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCsvLine(lines[i]);
      const row: Record<string, any> = {};
      headers.forEach((header, index) => {
        let value = values[index] ?? '';
        value = this.autoTypeCsvValue(value);
        row[header] = value;
      });
      rows.push(row);
    }

    return rows;
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = line[i + 1];

      if (inQuotes) {
        if (char === '"' && next === '"') {
          current += '"';
          i++;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          current += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
    }
    result.push(current);
    return result;
  }

  private autoTypeCsvValue(value: string): any {
    const trimmed = value.trim();
    if (trimmed === '') return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed !== '' && /^-?\d*\.?\d+$/.test(trimmed)) {
      return num;
    }
    return value;
  }

  private validateAndTransformSuite(raw: any, filePath: string): TestSuite {
    const suiteId = raw.id || path.basename(filePath, path.extname(filePath));
    const suiteName = raw.name || suiteId;

    if (!raw.tests || !Array.isArray(raw.tests)) {
      throw new Error(`测试套件必须包含tests数组: ${filePath}`);
    }

    const seenIds = new Set<string>();
    const tests: TestCase[] = raw.tests.map((t: any, idx: number) => {
      const testId = t.id || `${suiteId}-test-${idx + 1}`;
      if (seenIds.has(testId)) {
        throw new Error(`测试用例ID重复: ${testId} in ${filePath}`);
      }
      seenIds.add(testId);
      return this.validateTestCase(t, testId, filePath);
    });

    return {
      id: suiteId,
      name: suiteName,
      description: raw.description,
      baseUrl: raw.baseUrl,
      filePath: filePath,
      defaults: raw.defaults ? {
        headers: raw.defaults.headers,
        timeout: raw.defaults.timeout,
        retry: raw.defaults.retry
      } : undefined,
      before: raw.before ? {
        variables: raw.before.variables
      } : undefined,
      tests
    };
  }

  private validateTestCase(raw: any, testId: string, filePath: string): TestCase {
    if (!raw.request) {
      throw new Error(`测试用例缺少request: ${testId} in ${filePath}`);
    }

    const { method, url } = raw.request;
    if (!method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      throw new Error(`无效的HTTP方法: ${method} in ${testId}`);
    }
    if (!url) {
      throw new Error(`缺少请求URL: ${testId} in ${filePath}`);
    }

    if (!raw.assertions || !Array.isArray(raw.assertions)) {
      throw new Error(`测试用例必须包含assertions数组: ${testId} in ${filePath}`);
    }

    const testCase: TestCase = {
      id: testId,
      name: raw.name || testId,
      description: raw.description,
      tags: raw.tags,
      dependsOn: raw.dependsOn,
      request: {
        method: method.toUpperCase(),
        url,
        headers: raw.request.headers,
        body: raw.request.body,
        queryParams: raw.request.queryParams,
        timeout: raw.request.timeout,
        followRedirects: raw.request.followRedirects
      },
      extracts: raw.extracts,
      assertions: raw.assertions.map((a: any, aidx: number) => ({
        id: a.id || `${testId}-assertion-${aidx + 1}`,
        severity: a.severity || 'high',
        statusCode: a.statusCode,
        responseTime: a.responseTime,
        jsonPath: a.jsonPath,
        jsonSchema: a.jsonSchema,
        headerExists: a.headerExists,
        headerEquals: a.headerEquals,
        bodyContains: a.bodyContains,
        contract: a.contract,
        description: a.description
      })),
      dataSource: raw.dataSource,
      retry: raw.retry,
      skip: raw.skip
    };

    return testCase;
  }

  private validateEnvironment(raw: any, filePath: string): EnvironmentConfig {
    if (!raw.name) {
      throw new Error(`环境配置缺少name: ${filePath}`);
    }
    if (!raw.baseUrl) {
      throw new Error(`环境配置缺少baseUrl: ${filePath}`);
    }

    return {
      name: raw.name,
      baseUrl: raw.baseUrl,
      variables: raw.variables,
      headers: raw.headers
    };
  }

  private validateGlobalConfig(raw: any): GlobalConfig {
    const config: GlobalConfig = {};

    if (raw.concurrency !== undefined) config.concurrency = raw.concurrency;
    if (raw.timeout !== undefined) config.timeout = raw.timeout;
    if (raw.retries !== undefined) config.retries = raw.retries;
    if (raw.variables) config.variables = raw.variables;
    if (raw.headers) config.headers = raw.headers;
    if (raw.output) {
      config.output = {
        html: raw.output.html,
        json: raw.output.json,
        junit: raw.output.junit,
        snapshots: raw.output.snapshots,
        failed: raw.output.failed
      };
    }

    return config;
  }

  discoverSuites(dirPath: string): string[] {
    const absolutePath = path.resolve(dirPath);
    const results: string[] = [];

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`目录不存在: ${absolutePath}`);
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
      if (absolutePath.endsWith('.yml') || absolutePath.endsWith('.yaml')) {
        return [absolutePath];
      }
      return [];
    }

    const entries = fs.readdirSync(absolutePath);
    for (const entry of entries) {
      const fullPath = path.join(absolutePath, entry);
      const entryStat = fs.statSync(fullPath);
      if (entryStat.isDirectory()) {
        results.push(...this.discoverSuites(fullPath));
      } else if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
        results.push(fullPath);
      }
    }

    return results.sort();
  }
}
