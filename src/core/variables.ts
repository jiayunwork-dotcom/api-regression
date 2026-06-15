import { JSONPath } from 'jsonpath-plus';
import { ExtractConfig } from '../types';

const VAR_PATTERN = /\$\{([^}]+)\}/g;
const MAX_RESOLVE_DEPTH = 50;

export class VariableResolver {
  private globalVars: Record<string, any>;
  private environmentVars: Record<string, any>;
  private suiteVars: Record<string, any>;
  private extractedVars: Record<string, any>;
  private runtimeVars: Record<string, any>;

  constructor() {
    this.globalVars = {};
    this.environmentVars = {};
    this.suiteVars = {};
    this.extractedVars = {};
    this.runtimeVars = {};
  }

  setGlobalVars(vars: Record<string, any>): void {
    this.globalVars = { ...vars };
  }

  setEnvironmentVars(vars: Record<string, any>): void {
    this.environmentVars = { ...vars };
  }

  setSuiteVars(vars: Record<string, any>): void {
    this.suiteVars = { ...vars };
  }

  setExtractedVars(vars: Record<string, any>): void {
    this.extractedVars = { ...vars };
  }

  addExtractedVar(name: string, value: any): void {
    this.extractedVars[name] = value;
  }

  setRuntimeVars(vars: Record<string, any>): void {
    this.runtimeVars = { ...vars };
  }

  addRuntimeVar(name: string, value: any): void {
    this.runtimeVars[name] = value;
  }

  getAllVars(): Record<string, any> {
    return {
      ...this.globalVars,
      ...this.environmentVars,
      ...this.suiteVars,
      ...this.extractedVars,
      ...this.runtimeVars
    };
  }

  resolve<T = any>(value: T, resolving: Set<string> = new Set()): T {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.resolveString(value, resolving) as unknown as T;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolve(item, new Set(resolving))) as unknown as T;
    }

    if (typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.resolve(val, new Set(resolving));
      }
      return result as T;
    }

    return value;
  }

  private resolveString(str: string, resolving: Set<string>): any {
    if (resolving.size > MAX_RESOLVE_DEPTH) {
      throw new Error(`变量解析深度超过限制，可能存在循环引用。当前解析链: ${Array.from(resolving).join(' -> ')}`);
    }

    if (!str.includes('${')) {
      return str;
    }

    if (VAR_PATTERN.test(str) && str.match(VAR_PATTERN)?.length === 1 && str.startsWith('${') && str.endsWith('}')) {
      const varName = str.slice(2, -1).trim();
      return this.resolveSingleVar(varName, resolving);
    }

    return str.replace(VAR_PATTERN, (match, varName) => {
      const name = varName.trim();
      const resolved = this.resolveSingleVar(name, new Set(resolving));
      if (resolved === null || resolved === undefined) {
        return match;
      }
      if (typeof resolved === 'object') {
        return JSON.stringify(resolved);
      }
      return String(resolved);
    });
  }

  private resolveSingleVar(varName: string, resolving: Set<string>): any {
    if (resolving.has(varName)) {
      const chain = Array.from(resolving).concat(varName).join(' -> ');
      throw new Error(`检测到循环引用: ${chain}`);
    }

    const allVars = this.getAllVars();

    if (varName.includes(':')) {
      const [source, key] = varName.split(':');
      let sourceVars: Record<string, any>;
      switch (source.toLowerCase()) {
        case 'global':
          sourceVars = this.globalVars;
          break;
        case 'env':
        case 'environment':
          sourceVars = this.environmentVars;
          break;
        case 'suite':
          sourceVars = this.suiteVars;
          break;
        case 'extracted':
        case 'extract':
          sourceVars = this.extractedVars;
          break;
        case 'runtime':
          sourceVars = this.runtimeVars;
          break;
        default:
          sourceVars = allVars;
      }

      let value = this.getNestedValue(sourceVars, key);
      if (value !== undefined) {
        resolving.add(varName);
        value = this.resolve(value, new Set(resolving));
        resolving.delete(varName);
        return value;
      }
      return undefined;
    }

    let value = this.getNestedValue(allVars, varName);
    if (value !== undefined) {
      resolving.add(varName);
      value = this.resolve(value, new Set(resolving));
      resolving.delete(varName);
      return value;
    }

    if (varName.startsWith('process.env.') || varName.startsWith('env:')) {
      const envKey = varName.startsWith('process.env.')
        ? varName.slice(12)
        : varName.slice(4);
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        resolving.add(varName);
        const resolved = this.resolveString(envValue, new Set(resolving));
        resolving.delete(varName);
        return resolved;
      }
    }

    return undefined;
  }

  private getNestedValue(obj: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let current: any = obj;

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

  extractFromResponse(
    extracts: ExtractConfig[],
    response: {
      status: number;
      headers: Record<string, string>;
      body: any;
      cookies?: Record<string, string>;
    }
  ): Record<string, any> {
    const result: Record<string, any> = {};

    for (const extract of extracts) {
      try {
        let value: any;

        switch (extract.from) {
          case 'status':
            value = response.status;
            break;

          case 'body':
            if (extract.path) {
              if (extract.path.startsWith('$')) {
                const jsonPathResult = JSONPath({
                  path: extract.path,
                  json: response.body,
                  wrap: false
                });
                value = jsonPathResult;
              } else {
                value = this.getNestedValue(response.body, extract.path);
              }
            } else {
              value = response.body;
            }
            break;

          case 'headers':
            if (extract.header) {
              const headerKey = Object.keys(response.headers).find(
                h => h.toLowerCase() === extract.header!.toLowerCase()
              );
              value = headerKey ? response.headers[headerKey] : undefined;
            } else if (extract.path) {
              value = this.getNestedValue(response.headers, extract.path);
            }
            break;

          case 'cookies':
            if (extract.cookie) {
              value = response.cookies?.[extract.cookie];
            } else if (extract.path) {
              value = this.getNestedValue(response.cookies || {}, extract.path);
            }
            break;

          default:
            throw new Error(`未知的提取来源: ${extract.from}`);
        }

        if (value !== undefined) {
          result[extract.name] = value;
        }
      } catch (e: any) {
        throw new Error(`提取变量 ${extract.name} 失败: ${e.message}`);
      }
    }

    return result;
  }

  clearExtractedVars(): void {
    this.extractedVars = {};
  }

  clearRuntimeVars(): void {
    this.runtimeVars = {};
  }

  snapshot(): {
    globalVars: Record<string, any>;
    environmentVars: Record<string, any>;
    suiteVars: Record<string, any>;
    extractedVars: Record<string, any>;
  } {
    return {
      globalVars: JSON.parse(JSON.stringify(this.globalVars)),
      environmentVars: JSON.parse(JSON.stringify(this.environmentVars)),
      suiteVars: JSON.parse(JSON.stringify(this.suiteVars)),
      extractedVars: JSON.parse(JSON.stringify(this.extractedVars))
    };
  }

  restore(snapshot: {
    globalVars: Record<string, any>;
    environmentVars: Record<string, any>;
    suiteVars: Record<string, any>;
    extractedVars: Record<string, any>;
  }): void {
    this.globalVars = JSON.parse(JSON.stringify(snapshot.globalVars));
    this.environmentVars = JSON.parse(JSON.stringify(snapshot.environmentVars));
    this.suiteVars = JSON.parse(JSON.stringify(snapshot.suiteVars));
    this.extractedVars = JSON.parse(JSON.stringify(snapshot.extractedVars));
  }
}
