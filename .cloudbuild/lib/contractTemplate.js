'use strict';
/**
 * 标准模板基线（由 合同模板（含普票）.docx 实测提取，勿手改）
 *
 * 为什么要固化：招商部上报的合同必须与物业的标准模板一致，
 * 差异要么是「占位符没填/填错」，要么是「条款被删改」。
 * 基线就是把模板拆成机器可判定的两件事：
 *   1. slots   —— 6 个可变槽位，每个槽位声明它对应系统哪个字段
 *   2. clauses —— 16 个章节 + 关键条款，用于「有没有漏条款 / 条款是否被改写」
 *
 * 字段来源：Y:\物业实际使用的报表及合同\合同模板（含普票）.docx
 * 实测：146 段、19 处星号占位符、16 个加粗章节标题、0 个表格
 */

const TEMPLATE_META = {
  fileName: '合同模板（含普票）.docx',
  title: '办公场所租赁合同',
  codePrefix: 'WHMXZC',
  paragraphs: 146,
  placeholderCount: 19,
  sectionCount: 16,
  tableCount: 0,
  version: '2026-10-04'
};

/**
 * 可变槽位：模板里的 ****** / *** / **** 对应系统合同的哪些字段
 * anchor  = 定位该槽位的锚句（契约：从这里往后找第一个数字/日期）
 * dbField = 系统 contracts 表字段名
 * type    = text | money | area | date | dateRange | int
 */
const SLOTS = [
  {
    key: 'contractCode',
    label: '合同编号',
    anchor: '合同编号：',
    dbField: 'code',
    type: 'text',
    required: true,
    // 模板示例：WHMXZC-2026******
    pattern: /^WHMXZC-\d{4}-?\d{2,6}$/,
    patternHint: '应形如 WHMXZC-2026-0001（WHMXZC-年份-流水）',
    severity: 'high'
  },
  {
    key: 'lessorName',
    label: '出租方（甲方）名称',
    anchor: '出租方（甲方）：',
    dbField: 'lessorName',
    type: 'text',
    required: true,
    severity: 'high'
  },
  {
    key: 'lessorContact',
    label: '甲方法定代表人',
    anchor: '出租方（甲方）：',
    subAnchor: '法定代表人：',
    dbField: 'lessorContact',
    type: 'text',
    required: false,
    severity: 'low'
  },
  {
    key: 'lessorPhone',
    label: '甲方联系方式',
    anchor: '出租方（甲方）：',
    subAnchor: '联系方式：',
    dbField: 'lessorPhone',
    type: 'text',
    required: false,
    severity: 'low'
  },
  {
    key: 'lesseeName',
    label: '承租方（乙方）名称',
    anchor: '承租方（乙方）：',
    dbField: 'customerName',
    type: 'text',
    required: true,
    severity: 'high'
  },
  {
    key: 'lesseeContact',
    label: '乙方法定代表人',
    anchor: '承租方（乙方）：',
    subAnchor: '法定代表人：',
    dbField: 'lesseeContact',
    type: 'text',
    required: false,
    severity: 'low'
  },
  {
    key: 'lesseePhone',
    label: '乙方联系方式',
    anchor: '承租方（乙方）：',
    subAnchor: '联系方式：',
    dbField: 'lesseePhone',
    type: 'text',
    required: false,
    severity: 'low'
  },
  {
    key: 'location',
    label: '房屋坐落（含楼层单元）',
    // 模板：武汉市东西湖区宏图一路9号梦想之城T3﹣第***层***单元
    anchor: '乙方愿意承租甲方位于',
    dbField: null,          // 需由 roomCodes 拼楼层/单元
    type: 'location',
    required: true,
    severity: 'high'
  },
  {
    key: 'area',
    label: '签约服务面积',
    // 模板：签约服务面积****平方米
    anchor: '经双方确认该房屋的签约服务面积',
    dbField: 'area',
    type: 'area',
    unit: '平方米',
    required: true,
    severity: 'high'
  },
  {
    key: 'startDate',
    label: '起租日',
    // 模板：租赁期限为****年，自******年****月****日起至****年****月*****日止
    // ⚠ anchor 必须含「租赁期限为」这一定位词。裸用「自」会匹配到「乙方自愿承租」
    //   等任意含「自」的段落 —— 第一版就误定位到了第 5 段，误报"起租日未找到"。
    anchor: '租赁期限为',
    dbField: 'startDate',
    type: 'date',
    scope: 'sentence',
    required: true,
    severity: 'high'
  },
  {
    key: 'endDate',
    label: '到期日',
    anchor: '租赁期限为',
    anchorTail: '起至',
    nth: 2,
    dbField: 'endDate',
    type: 'date',
    scope: 'sentence',
    required: true,
    severity: 'high'
  },
  {
    key: 'rentYears',
    label: '租赁期限（年数）',
    // 模板：租赁期限为****年
    anchor: '租赁期限为',
    dbField: null,          // 由 startDate/endDate 推导
    type: 'int',
    unit: '年',
    required: true,
    severity: 'medium'
  },
  {
    key: 'rentMonthly',
    label: '月租金（含物业综合服务费）',
    // 模板：固定月租金（含物业综合服务费）￥********元
    anchor: '支付固定月租金（含物业综合服务费）',
    dbField: 'rentMonthly',
    type: 'money',
    required: true,
    severity: 'high'
  },
  {
    key: 'deposit',
    label: '履约保证金',
    // 模板：乙方应支付甲方￥******元（大写：**********元整）作为履约保证金
    // ⚠ anchor 必须落在金额**之前**。第一版用「作为履约保证金」，
    //   而它在句尾，取"锚点之后的内容"当然取不到金额 → 误报"保证金缺失"。
    anchor: '乙方应支付甲方',
    dbField: 'deposit',
    type: 'money',
    required: true,
    severity: 'high'
  },
  {
    key: 'lesseeAddress',
    label: '乙方送达地址',
    // 模板：T3栋****室
    anchor: '乙方地址：',
    dbField: null,
    type: 'text',
    required: false,
    severity: 'medium'
  }
];

/**
 * 关键条款基线：16 个章节 + 若干必须存在的核心条款
 * mode:
 *   'title'  —— 章节标题必须出现（可缺失检测）
 *   'exact'  —— 条款文本必须逐字一致（不允许改写）
 *   'fuzzy'  —— 条款可容许少量差异，用 ratio 阈值
 */
const CLAUSES = [
  { id: 'C01', mode: 'title', section: 1, label: '一、租赁房屋坐落、面积、用途', match: /^一、租赁房屋坐落、面积、用途$/, severity: 'high' },
  { id: 'C02', mode: 'title', section: 2, label: '二、租赁房屋的交付', match: /^二、租赁房屋的交付$/, severity: 'high' },
  { id: 'C03', mode: 'title', section: 3, label: '三、租期及计租日', match: /^三、租期及计租日$/, severity: 'high' },
  { id: 'C04', mode: 'title', section: 4, label: '四、房屋租金及相关费用及支付方式', match: /^四、房屋租金及相关费用及支付方式\s*$/, severity: 'high' },
  { id: 'C05', mode: 'title', section: 5, label: '五、履约保证金', match: /^五、履约保证金$/, severity: 'high' },
  { id: 'C06', mode: 'title', section: 6, label: '六、房屋公共设施维护管理', match: /^六、房屋公共设施维护管理$/, severity: 'medium' },
  { id: 'C07', mode: 'title', section: 7, label: '七、甲方承诺', match: /^七、甲方承诺$/, severity: 'high' },
  { id: 'C08', mode: 'title', section: 8, label: '八、乙方承诺', match: /^八、乙方承诺$/, severity: 'high' },
  { id: 'C09', mode: 'title', section: 9, label: '九、租赁房屋的交还', match: /^九、租赁房屋的交还$/, severity: 'high' },
  { id: 'C10', mode: 'title', section: 10, label: '十、免责条款', match: /^十、免责条款$/, severity: 'medium' },
  { id: 'C11', mode: 'title', section: 11, label: '十一、特别约定', match: /^十一、特别约定$/, severity: 'high' },
  { id: 'C12', mode: 'title', section: 12, label: '十二、合同的变更和解除', match: /^十二、合同的变更和解除[：:]?\s*$/, severity: 'high' },
  { id: 'C13', mode: 'title', section: 13, label: '十三、违约责任', match: /^十三、违约责任$/, severity: 'high' },
  { id: 'C14', mode: 'title', section: 14, label: '十四、争议解决', match: /^十四、争议解决$/, severity: 'high' },
  { id: 'C15', mode: 'title', section: 15, label: '十五、送达', match: /^十五、送达$/, severity: 'medium' },
  { id: 'C16', mode: 'title', section: 16, label: '十六、其它', match: /^十六、其它$/, severity: 'low' },

  // ---- 核心条款：删改就是重大合规风险 ----
  {
    id: 'K01', mode: 'fuzzy', section: 1, label: '物业费单价 7.5 元/㎡（模板约定值）',
    must: /物业综合服务费按每平方米\s*7\.5\s*元/,
    expect: '物业综合服务费按每平方米7.5元收取',
    severity: 'high', group: '费用标准'
  },
  {
    id: 'K02', mode: 'fuzzy', section: 3, label: '租金递增：第三年起每年递增 6%',
    must: /第三年起每年递增\s*6\s*%/,
    expect: '第三年起每年递增6%',
    severity: 'high', group: '费用标准'
  },
  {
    id: 'K03', mode: 'fuzzy', section: 1, label: '停车位 396 元/个·月',
    must: /396\s*元\s*\/\s*个/,
    expect: '车位价格每月 396元/个',
    severity: 'high', group: '费用标准'
  },
  {
    id: 'K04', mode: 'fuzzy', section: 1, label: '转租手续费 2000 元',
    must: /转租手续费\s*2000\s*元/,
    expect: '转租手续费2000 元',
    severity: 'medium', group: '费用标准'
  },
  {
    id: 'K05', mode: 'fuzzy', section: 4, label: '仅接受转账收款，不收微信支付宝',
    must: /不接受微信、支付宝等第三方收款方式/,
    expect: '甲方一律采用转账的方式收取租金…不接受微信、支付宝等第三方收款方式收取',
    severity: 'high', group: '收款合规'
  },
  {
    id: 'K06', mode: 'fuzzy', section: 5, label: '保证金退还条件（四项全满足）',
    must: /三十个工作日内/,
    expect: '该履约保证金在以下条件全部满足后三十个工作日内，由甲方向乙方无息全额退还',
    severity: 'high', group: '保证金'
  },
  {
    id: 'K07', mode: 'fuzzy', section: 4, label: '租金按季度预付、期满前 10 日支付下期',
    must: /按季度支付|先付后用/,
    expect: '房屋租金按季度支付…在每季度期满前10日内支付下一季度租金',
    severity: 'high', group: '收款合规'
  },
  {
    id: 'K08', mode: 'fuzzy', section: 13, label: '违约金：日千分之五',
    must: /日千分之五/,
    expect: '乙方应按照日千分之五的标准以未付金额为基数向甲方支付违约金',
    severity: 'high', group: '违约责任'
  },
  {
    id: 'K09', mode: 'fuzzy', section: 13, label: '违约金基数为当期三个月租金',
    must: /当期三个月租金/,
    expect: '乙方应支付甲方当期三个月租金',
    severity: 'high', group: '违约责任'
  },
  {
    id: 'K10', mode: 'fuzzy', section: 14, label: '争议解决：武汉仲裁委员会',
    must: /武汉仲裁委员会/,
    expect: '任何一方可向武汉仲裁委员会申请仲裁',
    severity: 'high', group: '争议解决'
  },
  {
    id: 'K11', mode: 'fuzzy', section: 7, label: '甲方提前解约：提前两个月通知 + 三个月租金补偿',
    must: /提前两个月书面通知乙方/,
    expect: '甲方因特殊情况需提前解除合同的，应提前两个月书面通知乙方。甲方应向乙方支付当期三个月租金补偿乙方损失。',
    severity: 'high', group: '解约条件'
  },
  {
    id: 'K12', mode: 'fuzzy', section: 12, label: '严重违约：逾期超 3 个日历天可解约',
    must: /累计超过\s*3\s*个日历天/,
    expect: '逾期向甲方支付租金…累计超过3个日历天',
    severity: 'high', group: '解约条件'
  },
  {
    id: 'K13', mode: 'fuzzy', section: 3, label: '到期还房：期满后 3 日内交还',
    must: /租赁期满后\s*3\s*日内/,
    expect: '乙方应在租赁期满后3日内将租赁房屋按甲方要求交还',
    severity: 'medium', group: '解约条件'
  },
  {
    id: 'K14', mode: 'fuzzy', section: 8, label: '乙方放弃就房屋现状主张减付权利',
    must: /不得以房屋现状与约定不符/,
    expect: '乙方不得以房屋现状与约定不符、存在隐蔽瑕疵…向甲方主张减付或拒付租金',
    severity: 'high', group: '乙方义务'
  },
  {
    id: 'K15', mode: 'fuzzy', section: 9, label: '不可移动装修无偿归甲方所有',
    must: /无偿归甲方所有/,
    expect: '乙方不得进行损毁，不得拆除搬离，无偿归甲方所有',
    severity: 'medium', group: '房屋交还'
  },
  {
    id: 'K16', mode: 'fuzzy', section: 4, label: '提供普通发票',
    must: /甲方提供普通发票/,
    expect: '甲方提供普通发票',
    severity: 'medium', group: '票据'
  },
  {
    id: 'K17', mode: 'fuzzy', section: 8, label: '消防责任：乙方自行负责消防安全并放置灭火器',
    must: /放置消防灭火器/,
    expect: '乙方应自行负责所承租租赁房屋的消防安全及财产安全，并在承租租赁房屋内放置消防灭火器',
    severity: 'high', group: '乙方义务'
  },
  {
    id: 'K18', mode: 'fuzzy', section: 2, label: '交付：未办理交接视为已交付',
    must: /视为甲方已完成交付/,
    expect: '则视为甲方已完成交付，该书面通知中记载的房屋交付日为交付日',
    severity: 'medium', group: '房屋交还'
  }
];

/** 模板里写死的、不允许改的固定条款（改了必须报） */
const FIXED_ITEMS = [
  { key: 'title', label: '合同标题', expect: '办公场所租赁合同', severity: 'high' },
  { key: 'preamble', label: '合同前言（含法规依据与标的）', must: /根据《中华人民共和国民法典》/, severity: 'high' },
  { key: 'lessorAddr', label: '甲方送达地址', expect: '武汉市东西湖区将军路街道宏图一路9号梦想之城T3栋103室', severity: 'high' },
  { key: 'lessorTel', label: '甲方电话', expect: '15927038896', severity: 'medium' },
  { key: 'project', label: '项目名称（梦想之城T3）', must: /梦想之城T3/, severity: 'high' },
  { key: 'use', label: '房屋用途（办公）', must: /用于办公使用/, severity: 'high' },
  { key: 'copies', label: '合同份数（一式贰份）', must: /一式贰份/, severity: 'medium' },
  // ⚠ 所有 must/expect 正则都必须写「半角标点」——
  //   比对前文本会经 norm() 归一，全角（）:; 全部转成半角。
  //   写成全角 /（以下无正文）/ 会永远不匹配（第一版就栽在这，误报"标记缺失"）。
  { key: 'noBody', label: '「（以下无正文）」标记', must: /\(以下无正文\)/, severity: 'low' }
];

/** 不参与比对的噪声（页码、空白、下划线签名线） */
const NOISE = [
  /^第\s*\d+\s*页\s*共\s*\d+\s*页$/,
  /^日期：\s*年\s*月\s*日/,
  /^\s*$/,
  /^[_\s·．.]{3,}$/,
  /^户名：\s*$/,
  /^银行账号：\s*$/,
  /^开户行：\s*$/,
  /^电话：\s*$/,
  /^法定代表人：\s*$/,
  /^联系方式：\s*$/,
  /^出租方（甲方）：\s*$/,
  /^承租方（乙方）：\s*$/,
  /^(签章处|法定代表人或授权代表人)：?\s*$/
];

/** 严重度排序（用于前端标注优先级） */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

module.exports = { TEMPLATE_META, SLOTS, CLAUSES, FIXED_ITEMS, NOISE, SEVERITY_ORDER };
