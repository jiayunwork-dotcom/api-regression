import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { RunSummary, ExecutionResult, AssertionResult, SuiteExecutionResult, SeverityLevel } from '../types';

const severityColors: Record<SeverityLevel, chalk.Chalk> = {
  critical: chalk.bgRed.white,
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.blue,
  info: chalk.gray
};

export class ReportGenerator {
  private outputDir: string;
  private verbose: boolean;
  private silent: boolean;

  constructor(outputDir: string = './reports', verbose: boolean = false, silent: boolean = false) {
    this.outputDir = path.resolve(outputDir);
    this.verbose = verbose;
    this.silent = silent;
    this.ensureDir(this.outputDir);
  }

  printTerminalSummary(summary: RunSummary): void {
    if (this.silent) return;

    const line = '═'.repeat(70);
    console.log('\n' + chalk.cyan(line));
    console.log(chalk.cyan('  📊 API 回归测试执行报告'));
    console.log(chalk.cyan(line) + '\n');

    this.printSuiteDetails(summary);
    this.printOverallStats(summary);
    this.printFailedDetails(summary);

    const totalTime = (summary.duration / 1000).toFixed(2);
    console.log(chalk.cyan('\n' + line));
    console.log(chalk.cyan(`  ⏱️  总耗时: ${totalTime}s  |  📅 ${new Date(summary.endTime).toLocaleString()}`));
    console.log(chalk.cyan(line) + '\n');

    this.printExitStatus(summary);
  }

  private printSuiteDetails(summary: RunSummary): void {
    for (const suite of summary.suiteResults) {
      const totalTime = (suite.duration / 1000).toFixed(2);
      const statusIcon = suite.summary.failed > 0 ? '❌' : '✅';

      console.log(
        `${statusIcon} ${chalk.bold(suite.suiteName)} ` +
        chalk.gray(`(${suite.suiteId}) - ${totalTime}s`)
      );

      for (const test of suite.testResults) {
        this.printTestResult(test);
      }
      console.log('');
    }
  }

  private printTestResult(test: ExecutionResult): void {
    const indent = '  ';
    let statusIcon: string;
    let statusColor: chalk.Chalk;

    switch (test.status) {
      case 'passed':
        statusIcon = '✅';
        statusColor = chalk.green;
        break;
      case 'failed':
        statusIcon = '❌';
        statusColor = chalk.red;
        break;
      case 'skipped':
        statusIcon = '⏭️';
        statusColor = chalk.yellow;
        break;
    }

    const duration = test.duration >= 1000
      ? `${(test.duration / 1000).toFixed(2)}s`
      : `${test.duration}ms`;

    console.log(
      `${indent}${statusIcon} ${statusColor(test.testCaseName)} ` +
      chalk.gray(`(${test.testCaseId}) - ${duration}`)
    );

    if (test.status === 'skipped' && test.skippedReason) {
      console.log(chalk.yellow(`${indent}   ⤷ 跳过原因: ${test.skippedReason}`));
    }

    if (this.verbose && test.status === 'passed') {
      for (const assertion of test.assertions) {
        this.printAssertion(assertion, indent + '   ');
      }
    }

    if (test.status === 'failed') {
      for (const assertion of test.assertions) {
        if (!assertion.passed) {
          this.printAssertion(assertion, indent + '   ');
        }
      }
    }

    if (this.verbose && test.response) {
      console.log(chalk.gray(`${indent}   📡 ${test.request.method} ${test.request.url}`));
      console.log(chalk.gray(`${indent}   📨 状态码: ${test.response.status} | 响应时间: ${test.response.time}ms`));
    }
  }

  private printAssertion(assertion: AssertionResult, indent: string): void {
    const statusIcon = assertion.passed ? '✓' : '✗';
    const statusColor = assertion.passed ? chalk.green : chalk.red;
    const severityLabel = severityColors[assertion.severity](`[${assertion.severity.toUpperCase()}]`);

    const typeLabel = chalk.cyan(`{${assertion.type}}`);
    const message = assertion.passed
      ? chalk.gray(assertion.message)
      : chalk.white(assertion.message);

    console.log(
      `${indent}${statusColor(statusIcon)} ${severityLabel} ${typeLabel} ${message}`
    );

    if (!assertion.passed && assertion.expected !== undefined && assertion.actual !== undefined) {
      console.log(chalk.red(`${indent}   期望: ${this.formatValue(assertion.expected)}`));
      console.log(chalk.red(`${indent}   实际: ${this.formatValue(assertion.actual)}`));
    }

    if (assertion.description) {
      console.log(chalk.gray(`${indent}   💬 ${assertion.description}`));
    }
  }

  private formatValue(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string' && value.length > 100) {
      return value.slice(0, 100) + '... (截断)';
    }
    if (typeof value === 'object') {
      const str = JSON.stringify(value);
      return str.length > 200 ? str.slice(0, 200) + '... (截断)' : str;
    }
    return String(value);
  }

  private printOverallStats(summary: RunSummary): void {
    const line = '─'.repeat(70);
    console.log(chalk.gray(line));
    console.log(chalk.bold('  📈 执行统计:\n'));

    const suiteStats =
      `  测试套件: ${summary.totalSuites} 套件 | ` +
      chalk.green(`${summary.passedSuites} 通过`) + ' | ' +
      chalk.red(`${summary.failedSuites} 失败`);

    const testStats =
      `  测试用例: ${summary.totalTests} 用例 | ` +
      chalk.green(`${summary.passedTests} 通过`) + ' | ' +
      chalk.red(`${summary.failedTests} 失败`) + ' | ' +
      chalk.yellow(`${summary.skippedTests} 跳过`);

    const assertStats =
      `  断言检查: ${summary.totalAssertions} 个 | ` +
      chalk.green(`${summary.passedAssertions} 通过`) + ' | ' +
      chalk.red(`${summary.failedAssertions} 失败`);

    console.log(suiteStats);
    console.log(testStats);
    console.log(assertStats);
  }

  private printFailedDetails(summary: RunSummary): void {
    const failedTests: Array<{ suite: SuiteExecutionResult; test: ExecutionResult }> = [];

    for (const suite of summary.suiteResults) {
      for (const test of suite.testResults) {
        if (test.status === 'failed') {
          failedTests.push({ suite, test });
        }
      }
    }

    if (failedTests.length === 0) return;

    const line = '─'.repeat(70);
    console.log('\n' + chalk.red(line));
    console.log(chalk.red.bold('  ❌ 失败详情:'));
    console.log(chalk.red(line) + '\n');

    let idx = 1;
    for (const { suite, test } of failedTests) {
      console.log(chalk.red.bold(`  ${idx}. [${suite.suiteName}] ${test.testCaseName}`));
      console.log(chalk.gray(`     ID: ${test.testCaseId}\n`));

      console.log(chalk.gray(`     请求: ${test.request.method} ${test.request.url}`));

      if (test.response) {
        console.log(chalk.gray(`     状态码: ${test.response.status} ${test.response.statusText}`));
        console.log(chalk.gray(`     响应时间: ${test.response.time}ms`));
      }

      if (test.error) {
        console.log(chalk.red(`     错误: ${test.error}`));
      }

      const failedAssertions = test.assertions.filter(a => !a.passed);
      if (failedAssertions.length > 0) {
        console.log(chalk.red(`\n     失败断言 (${failedAssertions.length}个):`));
        for (const assertion of failedAssertions) {
          const severityBadge = severityColors[assertion.severity](assertion.severity.toUpperCase());
          console.log(chalk.red(`       • [${severityBadge}] {${assertion.type}}`));
          console.log(chalk.white(`         ${assertion.message.split('\n').join('\n         ')}`));
          if (assertion.expected !== undefined) {
            console.log(chalk.gray(`         期望: ${JSON.stringify(assertion.expected)}`));
            console.log(chalk.gray(`         实际: ${JSON.stringify(assertion.actual)}`));
          }
        }
      }

      if (this.verbose && test.response) {
        console.log(chalk.gray('\n     响应体预览:'));
        const bodyStr = typeof test.response.body === 'string'
          ? test.response.body
          : JSON.stringify(test.response.body, null, 2);
        const preview = bodyStr.length > 500 ? bodyStr.slice(0, 500) + '...' : bodyStr;
        console.log(chalk.gray(`       ${preview.split('\n').join('\n       ')}`));
      }

      console.log('');
      idx++;
    }
  }

  private printExitStatus(summary: RunSummary): void {
    if (summary.failedTests > 0 || summary.failedSuites > 0) {
      console.log(chalk.red.bold('  ❌ 存在失败用例，CI将以非零退出码退出'));
    } else {
      console.log(chalk.green.bold('  🎉 所有测试通过！'));
    }
  }

  generateJsonReport(summary: RunSummary, fileName: string = 'report.json'): string {
    const filePath = path.join(this.outputDir, fileName);
    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'api-regression',
        version: '1.0.0'
      },
      summary: {
        totalSuites: summary.totalSuites,
        passedSuites: summary.passedSuites,
        failedSuites: summary.failedSuites,
        totalTests: summary.totalTests,
        passedTests: summary.passedTests,
        failedTests: summary.failedTests,
        skippedTests: summary.skippedTests,
        totalAssertions: summary.totalAssertions,
        passedAssertions: summary.passedAssertions,
        failedAssertions: summary.failedAssertions,
        durationMs: summary.duration,
        startTime: new Date(summary.startTime).toISOString(),
        endTime: new Date(summary.endTime).toISOString()
      },
      suites: summary.suiteResults.map(suite => ({
        id: suite.suiteId,
        name: suite.suiteName,
        durationMs: suite.duration,
        summary: suite.summary,
        tests: suite.testResults.map(test => this.serializeTestResult(test))
      }))
    };

    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    if (!this.silent) {
      console.log(chalk.green(`  📄 JSON报告已生成: ${filePath}`));
    }
    return filePath;
  }

  private serializeTestResult(test: ExecutionResult): any {
    return {
      id: test.testCaseId,
      name: test.testCaseName,
      status: test.status,
      durationMs: test.duration,
      skippedReason: test.skippedReason,
      error: test.error,
      dataRow: test.dataRow,
      dataRowIndex: test.dataRowIndex,
      retryAttempts: test.retryAttempts,
      request: test.request,
      response: test.response ? {
        status: test.response.status,
        statusText: test.response.statusText,
        headers: test.response.headers,
        timeMs: test.response.time,
        bodyPreview: this.getBodyPreview(test.response.body)
      } : null,
      assertions: test.assertions.map(a => ({
        id: a.assertionId,
        type: a.type,
        severity: a.severity,
        passed: a.passed,
        message: a.message,
        expected: a.expected,
        actual: a.actual,
        diff: a.diff,
        description: a.description
      })),
      extractedVariables: Object.keys(test.extractedVariables).length > 0
        ? test.extractedVariables
        : undefined
    };
  }

  private getBodyPreview(body: any, maxLength: number = 5000): any {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string') {
      return body.length > maxLength ? body.slice(0, maxLength) + '... [截断]' : body;
    }
    try {
      const str = JSON.stringify(body);
      if (str.length > maxLength) {
        return '[响应体过大，已省略]';
      }
      return body;
    } catch {
      return String(body).slice(0, maxLength);
    }
  }

  generateJunitReport(summary: RunSummary, fileName: string = 'junit.xml'): string {
    const filePath = path.join(this.outputDir, fileName);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<testsuites';
    xml += ` name="api-regression"`;
    xml += ` tests="${summary.totalTests}"`;
    xml += ` failures="${summary.failedTests}"`;
    xml += ` skipped="${summary.skippedTests}"`;
    xml += ` time="${(summary.duration / 1000).toFixed(3)}"`;
    xml += '>\n';

    for (const suite of summary.suiteResults) {
      xml += this.generateTestSuiteXml(suite);
    }

    xml += '</testsuites>\n';

    fs.writeFileSync(filePath, xml, 'utf-8');
    if (!this.silent) {
      console.log(chalk.green(`  📄 JUnit XML报告已生成: ${filePath}`));
    }
    return filePath;
  }

  private generateTestSuiteXml(suite: SuiteExecutionResult): string {
    let xml = '';
    xml += '  <testsuite';
    xml += ` name="${this.escapeXml(suite.suiteName)}"`;
    xml += ` tests="${suite.summary.total}"`;
    xml += ` failures="${suite.summary.failed}"`;
    xml += ` skipped="${suite.summary.skipped}"`;
    xml += ` errors="0"`;
    xml += ` time="${(suite.duration / 1000).toFixed(3)}"`;
    xml += ` timestamp="${new Date(suite.startTime).toISOString()}"`;
    xml += '>\n';

    for (const test of suite.testResults) {
      xml += this.generateTestCaseXml(test);
    }

    xml += '  </testsuite>\n';
    return xml;
  }

  private generateTestCaseXml(test: ExecutionResult): string {
    let xml = '';
    const classname = this.escapeXml(`${test.suiteId}.${test.testCaseId}`);
    const name = this.escapeXml(test.testCaseName);

    xml += '    <testcase';
    xml += ` classname="${classname}"`;
    xml += ` name="${name}"`;
    xml += ` time="${(test.duration / 1000).toFixed(3)}"`;

    if (test.status === 'skipped') {
      xml += '>\n';
      xml += `      <skipped message="${this.escapeXml(test.skippedReason || '跳过')}" />\n`;
      xml += '    </testcase>\n';
      return xml;
    }

    const failedAssertions = test.assertions.filter(a => !a.passed);

    if (failedAssertions.length > 0 || test.error) {
      xml += '>\n';

      if (test.error) {
        xml += '      <error';
        xml += ` message="${this.escapeXml('请求执行错误')}"`;
        xml += ` type="RequestError"`;
        xml += '>\n';
        xml += `        <![CDATA[${this.escapeCdata(test.error)}]]>\n`;
        xml += '      </error>\n';
      }

      for (const assertion of failedAssertions) {
        xml += '      <failure';
        xml += ` message="${this.escapeXml(assertion.message.split('\n')[0])}"`;
        xml += ` type="${this.escapeXml(assertion.type + ':' + assertion.severity)}"`;
        xml += '>\n';

        let detail = `断言类型: ${assertion.type}\n`;
        detail += `严重级别: ${assertion.severity}\n`;
        detail += `消息: ${assertion.message}\n`;
        if (assertion.expected !== undefined) {
          detail += `期望值: ${JSON.stringify(assertion.expected)}\n`;
        }
        if (assertion.actual !== undefined) {
          detail += `实际值: ${JSON.stringify(assertion.actual)}\n`;
        }
        if (assertion.description) {
          detail += `描述: ${assertion.description}\n`;
        }

        detail += `\n请求: ${test.request.method} ${test.request.url}\n`;
        if (test.response) {
          detail += `状态码: ${test.response.status}\n`;
          const bodyStr = typeof test.response.body === 'string'
            ? test.response.body
            : JSON.stringify(test.response.body, null, 2);
          detail += `响应体:\n${bodyStr}\n`;
        }

        xml += `        <![CDATA[${this.escapeCdata(detail)}]]>\n`;
        xml += '      </failure>\n';
      }

      xml += '    </testcase>\n';
    } else {
      xml += ' />\n';
    }

    return xml;
  }

  generateHtmlReport(summary: RunSummary, fileName: string = 'report.html'): string {
    const filePath = path.join(this.outputDir, fileName);
    const html = this.buildHtmlReport(summary);
    fs.writeFileSync(filePath, html, 'utf-8');
    if (!this.silent) {
      console.log(chalk.green(`  📄 HTML报告已生成: ${filePath}`));
    }
    return filePath;
  }

  private buildHtmlReport(summary: RunSummary): string {
    const css = this.getHtmlCss();
    const js = this.getHtmlJs();
    const summaryHtml = this.buildHtmlSummary(summary);
    const suitesHtml = this.buildHtmlSuites(summary);
    const failedHtml = this.buildHtmlFailedSection(summary);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 回归测试报告</title>
  ${css}
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>📊 API 回归测试执行报告</h1>
      <p class="subtitle">
        生成时间: ${new Date().toLocaleString()} |
        总耗时: ${(summary.duration / 1000).toFixed(2)}s
      </p>
    </header>
    ${summaryHtml}
    ${failedHtml}
    <section class="suites-section">
      <h2>🧪 测试套件详情</h2>
      ${suitesHtml}
    </section>
  </div>
  ${js}
</body>
</html>`;
  }

  private getHtmlCss(): string {
    return `<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #f5f7fa;
  color: #303133;
  line-height: 1.6;
}
.container { max-width: 1400px; margin: 0 auto; padding: 20px; }
.header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 30px;
  border-radius: 12px;
  margin-bottom: 24px;
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
}
.header h1 { font-size: 28px; margin-bottom: 8px; }
.subtitle { opacity: 0.9; font-size: 14px; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.stat-card {
  background: white;
  padding: 20px;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  border-left: 4px solid #409eff;
}
.stat-card.passed { border-left-color: #67c23a; }
.stat-card.failed { border-left-color: #f56c6c; }
.stat-card.skipped { border-left-color: #e6a23c; }
.stat-card h3 { font-size: 13px; color: #909399; margin-bottom: 8px; font-weight: normal; }
.stat-card .value { font-size: 32px; font-weight: bold; }
.stat-card.passed .value { color: #67c23a; }
.stat-card.failed .value { color: #f56c6c; }
.stat-card.skipped .value { color: #e6a23c; }

.progress-bar {
  background: #e9ecef;
  height: 20px;
  border-radius: 10px;
  overflow: hidden;
  margin: 24px 0;
  display: flex;
}
.progress-bar .segment {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 12px;
  font-weight: 600;
  min-width: 40px;
  transition: width 0.5s ease;
}
.progress-passed { background: #67c23a; }
.progress-failed { background: #f56c6c; }
.progress-skipped { background: #e6a23c; }

.suites-section, .failed-section { margin-bottom: 24px; }
.suites-section h2, .failed-section h2 {
  margin-bottom: 16px;
  padding-left: 10px;
  border-left: 4px solid #409eff;
  font-size: 20px;
}

.suite-card {
  background: white;
  border-radius: 10px;
  margin-bottom: 16px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  overflow: hidden;
}
.suite-header {
  padding: 16px 20px;
  background: #fafbfc;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.suite-header:hover { background: #f4f7fa; }
.suite-header .left { display: flex; align-items: center; gap: 12px; }
.suite-icon { font-size: 20px; }
.suite-name { font-size: 16px; font-weight: 600; }
.suite-id { color: #909399; font-size: 12px; margin-left: 8px; }
.suite-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  color: #606266;
}
.badge {
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
}
.badge-passed { background: #f0f9eb; color: #67c23a; }
.badge-failed { background: #fef0f0; color: #f56c6c; }
.badge-skipped { background: #fdf6ec; color: #e6a23c; }
.badge-info { background: #ecf5ff; color: #409eff; }

.suite-body { padding: 0 20px 20px; }
.suite-body.collapsed { display: none; }
.suite-toggle { transition: transform 0.2s; font-size: 14px; color: #909399; }
.suite-toggle.open { transform: rotate(90deg); }

.test-item {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  margin-top: 12px;
  overflow: hidden;
}
.test-header {
  padding: 12px 16px;
  background: #fafbfc;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.test-header:hover { background: #f4f7fa; }
.test-header .left { display: flex; align-items: center; gap: 10px; }
.test-icon { font-size: 16px; }
.test-name { font-weight: 500; }
.test-id { color: #909399; font-size: 12px; }
.test-meta { font-size: 12px; color: #606266; display: flex; gap: 12px; }

.test-body { padding: 12px 16px; border-top: 1px solid #ebeef5; }
.test-body.collapsed { display: none; }

.info-row {
  display: flex;
  padding: 4px 0;
  font-size: 13px;
}
.info-label { color: #909399; min-width: 80px; }
.info-value { flex: 1; word-break: break-all; font-family: 'SF Mono', Monaco, monospace; }

.assertion-item {
  padding: 10px 14px;
  border-radius: 6px;
  margin-top: 8px;
  border-left: 3px solid #909399;
}
.assertion-item.passed { border-left-color: #67c23a; background: #f0f9eb; }
.assertion-item.failed { border-left-color: #f56c6c; background: #fef0f0; }
.assertion-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.assertion-type {
  background: #ecf5ff;
  color: #409eff;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
}
.severity-critical { background: #f56c6c; color: white; padding: 1px 8px; border-radius: 4px; font-size: 11px; }
.severity-high { background: #fef0f0; color: #f56c6c; padding: 1px 8px; border-radius: 4px; font-size: 11px; border: 1px solid #f56c6c; }
.severity-medium { background: #fdf6ec; color: #e6a23c; padding: 1px 8px; border-radius: 4px; font-size: 11px; }
.severity-low { background: #ecf5ff; color: #409eff; padding: 1px 8px; border-radius: 4px; font-size: 11px; }
.severity-info { background: #f4f4f5; color: #909399; padding: 1px 8px; border-radius: 4px; font-size: 11px; }

.assertion-message { font-size: 13px; }
.assertion-item.passed .assertion-message { color: #529b2e; }
.assertion-item.failed .assertion-message { color: #c45656; }

.details-block {
  background: #2d2d2d;
  color: #e6e6e6;
  padding: 12px;
  border-radius: 6px;
  margin-top: 8px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-row { padding: 2px 0; }
.diff-row .label { color: #909399; display: inline-block; min-width: 70px; }

.tabs {
  display: flex;
  border-bottom: 2px solid #ebeef5;
  margin: 12px 0;
}
.tab {
  padding: 8px 16px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  font-size: 13px;
}
.tab.active {
  color: #409eff;
  border-bottom-color: #409eff;
  font-weight: 600;
}
.tab-content { display: none; }
.tab-content.active { display: block; }

.empty-state {
  padding: 40px;
  text-align: center;
  color: #909399;
  background: #fafbfc;
  border-radius: 8px;
}
</style>`;
  }

  private getHtmlJs(): string {
    return `<script>
function toggleSuite(id) {
  const body = document.getElementById('suite-body-' + id);
  const toggle = document.getElementById('suite-toggle-' + id);
  body.classList.toggle('collapsed');
  toggle.classList.toggle('open');
}
function toggleTest(id) {
  const body = document.getElementById('test-body-' + id);
  const toggle = document.getElementById('test-toggle-' + id);
  body.classList.toggle('collapsed');
  toggle.classList.toggle('open');
}
function switchTab(tabGroup, tabName) {
  document.querySelectorAll('[data-tab-group="' + tabGroup + '"]').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('[data-tab-content-group="' + tabGroup + '"]').forEach(el => el.classList.remove('active'));
  document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
  document.querySelector('[data-tab-content="' + tabName + '"]').classList.add('active');
}
</script>`;
  }

  private buildHtmlSummary(summary: RunSummary): string {
    const totalTests = summary.totalTests;
    const passedPct = totalTests ? ((summary.passedTests / totalTests) * 100).toFixed(1) : '0';
    const failedPct = totalTests ? ((summary.failedTests / totalTests) * 100).toFixed(1) : '0';
    const skippedPct = totalTests ? ((summary.skippedTests / totalTests) * 100).toFixed(1) : '0';

    return `<section class="summary-section">
      <div class="stats-grid">
        <div class="stat-card"><h3>测试套件总数</h3><div class="value">${summary.totalSuites}</div></div>
        <div class="stat-card passed"><h3>通过用例</h3><div class="value">${summary.passedTests}</div></div>
        <div class="stat-card failed"><h3>失败用例</h3><div class="value">${summary.failedTests}</div></div>
        <div class="stat-card skipped"><h3>跳过用例</h3><div class="value">${summary.skippedTests}</div></div>
        <div class="stat-card"><h3>断言总数</h3><div class="value">${summary.totalAssertions}</div></div>
        <div class="stat-card"><h3>总耗时</h3><div class="value">${(summary.duration / 1000).toFixed(1)}s</div></div>
      </div>
      <div class="progress-bar">
        ${summary.passedTests > 0 ? `<div class="segment progress-passed" style="width:${passedPct}%">${passedPct}%</div>` : ''}
        ${summary.failedTests > 0 ? `<div class="segment progress-failed" style="width:${failedPct}%">${failedPct}%</div>` : ''}
        ${summary.skippedTests > 0 ? `<div class="segment progress-skipped" style="width:${skippedPct}%">${skippedPct}%</div>` : ''}
      </div>
    </section>`;
  }

  private buildHtmlFailedSection(summary: RunSummary): string {
    const failures: string[] = [];
    for (const suite of summary.suiteResults) {
      for (const test of suite.testResults) {
        if (test.status === 'failed') {
          failures.push(this.buildHtmlTestItem(test, suite, true));
        }
      }
    }

    if (failures.length === 0) {
      return `<section class="failed-section">
        <h2>❌ 失败用例</h2>
        <div class="empty-state">
          <h3>🎉 没有失败用例</h3>
          <p>所有测试用例均通过执行</p>
        </div>
      </section>`;
    }

    return `<section class="failed-section">
      <h2>❌ 失败用例 (${failures.length})</h2>
      ${failures.join('')}
    </section>`;
  }

  private buildHtmlSuites(summary: RunSummary): string {
    let html = '';
    for (let i = 0; i < summary.suiteResults.length; i++) {
      const suite = summary.suiteResults[i];
      const suiteId = `s${i}`;
      const suiteIcon = suite.summary.failed > 0 ? '❌' : '✅';
      const suiteBadge = suite.summary.failed > 0
        ? `<span class="badge badge-failed">${suite.summary.failed} 失败</span>`
        : suite.summary.skipped > 0
        ? `<span class="badge badge-skipped">${suite.summary.skipped} 跳过</span>`
        : `<span class="badge badge-passed">全部通过</span>`;

      const testsHtml = suite.testResults.map((test, j) =>
        this.buildHtmlTestItem(test, suite, false, `${suiteId}-${j}`)
      ).join('');

      html += `<div class="suite-card">
        <div class="suite-header" onclick="toggleSuite('${suiteId}')">
          <div class="left">
            <span class="suite-icon">${suiteIcon}</span>
            <span class="suite-name">${this.escapeHtml(suite.suiteName)}</span>
            <span class="suite-id">(${this.escapeHtml(suite.suiteId)})</span>
          </div>
          <div class="suite-meta">
            ${suiteBadge}
            <span>${suite.summary.total} 用例</span>
            <span>${(suite.duration / 1000).toFixed(2)}s</span>
            <span class="suite-toggle open" id="suite-toggle-${suiteId}">▶</span>
          </div>
        </div>
        <div class="suite-body" id="suite-body-${suiteId}">
          ${testsHtml}
        </div>
      </div>`;
    }
    return html;
  }

  private buildHtmlTestItem(
    test: ExecutionResult,
    suite: SuiteExecutionResult,
    isFailedOnly: boolean,
    id?: string
  ): string {
    const testId = id || `f-${Math.random().toString(36).slice(2, 8)}`;
    let icon = '✅', statusBadge = `<span class="badge badge-passed">通过</span>`;
    if (test.status === 'failed') {
      icon = '❌';
      statusBadge = `<span class="badge badge-failed">失败</span>`;
    } else if (test.status === 'skipped') {
      icon = '⏭️';
      statusBadge = `<span class="badge badge-skipped">跳过</span>`;
    }

    const assertionsHtml = this.buildHtmlAssertions(test);
    const requestHtml = this.buildHtmlRequestResponse(test);

    return `<div class="test-item">
      <div class="test-header" onclick="toggleTest('${testId}')">
        <div class="left">
          <span class="test-icon">${icon}</span>
          <span class="test-name">${this.escapeHtml(test.testCaseName)}</span>
          <span class="test-id">${this.escapeHtml(test.testCaseId)}</span>
          ${test.dataRowIndex !== undefined ? `<span class="badge badge-info">数据行 ${test.dataRowIndex + 1}</span>` : ''}
        </div>
        <div class="test-meta">
          ${statusBadge}
          <span>${test.duration}ms</span>
          ${test.retryAttempts && test.retryAttempts > 1 ? `<span>重试 ${test.retryAttempts} 次</span>` : ''}
          <span class="suite-toggle open" id="test-toggle-${testId}">▶</span>
        </div>
      </div>
      <div class="test-body collapsed" id="test-body-${testId}">
        ${test.skippedReason ? `<div class="info-row"><span class="info-label">跳过原因</span><span class="info-value">${this.escapeHtml(test.skippedReason)}</span></div>` : ''}
        ${test.error ? `<div class="info-row"><span class="info-label">错误</span><span class="info-value" style="color:#f56c6c">${this.escapeHtml(test.error)}</span></div>` : ''}
        ${Object.keys(test.extractedVariables).length > 0 ? `<div class="info-row"><span class="info-label">提取变量</span><span class="info-value"><pre style="margin:0">${JSON.stringify(test.extractedVariables, null, 2)}</pre></span></div>` : ''}
        ${requestHtml}
        ${assertionsHtml}
      </div>
    </div>`;
  }

  private buildHtmlRequestResponse(test: ExecutionResult): string {
    const tabGroup = `tabs-${Math.random().toString(36).slice(2, 8)}`;

    const headersStr = test.request.headers
      ? JSON.stringify(test.request.headers, null, 2)
      : '(无)';
    const bodyStr = test.request.body !== undefined && test.request.body !== null
      ? (typeof test.request.body === 'string' ? test.request.body : JSON.stringify(test.request.body, null, 2))
      : '(无)';

    let respStatusStr = '无响应';
    let respHeadersStr = '(无)';
    let respBodyStr = '(无)';
    if (test.response) {
      respStatusStr = `${test.response.status} ${test.response.statusText} | ${test.response.time}ms`;
      respHeadersStr = JSON.stringify(test.response.headers, null, 2);
      respBodyStr = typeof test.response.body === 'string'
        ? test.response.body
        : JSON.stringify(test.response.body, null, 2);
    }

    return `<div class="tabs">
      <div class="tab active" data-tab-group="${tabGroup}" data-tab="req" onclick="switchTab('${tabGroup}','req')">📤 请求</div>
      <div class="tab" data-tab-group="${tabGroup}" data-tab="resp" onclick="switchTab('${tabGroup}','resp')">📥 响应</div>
    </div>
    <div class="tab-content active" data-tab-content-group="${tabGroup}" data-tab-content="req">
      <div class="info-row"><span class="info-label">方法</span><span class="info-value"><strong>${this.escapeHtml(test.request.method)}</strong></span></div>
      <div class="info-row"><span class="info-label">URL</span><span class="info-value">${this.escapeHtml(test.request.url)}</span></div>
      <div class="info-row"><span class="info-label">Headers</span><span class="info-value"><div class="details-block">${this.escapeHtml(headersStr)}</div></span></div>
      <div class="info-row"><span class="info-label">Body</span><span class="info-value"><div class="details-block">${this.escapeHtml(bodyStr)}</div></span></div>
    </div>
    <div class="tab-content" data-tab-content-group="${tabGroup}" data-tab-content="resp">
      <div class="info-row"><span class="info-label">状态</span><span class="info-value"><strong>${this.escapeHtml(respStatusStr)}</strong></span></div>
      <div class="info-row"><span class="info-label">Headers</span><span class="info-value"><div class="details-block">${this.escapeHtml(respHeadersStr)}</div></span></div>
      <div class="info-row"><span class="info-label">Body</span><span class="info-value"><div class="details-block">${this.escapeHtml(respBodyStr)}</div></span></div>
    </div>`;
  }

  private buildHtmlAssertions(test: ExecutionResult): string {
    if (test.assertions.length === 0) return '';

    const html = test.assertions.map(a => {
      const cls = a.passed ? 'passed' : 'failed';
      const icon = a.passed ? '✅' : '❌';
      const severityCls = `severity-${a.severity}`;
      let details = '';

      if (!a.passed) {
        if (a.expected !== undefined || a.actual !== undefined) {
          details += `<div class="diff-row"><span class="label">期望值:</span> ${this.escapeHtml(JSON.stringify(a.expected))}</div>`;
          details += `<div class="diff-row"><span class="label">实际值:</span> ${this.escapeHtml(JSON.stringify(a.actual))}</div>`;
        }
        if (a.diff) {
          details += `<div class="diff-row"><span class="label">差异:</span><pre style="margin:0">${this.escapeHtml(JSON.stringify(a.diff, null, 2))}</pre></div>`;
        }
      }

      return `<div class="assertion-item ${cls}">
        <div class="assertion-header">
          <span>${icon}</span>
          <span class="assertion-type">${this.escapeHtml(a.type)}</span>
          <span class="${severityCls}">${a.severity.toUpperCase()}</span>
          ${a.description ? `<span style="color:#909399;font-size:12px">💬 ${this.escapeHtml(a.description)}</span>` : ''}
        </div>
        <div class="assertion-message">${this.escapeHtml(a.message).split('\n').join('<br>')}</div>
        ${details ? `<div class="details-block">${details}</div>` : ''}
      </div>`;
    }).join('');

    return `<div style="margin-top:8px"><strong style="font-size:13px;color:#606266">断言结果 (${test.assertions.length})</strong>${html}</div>`;
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private escapeXml(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private escapeCdata(str: string): string {
    return String(str || '').replace(/\]\]>/g, ']]]]><![CDATA[>');
  }

  private escapeHtml(str: any): string {
    if (str === null || str === undefined) return '';
    const s = String(str);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
