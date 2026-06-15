#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { RunOptions } from './types';
import { ConfigParser } from './core/parser';
import { TestRunner } from './core/runner';
import { ReportGenerator } from './core/reporter';

const packageJsonPath = path.join(__dirname, '..', 'package.json');
let packageJson: any = {};
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
} catch {
  packageJson = { name: 'api-regression', version: '1.0.0' };
}

async function main() {
  const program = new Command();

  program
    .name(packageJson.name || 'api-regression')
    .description(packageJson.description || '批量API回归测试工具')
    .version(packageJson.version || '1.0.0', '-v, --version', '显示版本号');

  program
    .command('run [paths...]', { isDefault: true })
    .description('执行API回归测试（默认命令）')
    .option('-e, --environment <name>', '环境名称，用于选择环境配置')
    .option('--env-file <path>', '环境配置文件路径 (YAML)')
    .option('-c, --config <path>', '全局配置文件路径 (YAML)')
    .option('-t, --tags <tags...>', '只执行包含指定标签的用例，多个标签用空格分隔')
    .option('--exclude-tags <tags...>', '排除包含指定标签的用例')
    .option('-n, --concurrency <number>', '并发执行的用例数量', parseInt)
    .option('--only-failed', '仅执行上次失败的用例')
    .option('--failed-file <path>', '失败用例记录文件路径')
    .option('-o, --output-dir <path>', '报告输出目录', './reports')
    .option('--no-html', '不生成HTML报告')
    .option('--no-json', '不生成JSON报告')
    .option('--no-junit', '不生成JUnit XML报告')
    .option('--html', '生成HTML报告')
    .option('--json', '生成JSON报告')
    .option('--junit', '生成JUnit XML报告')
    .option('-u, --update-snapshots', '更新契约测试基线快照')
    .option('-b, --base-url <url>', '覆盖配置的基础URL')
    .option('--var <vars...>', '设置运行时变量，格式: key=value')
    .option('--stop-on-failure', '遇到失败立即停止执行')
    .option('-V, --verbose', '显示详细输出')
    .option('-s, --silent', '静默模式，仅输出错误')
    .option('--no-ci-exit', 'CI模式下不使用非零退出码')
    .option('--ci-exit', '有Critical/High级别失败时以非零退出码退出(默认)')
    .action(async (paths: string[], cmdOptions: any) => {
      try {
        await executeRun(paths, cmdOptions);
      } catch (error: any) {
        console.error(chalk.red('\n❌ 执行出错:'));
        console.error(chalk.red(error.message || error));
        if (cmdOptions.verbose && error.stack) {
          console.error(chalk.gray(error.stack));
        }
        process.exit(1);
      }
    });

  program
    .command('list <path>')
    .description('列出目录或套件文件中的测试用例')
    .option('-t, --tags <tags...>', '仅显示包含指定标签的用例')
    .option('--exclude-tags <tags...>', '排除包含指定标签的用例')
    .action(async (dirPath: string, opts: any) => {
      try {
        await listTests(dirPath, opts);
      } catch (error: any) {
        console.error(chalk.red(error.message || error));
        process.exit(1);
      }
    });

  program
    .command('init [dir]')
    .description('创建示例测试套件和配置文件')
    .action(async (dir: string) => {
      try {
        await initProject(dir || '.');
      } catch (error: any) {
        console.error(chalk.red(error.message || error));
        process.exit(1);
      }
    });

  program
    .command('snapshot <command>')
    .description('管理契约测试基线快照')
    .addCommand(
      new Command('list')
        .description('列出所有基线快照')
        .option('-d, --snapshot-dir <path>', '快照目录', './reports/snapshots')
        .action((opts: any) => listSnapshots(opts.snapshotDir))
    )
    .addCommand(
      new Command('clean')
        .description('删除基线快照')
        .option('-d, --snapshot-dir <path>', '快照目录', './reports/snapshots')
        .option('-i, --ids <ids...>', '仅删除指定ID的快照')
        .action((opts: any) => cleanSnapshots(opts.snapshotDir, opts.ids))
    );

  program.addHelpText('after', `
示例:
  ${chalk.cyan('# 执行单个测试套件')}
  $ api-regression run tests/order-service.yml

  ${chalk.cyan('# 执行目录下所有套件，指定环境配置')}
  $ api-regression run tests/ --env-file environments/prod.yml

  ${chalk.cyan('# 并发执行，仅执行带smoke标签的用例')}
  $ api-regression run tests/ -n 10 -t smoke

  ${chalk.cyan('# 仅重跑上次失败的用例，更新快照')}
  $ api-regression run tests/ --only-failed -u

  ${chalk.cyan('# 设置运行时变量')}
  $ api-regression run tests/ --var token=abc123 userId=1001

  ${chalk.cyan('# 创建示例项目')}
  $ api-regression init ./tests
  `);

  await program.parseAsync(process.argv);
}

async function executeRun(paths: string[], cmdOptions: any): Promise<void> {
  const startTime = Date.now();

  const parser = new ConfigParser();

  const suitePaths: string[] = [];
  if (paths.length === 0) {
    const defaultDirs = ['./tests', './test', './specs'];
    for (const dir of defaultDirs) {
      if (fs.existsSync(dir)) {
        suitePaths.push(...parser.discoverSuites(dir));
      }
    }
    if (suitePaths.length === 0) {
      throw new Error('未指定测试套件路径，且未找到默认测试目录 (./tests, ./test, ./specs)');
    }
  } else {
    for (const p of paths) {
      const fullPath = path.resolve(p);
      const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      if (stat && stat.isDirectory()) {
        suitePaths.push(...parser.discoverSuites(fullPath));
      } else if (fullPath.endsWith('.yml') || fullPath.endsWith('.yaml')) {
        suitePaths.push(fullPath);
      }
    }
  }

  if (suitePaths.length === 0) {
    throw new Error('未找到任何 YAML 测试套件文件');
  }

  if (!cmdOptions.silent) {
    console.log(chalk.cyan(`📦 找到 ${suitePaths.length} 个测试套件`));
    for (const sp of suitePaths) {
      console.log(chalk.gray(`  - ${path.relative(process.cwd(), sp)}`));
    }
    console.log('');
  }

  const runtimeVars: Record<string, any> = {};
  if (cmdOptions.var) {
    for (const kv of cmdOptions.var) {
      const eqIdx = kv.indexOf('=');
      if (eqIdx > 0) {
        const key = kv.slice(0, eqIdx);
        const value = kv.slice(eqIdx + 1);
        runtimeVars[key] = parseVarValue(value);
      }
    }
  }

  const options: RunOptions = {
    suitePaths,
    environment: cmdOptions.environment,
    environmentFile: cmdOptions.envFile,
    globalConfigFile: cmdOptions.config,
    tags: cmdOptions.tags,
    excludeTags: cmdOptions.excludeTags,
    concurrency: cmdOptions.concurrency,
    onlyFailed: cmdOptions.onlyFailed,
    failedFile: cmdOptions.failedFile,
    outputDir: cmdOptions.outputDir,
    htmlReport: cmdOptions.html !== false,
    jsonReport: cmdOptions.json !== false,
    junitReport: cmdOptions.junit !== false,
    updateSnapshots: cmdOptions.updateSnapshots,
    baseUrl: cmdOptions.baseUrl,
    variables: Object.keys(runtimeVars).length > 0 ? runtimeVars : undefined,
    stopOnFailure: cmdOptions.stopOnFailure,
    verbose: cmdOptions.verbose,
    silent: cmdOptions.silent,
    ciExitCode: cmdOptions.ciExit !== false
  };

  const runner = new TestRunner(options);
  const summary = await runner.run();

  const outputDir = path.resolve(options.outputDir || './reports');
  const reporter = new ReportGenerator(outputDir, options.verbose, options.silent);

  if (options.jsonReport !== false) {
    reporter.generateJsonReport(summary);
  }
  if (options.junitReport !== false) {
    reporter.generateJunitReport(summary);
  }
  if (options.htmlReport !== false) {
    reporter.generateHtmlReport(summary);
  }

  reporter.printTerminalSummary(summary);

  runner.saveFailedCases(summary, outputDir);

  console.log(chalk.cyan(`\n  📁 报告目录: ${outputDir}`));

  const shouldExitNonZero = runner.shouldExitNonZero(summary);
  if (shouldExitNonZero) {
    process.exit(1);
  }
}

function parseVarValue(value: string): any {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '' && /^-?\d*\.?\d+$/.test(trimmed)) {
    return num;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object') return parsed;
  } catch {
    // ignore
  }
  return value;
}

async function listTests(dirPath: string, opts: any): Promise<void> {
  const parser = new ConfigParser();
  const fullPath = path.resolve(dirPath);

  const files: string[] = [];
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...parser.discoverSuites(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  if (files.length === 0) {
    console.log(chalk.yellow('未找到测试套件文件'));
    return;
  }

  let totalSuites = 0;
  let totalTests = 0;

  for (const file of files) {
    try {
      const suite = parser.parseSuite(file);
      let tests = suite.tests;

      if (opts.excludeTags && opts.excludeTags.length > 0) {
        tests = tests.filter(t => !(t.tags || []).some(tag => opts.excludeTags.includes(tag)));
      }
      if (opts.tags && opts.tags.length > 0) {
        tests = tests.filter(t => (t.tags || []).some(tag => opts.tags.includes(tag)));
      }

      if (tests.length === 0) continue;

      totalSuites++;
      totalTests += tests.length;

      console.log(chalk.cyan(`\n📁 ${suite.name} ${chalk.gray(`(${suite.id})`)}`));
      console.log(chalk.gray(`   文件: ${path.relative(process.cwd(), file)}`));

      for (const test of tests) {
        const tagsStr = test.tags && test.tags.length > 0
          ? chalk.yellow(` [${test.tags.join(', ')}]`)
          : '';
        const depsStr = test.dependsOn && test.dependsOn.length > 0
          ? chalk.gray(` ← 依赖: ${test.dependsOn.join(', ')}`)
          : '';
        console.log(`  - ${test.name} ${chalk.gray(`(${test.id})`)}${tagsStr}${depsStr}`);
        console.log(chalk.gray(`      ${test.request.method} ${test.request.url}`));
      }
    } catch (e: any) {
      console.log(chalk.red(`\n❌ 解析失败: ${path.relative(process.cwd(), file)}`));
      console.log(chalk.red(`   ${e.message}`));
    }
  }

  console.log(chalk.cyan(`\n总计: ${totalSuites} 个套件, ${totalTests} 个用例`));
}

async function initProject(dir: string): Promise<void> {
  const fullDir = path.resolve(dir);
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }

  const envDir = path.join(fullDir, 'environments');
  const suitesDir = path.join(fullDir, 'tests');
  const dataDir = path.join(fullDir, 'data');

  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });
  if (!fs.existsSync(suitesDir)) fs.mkdirSync(suitesDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const devEnv = `# 开发环境配置
name: development
baseUrl: http://localhost:3000
variables:
  token: "dev-token-placeholder"
  defaultUserId: 1
headers:
  X-App-Version: "1.0.0"
`;
  fs.writeFileSync(path.join(envDir, 'dev.yml'), devEnv, 'utf-8');

  const prodEnv = `# 生产环境配置
name: production
baseUrl: https://api.example.com
variables:
  token: \${process.env.API_TOKEN}
  defaultUserId: 100
headers:
  X-App-Version: "1.0.0"
`;
  fs.writeFileSync(path.join(envDir, 'prod.yml'), prodEnv, 'utf-8');

  const globalCfg = `# 全局配置
concurrency: 5
timeout: 30000
retries: 1
variables:
  appName: "api-regression"
headers:
  Accept: "application/json"
output:
  html: "reports/report.html"
  json: "reports/report.json"
  junit: "reports/junit.xml"
  snapshots: "reports/snapshots"
  failed: "reports/failed-tests.json"
`;
  fs.writeFileSync(path.join(fullDir, 'config.yml'), globalCfg, 'utf-8');

  const userData = `name,email,age
Alice,alice@example.com,25
Bob,bob@example.com,30
Charlie,charlie@example.com,35
`;
  fs.writeFileSync(path.join(dataDir, 'users.csv'), userData, 'utf-8');

  const orderSuite = `# 订单服务测试套件示例
id: order-service
name: 订单服务回归测试
description: 订单服务核心接口回归测试套件
baseUrl: \${env:base_url}

defaults:
  headers:
    Authorization: "Bearer \${token}"
    Content-Type: "application/json"
  timeout: 10000

before:
  variables:
    orderPrefix: "ORD"

tests:
  - id: create-order
    name: 创建订单
    description: 测试创建订单接口
    tags: ["smoke", "order", "critical"]
    request:
      method: POST
      url: /api/orders
      body:
        userId: \${defaultUserId}
        productId: "P001"
        quantity: 2
        remark: "测试订单 \${orderPrefix}"
    extracts:
      - name: createdOrderId
        from: body
        path: "$.data.id"
      - name: createdOrderNo
        from: body
        path: "data.orderNo"
    assertions:
      - id: status-200
        severity: critical
        statusCode: 200
        description: "创建订单必须返回200"
      - id: response-time
        severity: high
        responseTime: 2000
        description: "响应时间不超过2秒"
      - id: has-order-id
        severity: critical
        jsonPath:
          path: "$.data.id"
          operator: exists
      - id: order-success
        severity: high
        jsonPath:
          path: "$.code"
          operator: eq
          expected: 0
      - id: validate-schema
        severity: medium
        jsonSchema:
          type: object
          required: [code, data]
          properties:
            code: { type: integer }
            message: { type: string }
            data:
              type: object
              required: [id, orderNo, status]
              properties:
                id: { type: string }
                orderNo: { type: string }
                status: { type: string, enum: [PENDING, PAID, SHIPPED] }
      - id: contract-check
        severity: high
        contract:
          strict: true

  - id: get-order-detail
    name: 查询订单详情
    description: 根据订单ID查询详情，依赖创建订单
    tags: ["order"]
    dependsOn: ["create-order"]
    request:
      method: GET
      url: /api/orders/\${createdOrderId}
    assertions:
      - statusCode: 200
        severity: critical
      - jsonPath:
          path: "$.data.id"
          operator: eq
          expected: \${createdOrderId}
        severity: critical
        description: "返回的订单ID应与创建时一致"
      - jsonPath:
          path: "$.data.status"
          operator: contains
          expected: "PENDING"
        severity: high
      - headerExists: "X-Request-Id"
        severity: low

  - id: list-orders
    name: 查询订单列表
    description: 分页查询订单列表
    tags: ["order", "smoke"]
    request:
      method: GET
      url: /api/orders
      queryParams:
        page: 1
        pageSize: 20
        status: PENDING
    assertions:
      - statusCode: 200
        severity: critical
      - jsonPath:
          path: "$.data.total"
          operator: gte
          expected: 1
        severity: medium
      - jsonPath:
          path: "$.data.items"
          operator: type
          expected: array
        severity: high

  - id: create-user-data-driven
    name: 批量创建用户 - 数据驱动
    description: 使用CSV数据文件批量测试创建用户接口
    tags: ["user", "data-driven"]
    dataSource:
      file: ./data/users.csv
      type: csv
      varPrefix: user
    request:
      method: POST
      url: /api/users
      body:
        name: \${user_name}
        email: \${user_email}
        age: \${user_age}
    extracts:
      - name: "newUserId_\${__data_row_index}"
        from: body
        path: "$.data.id"
    assertions:
      - statusCode: 200
        severity: critical
      - jsonPath:
          path: "$.data.name"
          operator: eq
          expected: \${user_name}
        severity: high
`;
  fs.writeFileSync(path.join(suitesDir, 'order-service.yml'), orderSuite, 'utf-8');

  const healthSuite = `# 健康检查测试套件
id: health-check
name: 服务健康检查
description: 基础连通性和健康检查接口测试
baseUrl: \${env:base_url}

tests:
  - id: health-endpoint
    name: 健康检查接口
    tags: ["smoke", "health", "critical"]
    request:
      method: GET
      url: /health
    assertions:
      - statusCode: 200
        severity: critical
      - responseTime: 500
        severity: high
      - bodyContains: "UP"
        severity: high

  - id: info-endpoint
    name: 服务信息接口
    tags: ["health"]
    request:
      method: GET
      url: /info
    assertions:
      - statusCode: 200
        severity: critical
      - jsonPath:
          path: "$.build.version"
          operator: regex
          expected: "^\\\\d+\\\\.\\\\d+\\\\.\\\\d+"
        severity: medium
      - contract:
          strict: false
        severity: medium
`;
  fs.writeFileSync(path.join(suitesDir, 'health-check.yml'), healthSuite, 'utf-8');

  console.log(chalk.green(`\n✅ 示例项目已创建: ${fullDir}`));
  console.log('');
  console.log(chalk.cyan('📁 目录结构:'));
  console.log(chalk.gray(`   ${fullDir}/
   ├── config.yml              # 全局配置
   ├── environments/
   │   ├── dev.yml             # 开发环境配置
   │   └── prod.yml            # 生产环境配置
   ├── data/
   │   └── users.csv           # 数据驱动测试示例数据
   └── tests/
       ├── health-check.yml    # 健康检查套件示例
       └── order-service.yml   # 订单服务套件示例
`));
  console.log(chalk.cyan('▶️  运行示例:'));
  console.log(chalk.gray(`   cd ${fullDir}`));
  console.log(chalk.gray(`   api-regression run tests/ --env-file environments/dev.yml`));
  console.log('');
}

function listSnapshots(snapshotDir: string): void {
  const fullDir = path.resolve(snapshotDir);
  if (!fs.existsSync(fullDir)) {
    console.log(chalk.yellow(`快照目录不存在: ${fullDir}`));
    return;
  }

  const files = fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.snap.json'))
    .sort();

  if (files.length === 0) {
    console.log(chalk.yellow('未找到基线快照'));
    return;
  }

  console.log(chalk.cyan(`\n📸 找到 ${files.length} 个基线快照:\n`));
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(fullDir, file);
    try {
      const stat = fs.statSync(filePath);
      const size = (stat.size / 1024).toFixed(2);
      const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const date = snapshot.createdAt || snapshot.updatedAt || stat.ctime.toISOString();
      console.log(chalk.white(`  ${i + 1}. ${file}`));
      console.log(chalk.gray(`     测试: ${snapshot.testCaseName || 'N/A'} (${snapshot.testCaseId || 'N/A'})`));
      console.log(chalk.gray(`     大小: ${size} KB | 创建: ${new Date(date).toLocaleString()}`));
    } catch (e) {
      console.log(chalk.white(`  ${i + 1}. ${file} ${chalk.red('[解析失败]')}`));
    }
  }
  console.log('');
}

function cleanSnapshots(snapshotDir: string, ids?: string[]): void {
  const fullDir = path.resolve(snapshotDir);
  if (!fs.existsSync(fullDir)) {
    console.log(chalk.yellow(`快照目录不存在: ${fullDir}`));
    return;
  }

  let files = fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.snap.json'));

  if (ids && ids.length > 0) {
    files = files.filter(f => ids.some(id => {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      return f.startsWith(safeId);
    }));
  }

  if (files.length === 0) {
    console.log(chalk.yellow('没有需要删除的快照'));
    return;
  }

  for (const file of files) {
    fs.unlinkSync(path.join(fullDir, file));
  }

  console.log(chalk.green(`✅ 已删除 ${files.length} 个基线快照`));
}

main().catch(error => {
  console.error(chalk.red('\n💥 未处理的错误:'));
  console.error(chalk.red(error.message || error));
  console.error(chalk.gray(error.stack));
  process.exit(1);
});
