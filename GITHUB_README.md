# 物业不动产租赁管理系统

## 快速开始

### 本地运行
```bash
npm install
node server.js
```

### 云端部署
- **GitHub**: https://github.com/huangyonggm/property-lease-mgmt
- **Render**: https://property-lease.onrender.com (待部署)
- **Netlify**: https://property-lease.netlify.app (已运行旧版本)

## 演示账号
- admin / 123456 (管理员)
- zhaoshang / 123456 (招商经理)
- caiwu / 123456 (财务经理)
- renshi / 123456 (人事专员)

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
- 本地模式：JSON 文件（data/ 目录）
- 云端模式：TiDB Cloud Serverless

## 附件存储
- 本地模式：uploads/ 目录
- 云端模式：七牛云（配置 .env）
