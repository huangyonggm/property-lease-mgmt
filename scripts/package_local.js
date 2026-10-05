'use strict';
/**
 * 打包脚本：生成本地离线版分发包
 *
 * 用法：
 *   node scripts/package_local.js
 *
 * 输出：
 *   dist/物业不动产租赁管理系统-v1.0.0.zip
 *
 * 包含内容：
 *   - 全部源代码（lib/, routes/, public/）
 *   - package.json（依赖声明）
 *   - 启动脚本（启动系统.bat）
 *   - 配置模板（.env.example，不含真实密码）
 *   - 空数据目录（data/，uploads/，exports/）
 *
 * 不包含：
 *   - data/*.json（真实业务数据）
 *   - uploads/（用户上传文件）
 *   - node_modules/（接收方自己 npm install）
 *   - .env（含真实密码）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 版本号（从 package.json 读取）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '1.0.0';
const ZIP_NAME = `物业不动产租赁管理系统-v${VERSION}.zip`;

// 需要包含的文件/目录
const INCLUDE = [
  'server.js',
  'package.json',
  'package-lock.json',
  'netlify.toml',
  '启动系统.bat',
  '.env.example',  // 配置模板（不含真实密码）
  'lib',
  'routes',
  'public',
  'scripts'
];

// 需要排除的目录/文件
const EXCLUDE = [
  'data',           // 真实业务数据（41MB）
  'uploads',        // 用户上传文件（可能含敏感信息）
  'exports',        // 导出的报表
  'backups',        // 备份文件
  'screenshots',    // 截图
  'node_modules',   // 依赖包（82MB，接收方自己 install）
  '.netlify',       // Netlify 构建缓存
  'dist',           // 输出目录
  '.git',           // Git 仓库
  'tmp',            // 临时文件
  '*.log',          // 日志文件
  '.env',           // 真实配置文件（含密码）
  '.env.*'          // 环境特定配置
];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst, excludePatterns = []) {
  mkdirp(dst);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    // 检查排除规则
    const relPath = path.relative(src, srcPath);
    const shouldExclude = excludePatterns.some(pattern => {
      if (pattern === entry.name) return true;
      if (pattern.endsWith('/*') && relPath.startsWith(pattern.slice(0, -2))) return true;
      if (pattern.endsWith('/**') && relPath.startsWith(pattern.slice(0, -3))) return true;
      return false;
    });

    if (shouldExclude) continue;

    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath, excludePatterns);
    } else if (entry.isFile()) {
      // 跳过日志文件
      if (entry.name.endsWith('.log')) continue;
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function generateEnvExample() {
  const example = `# ===== 物业不动产租赁管理系统 · 本地部署配置模板 =====
# 复制此文件为 .env 后修改：
#   cp .env.example .env
#
# 注意：.env 含真实密码，请勿提交到 Git！

# ---------- 数据库（本地开发用 JSON 存储，无需配置）----------
# 本地模式：DB_MODE=local（默认），数据存在 data/ 目录
# 云端模式： uncomment 下方 DATABASE_URL 并设置 DB_MODE=cloud
# DATABASE_URL=mysql://user:password@host:port/database
# DB_MODE=cloud

# ---------- 附件存储（本地开发用磁盘，云端用七牛）----------
# 本地模式：ATT_STORAGE=local（默认）
# 云端模式：ATT_STORAGE=qiniu
ATT_STORAGE=local

# ---------- 七牛云配置（仅云端模式需要）----------
# QINIU_ACCESS_KEY=xxx
# QINIU_SECRET_KEY=xxx
# QINIU_BUCKET=property-lease
# QINIU_DOMAIN=your-domain.com
# QINIU_REGION=z0
# QINIU_PRIVATE=1
# QINIU_URL_EXPIRE=3600

# ---------- 服务配置 ----------
PORT=8080
# DATA_DIR=data  （数据目录，可自定义）
# UPLOAD_DIR=uploads  （上传目录）
`;
  return example;
}

function main() {
  console.log('=== 物业不动产租赁管理系统 · 本地离线版打包 ===\n');

  // 清理旧的 dist 目录
  rmrf(DIST);
  mkdirp(DIST);

  console.log('1. 准备分发目录...');
  const staging = path.join(DIST, '物业不动产租赁管理系统');
  mkdirp(staging);

  // 复制源代码
  console.log('2. 复制源代码...');
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    const dst = path.join(staging, item);
    if (fs.existsSync(src)) {
      if (fs.statSync(src).isDirectory()) {
        copyDir(src, dst, EXCLUDE);
        console.log('  ✔ ' + item);
      } else {
        fs.copyFileSync(src, dst);
        console.log('  ✔ ' + item);
      }
    } else {
      console.log('  ⚠ 跳过（不存在）' + item);
    }
  }

  // 生成 .env.example
  console.log('3. 生成配置模板...');
  const envExample = generateEnvExample();
  fs.writeFileSync(path.join(staging, '.env.example'), envExample, 'utf8');
  console.log('  ✔ .env.example');

  // 创建空的数据目录
  console.log('4. 创建空数据目录...');
  mkdirp(path.join(staging, 'data'));
  mkdirp(path.join(staging, 'uploads'));
  mkdirp(path.join(staging, 'exports'));
  console.log('  ✔ data/ uploads/ exports/');

  // 创建 README
  console.log('5. 生成说明文档...');
  const readme = `# 物业不动产租赁管理系统 - 本地离线版

## 快速开始

### 1. 安装 Node.js
- 下载地址：https://nodejs.org/
- 建议版本：Node.js 18+
- 验证安装：打开命令行输入 \`node -v\`

### 2. 安装依赖
解压本压缩包后，打开命令行进入目录：
\`\`\`bash
cd 物业不动产租赁管理系统
npm install
\`\`\`

### 3. 配置（可选）
复制配置模板：
\`\`\`bash
cp .env.example .env
\`\`\`

默认配置即可使用（本地 JSON 存储 + 本地文件上传）。

如需使用七牛云存储或 TiDB 云端数据库，请参考 .env.example 修改配置。

### 4. 启动系统
双击运行：
\`\`\`
启动系统.bat
\`\`\`

或命令行启动：
\`\`\`bash
node server.js
\`\`\`

### 5. 访问系统
浏览器打开：http://localhost:8080/

**演示账号（密码统一 123456）：**
- admin / 123456（系统管理员）
- zhaoshang / 123456（招商经理）
- caiwu / 123456（财务经理）
- renshi / 123456（人事专员）

## 功能模块

- 房源管理
- 合同管理
- 收费管理（租金/水电/其他）
- 发票管理
- 审批流程
- 工单管理
- 巡更检查
- 人事薪酬
- 收入台账
- 报表导出

## 数据存储

本地版使用 JSON 文件存储，数据保存在 \`data/\` 目录。
定期备份 \`data/\` 目录即可。

## 升级五、注意事项

- 本版本为本地离线版，数据存储在本地 JSON 文件
- 如需多人协作，建议使用云端版（TiDB Cloud + Netlify）
- 附件存储默认为本地 \`uploads/\` 目录，可在 .env 中改为七牛云

## 技术支持

如有问题，请联系系统管理员。
`;
  fs.writeFileSync(path.join(staging, 'README.md'), readme, 'utf8');
  console.log('  ✔ README.md');

  // 生成打包命令
  console.log('\n6. 创建压缩包...');
  try {
    // 尝试用 7z 打包
    const七zPath = 'C:\\Program Files\\7-Zip\\7z.exe';
    if (fs.existsSync(七zPath)) {
      const zipPath = path.join(DIST, ZIP_NAME);
      execSync(`"${七zPath}" a -tzip "${zipPath}" "${staging}\\*"` , { stdio: 'inherit' });
      const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
      console.log('  ✔ 打包完成：' + zipPath);
      console.log('  📦 文件大小：' + size + ' MB');
    } else {
      console.log('  ⚠ 未找到 7-Zip，请手动打包：');
      console.log('     powershell -Command "Compress-Archive -Path \\"' + staging + '\\*" -DestinationPath \\"' + path.join(DIST, ZIP_NAME) + '\\" -Force"');
    }
  } catch (e) {
    console.log('  ⚠ 自动打包失败，请手动打包：');
    console.log('     powershell -Command "Compress-Archive -Path \\"' + staging + '\\*" -DestinationPath \\"' + path.join(DIST, ZIP_NAME) + '\\" -Force"');
  }

  console.log('\n=== 打包完成 ===');
  console.log('输出目录：' + DIST);
  console.log('\n分发步骤：');
  console.log('1. 将 ' + ZIP_NAME + ' 发送给使用者');
  console.log('2. 对方解压后运行 npm install');
  console.log('3. 双击 启动系统.bat 即可使用');
}

main();
