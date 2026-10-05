'use strict';
// 浏览器实测：逐页截图 + 收集控制台错误
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8080';
const OUT = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['dashboard', '驾驶舱'], ['org', '组织权限'], ['property', '房源管理'], ['customer', '客户档案'],
  ['contract', '合同管理'], ['billing', '收费管理'], ['invoice', '发票管理'], ['approval', '审批流程'],
  ['workorder', '工单巡检'], ['hr', '人事薪酬'], ['patrol', '巡更检查'], ['report', '报表统计'], ['system', '系统设置']
];

// 人事薪酬的 5 个子页签
const HR_TABS = ['员工档案', '考勤管理', '请假加班', '薪资核算', '社保规则'];
// 巡更检查的 6 个子页签
const PATROL_TABS = [['ov', '数据概览'], ['pt', '巡更点位'], ['ps', '巡更人员'], ['rc', '巡查记录'], ['dy', '班次日报'], ['mo', '月度汇总']];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));

  // 登录
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPwd', '123456');
  await page.click('#loginBtn');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '01-驾驶舱.png'), fullPage: true });

  for (let i = 0; i < PAGES.length; i++) {
    const [key, name] = PAGES[i];
    await page.evaluate(k => { location.hash = '#/' + k; }, key);
    await page.waitForTimeout(1400);
    const txt = await page.evaluate(() => {
      const c = document.getElementById('pageContent');
      return c ? c.innerText.slice(0, 160).replace(/\s+/g, ' ') : '';
    });
    console.log('页面 ' + name + '：' + (txt.indexOf('加载失败') >= 0 || txt.indexOf('页面加载失败') >= 0 ? '❌ 加载失败' : '✔ ') + ' | ' + txt.slice(0, 90));
    await page.screenshot({ path: path.join(OUT, String(i + 2).padStart(2, '0') + '-' + name + '.png'), fullPage: true });
  }

  // 交互验证：房源 → 房间 tab → 新增表单
  await page.evaluate(() => { location.hash = '#/property'; });
  await page.waitForTimeout(1200);
  await page.click('#pageContent [data-act="add"]');
  await page.waitForTimeout(700);
  const hasForm = await page.$('.modal .form-grid');
  console.log('新增房源弹窗：' + (hasForm ? '✔ 正常弹出' : '❌ 未弹出'));
  await page.screenshot({ path: path.join(OUT, '20-房源新增弹窗.png') });
  await page.click('.mask .modal-head .x');

  // 合同详情抽屉
  await page.evaluate(() => { location.hash = '#/contract'; });
  await page.waitForTimeout(1400);
  const detailBtn = await page.$('[data-act2="detail"]');
  if (detailBtn) {
    await detailBtn.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, '21-合同详情抽屉.png') });
    console.log('合同详情抽屉：✔');
    await page.click('.mask .drawer .x').catch(() => { });
  }

  // 审批详情
  await page.evaluate(() => { location.hash = '#/approval'; });
  await page.waitForTimeout(1400);
  const apBtn = await page.$('[data-view]');
  if (apBtn) {
    await apBtn.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, '22-审批详情.png') });
    console.log('审批详情（多级节点）：✔');
    await page.click('.mask .modal-head .x').catch(() => { });
  }

  // 人事薪酬：逐个点击子页签并截图
  await page.evaluate(() => { location.hash = '#/hr'; });
  await page.waitForTimeout(1400);
  for (let t = 0; t < HR_TABS.length; t++) {
    const nm = HR_TABS[t];
    const tab = await page.$('#pageContent [data-tab="' + ['emp', 'att', 'lv', 'pay', 'ins'][t] + '"]');
    if (!tab) { console.log('人事子页签 ' + nm + '：❌ 未找到'); continue; }
    await tab.click();
    await page.waitForTimeout(1600);
    const t2 = await page.evaluate(() => {
      const c = document.getElementById('pageContent');
      return c ? c.innerText.slice(0, 150).replace(/\s+/g, ' ') : '';
    });
    const bad = t2.indexOf('加载失败') >= 0 || t2.indexOf('页面加载失败') >= 0;
    console.log('人事 · ' + nm + '：' + (bad ? '❌ 加载失败' : '✔ ') + ' | ' + t2.slice(0, 80));
    await page.screenshot({ path: path.join(OUT, '4' + t + '-人事-' + nm + '.png'), fullPage: true });
  }

  // 巡更检查：逐个点击子页签并截图
  await page.evaluate(() => { location.hash = '#/patrol'; });
  await page.waitForTimeout(1500);
  for (let t = 0; t < PATROL_TABS.length; t++) {
    const [tk, nm] = PATROL_TABS[t];
    const tab = await page.$('#pageContent [data-tab="' + tk + '"]');
    if (!tab) { console.log('巡更子页签 ' + nm + '：❌ 未找到'); continue; }
    await tab.click();
    await page.waitForTimeout(1800);
    const t2 = await page.evaluate(() => {
      const c = document.getElementById('pageContent');
      return c ? c.innerText.slice(0, 150).replace(/\s+/g, ' ') : '';
    });
    const bad = t2.indexOf('加载失败') >= 0 || t2.indexOf('页面加载失败') >= 0;
    console.log('巡更 · ' + nm + '：' + (bad ? '❌ 加载失败' : '✔ ') + ' | ' + t2.slice(0, 80));
    await page.screenshot({ path: path.join(OUT, '5' + t + '-巡更-' + nm + '.png'), fullPage: true });
  }

  // 工资条抽屉（薪资核算页签内）
  await page.evaluate(() => { location.hash = '#/hr'; });
  await page.waitForTimeout(1300);
  const payTab = await page.$('#pageContent [data-tab="pay"]');
  if (payTab) {
    await payTab.click();
    await page.waitForTimeout(1800);
    const slipBtn = await page.$('[data-pv]');
    if (slipBtn) {
      await slipBtn.click();
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(OUT, '45-工资条抽屉.png') });
      console.log('工资条抽屉（含个税累计明细）：✔');
      await page.click('.mask .drawer .x').catch(() => { });
    } else {
      console.log('工资条抽屉：❌ 未找到工资条按钮');
    }
  }

  // 移动端
  const mctx = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  mp.on('pageerror', e => errors.push('[mobile pageerror] ' + e.message));
  await mp.goto(BASE + '/m.html', { waitUntil: 'networkidle' });
  await mp.fill('#mUser', 'gongcheng');
  await mp.fill('#mPwd', '123456');
  await mp.click('.login-box .btn-primary');
  await mp.waitForSelector('.m-tabbar', { timeout: 15000 });
  await mp.waitForTimeout(1000);
  await mp.screenshot({ path: path.join(OUT, '30-移动端-待办.png'), fullPage: true });
  for (const [i, t] of [['patrol', '巡检录入'], ['meter', '抄表录入'], ['remind', '提醒中心']]) {
    await mp.click('.m-tabbar .t[data-t="' + i + '"]');
    await mp.waitForTimeout(1000);
    await mp.screenshot({ path: path.join(OUT, '3' + (i === 'patrol' ? '1' : i === 'meter' ? '2' : '3') + '-移动端-' + i + '.png'), fullPage: true });
    console.log('移动端 ' + i + '：✔');
  }

  console.log('\n控制台错误：' + (errors.length ? '\n' + errors.slice(0, 20).join('\n') : '无'));
  await browser.close();
})();
