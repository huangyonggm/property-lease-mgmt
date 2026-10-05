'use strict';
// 通用工具函数（零依赖）
const crypto = require('crypto');

function uid(prefix) {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return (prefix ? prefix + '_' : '') + t + r;
}

function pad(n, len) { n = String(n); while (n.length < (len || 2)) n = '0' + n; return n; }

function today() { return fmtDate(new Date()); }

function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}

function now() {
  const dt = new Date();
  return fmtDate(dt) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
}

function monthOf(d) {
  const dt = (d instanceof Date) ? d : new Date(d || Date.now());
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
}

function addMonths(dateStr, n) {
  const dt = new Date(dateStr);
  if (isNaN(dt.getTime())) return dateStr;
  const day = dt.getDate();
  dt.setDate(1);
  dt.setMonth(dt.getMonth() + n);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(day, last));
  return fmtDate(dt);
}

function addDays(dateStr, n) {
  const dt = new Date(dateStr);
  if (isNaN(dt.getTime())) return dateStr;
  dt.setDate(dt.getDate() + n);
  return fmtDate(dt);
}

function diffDays(a, b) {
  const da = new Date(a), db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return NaN;
  return Math.round((db - da) / 86400000);
}

function daysInMonth(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function num(v, def) {
  const n = Number(v);
  return (v === '' || v === null || v === undefined || isNaN(n)) ? (def === undefined ? 0 : def) : n;
}

function money(v) { return Math.round((num(v) + Number.EPSILON) * 100) / 100; }

function fmtMoney(v) {
  const n = num(v);
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

function clone(o) { return JSON.parse(JSON.stringify(o === undefined ? null : o)); }

function pick(o, keys) {
  const r = {};
  keys.forEach(k => { if (o && o[k] !== undefined) r[k] = o[k]; });
  return r;
}

// 数值区间：判断日期 a 是否在 [start, end] 内
function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

module.exports = {
  uid, pad, today, fmtDate, now, monthOf, addMonths, addDays, diffDays, daysInMonth,
  num, money, fmtMoney, md5, clone, pick, inRange, crypto
};
