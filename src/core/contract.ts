import fs from 'fs';
import path from 'path';
import jsondiffpatch from 'jsondiffpatch';
import { ContractDiff } from '../types';

export interface ContractCheckOptions {
  customPath?: string;
  strict?: boolean;
  updateSnapshot?: boolean;
}

export interface ContractCheckResult {
  passed: boolean;
  isNew: boolean;
  updated: boolean;
  snapshotPath: string;
  diffs?: ContractDiff[];
  baseline?: any;
  current?: any;
}

export class ContractManager {
  private snapshotDir: string;

  constructor(snapshotDir: string) {
    this.snapshotDir = path.resolve(snapshotDir);
    this.ensureDir(this.snapshotDir);
  }

  async checkContract(
    testCaseId: string,
    testCaseName: string,
    assertionId: string,
    currentBody: any,
    options: ContractCheckOptions = {}
  ): Promise<ContractCheckResult> {
    const { customPath, strict = false, updateSnapshot = false } = options;

    const snapshotPath = customPath
      ? path.resolve(customPath)
      : this.getDefaultSnapshotPath(testCaseId, assertionId);

    const currentStructure = this.extractStructure(currentBody);

    if (!fs.existsSync(snapshotPath)) {
      this.ensureDir(path.dirname(snapshotPath));
      this.saveSnapshot(snapshotPath, {
        testCaseId,
        testCaseName,
        assertionId,
        createdAt: new Date().toISOString(),
        structure: currentStructure,
        sample: this.truncateBody(currentBody)
      });

      return {
        passed: true,
        isNew: true,
        updated: false,
        snapshotPath
      };
    }

    const baseline = this.loadSnapshot(snapshotPath);

    if (updateSnapshot) {
      this.saveSnapshot(snapshotPath, {
        ...baseline,
        testCaseId,
        testCaseName,
        assertionId,
        updatedAt: new Date().toISOString(),
        structure: currentStructure,
        sample: this.truncateBody(currentBody)
      });

      const diffs = this.computeDiffs(baseline.structure, currentStructure, strict);

      return {
        passed: true,
        isNew: false,
        updated: true,
        snapshotPath,
        diffs: diffs.length > 0 ? diffs : undefined,
        baseline: baseline.structure,
        current: currentStructure
      };
    }

    const diffs = this.computeDiffs(baseline.structure, currentStructure, strict);

    return {
      passed: diffs.length === 0,
      isNew: false,
      updated: false,
      snapshotPath,
      diffs: diffs.length > 0 ? diffs : undefined,
      baseline: baseline.structure,
      current: currentStructure
    };
  }

  private getDefaultSnapshotPath(testCaseId: string, assertionId: string): string {
    const safeCaseId = testCaseId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeAssertionId = assertionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.snapshotDir, `${safeCaseId}__${safeAssertionId}.snap.json`);
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private saveSnapshot(filePath: string, data: any): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private loadSnapshot(filePath: string): any {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }

  private extractStructure(value: any): any {
    if (value === null) return { __type: 'null' };
    if (value === undefined) return { __type: 'undefined' };

    const type = typeof value;

    if (type === 'string') {
      return { __type: 'string' };
    }

    if (type === 'number') {
      return { __type: 'number' };
    }

    if (type === 'boolean') {
      return { __type: 'boolean' };
    }

    if (Array.isArray(value)) {
      return {
        __type: 'array',
        __itemType: this.extractArrayItemType(value)
      };
    }

    if (type === 'object') {
      const objStructure: Record<string, any> = { __type: 'object' };
      for (const key of Object.keys(value)) {
        objStructure[key] = this.extractStructure(value[key]);
      }
      return objStructure;
    }

    return { __type: type };
  }

  private extractArrayItemType(array: any[]): any {
    if (array.length === 0) {
      return { __type: 'unknown' };
    }

    const itemStructures = array.map(item => this.extractStructure(item));
    const firstType = JSON.stringify(itemStructures[0]);
    const allSame = itemStructures.every(s => JSON.stringify(s) === firstType);

    if (allSame) {
      return itemStructures[0];
    }

    return {
      __type: 'mixed',
      __variants: itemStructures
    };
  }

  private truncateBody(body: any, maxSize: number = 10000): any {
    const jsonStr = JSON.stringify(body);
    if (jsonStr.length <= maxSize) {
      return body;
    }

    return this.truncateObject(body, Math.floor(maxSize / 100));
  }

  private truncateObject(obj: any, depth: number): any {
    if (depth <= 0) return '[Truncated]';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.slice(0, 10).map(item => this.truncateObject(item, depth - 1));
    }

    const result: Record<string, any> = {};
    const keys = Object.keys(obj).slice(0, 50);
    for (const key of keys) {
      result[key] = this.truncateObject(obj[key], depth - 1);
    }
    return result;
  }

  private computeDiffs(baseline: any, current: any, strict: boolean, basePath: string = ''): ContractDiff[] {
    const diffs: ContractDiff[] = [];

    if (baseline === null || current === null || baseline === undefined || current === undefined) {
      return diffs;
    }

    const baselineType = baseline.__type;
    const currentType = current.__type;

    if (baselineType !== currentType) {
      diffs.push({
        type: 'typeChanged',
        path: basePath || '/',
        oldType: baselineType,
        newType: currentType
      });
      return diffs;
    }

    if (baselineType === 'object') {
      const baselineKeys = Object.keys(baseline).filter(k => k !== '__type');
      const currentKeys = Object.keys(current).filter(k => k !== '__type');

      for (const key of currentKeys) {
        if (!baselineKeys.includes(key)) {
          diffs.push({
            type: 'added',
            path: basePath ? `${basePath}.${key}` : `.${key}`,
            newValue: current[key]
          });
        }
      }

      for (const key of baselineKeys) {
        const childPath = basePath ? `${basePath}.${key}` : `.${key}`;
        if (!currentKeys.includes(key)) {
          diffs.push({
            type: 'removed',
            path: childPath,
            oldValue: baseline[key]
          });
        } else {
          diffs.push(...this.computeDiffs(baseline[key], current[key], strict, childPath));
        }
      }
    } else if (baselineType === 'array') {
      const baselineItemType = baseline.__itemType;
      const currentItemType = current.__itemType;

      if (baselineItemType?.__type !== currentItemType?.__type && strict) {
        diffs.push({
          type: 'typeChanged',
          path: basePath ? `${basePath}[]` : '[]',
          oldType: baselineItemType?.__type,
          newType: currentItemType?.__type
        });
      }
    }

    return diffs;
  }

  listSnapshots(): string[] {
    if (!fs.existsSync(this.snapshotDir)) {
      return [];
    }
    return fs.readdirSync(this.snapshotDir)
      .filter(f => f.endsWith('.snap.json'))
      .map(f => path.join(this.snapshotDir, f));
  }

  deleteSnapshots(ids?: string[]): number {
    const snapshots = this.listSnapshots();
    let deleted = 0;

    for (const snapPath of snapshots) {
      if (ids) {
        const fileName = path.basename(snapPath);
        const match = ids.some(id => fileName.startsWith(id.replace(/[^a-zA-Z0-9_-]/g, '_')));
        if (!match) continue;
      }
      fs.unlinkSync(snapPath);
      deleted++;
    }

    return deleted;
  }
}
