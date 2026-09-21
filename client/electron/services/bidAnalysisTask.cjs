const { buildBidSectionContextHint } = require('../utils/bidSectionContext.cjs');
const { mergeSegmentedAiResults } = require('../utils/segmentedAiResultMerger.cjs');
const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const {
  createTenderContextIndex,
  retrieveTenderContext,
  formatTenderContextForPrompt,
} = require('./tenderContextRetriever.cjs');

const PROMPT_CACHE_WARMUP_DELAY_MS = 5000;
const TENDER_ANALYSIS_RETRIEVAL_THRESHOLD_CHARS = 24000;
const TENDER_ANALYSIS_DEFAULT_RETRIEVAL_CHARS = 8000;
const TENDER_ANALYSIS_BROAD_RETRIEVAL_CHARS = 16000;
const TENDER_ANALYSIS_MAX_SNIPPETS = 8;

const TASK_RETRIEVAL_HINTS = {
  projectOverview: '项目名称 项目背景 项目概况 项目目标 项目规模 预算 实施内容 建设内容 技术特点 实施范围 时间安排',
  techRequirements: '技术评分 评分标准 技术评分项 评分细则 技术要求 技术参数 技术方案 评审因素 评审标准',
  projectInfo: '项目名称 项目编号 项目类型 预算 项目预算 项目地址 实施地点',
  partAInfo: '招标人 采购人 甲方 招标单位 联系人 联系电话 地址',
  deliveryAndServiceRequirements: '交付 实施周期 工期 交付期限 交付范围 实施地点 验收 质保 售后 响应 培训 文档',
  procurementList: '采购清单 采购需求 货物需求 服务内容 数量 规格型号 技术参数 工程量清单 分项报价',
  responseFileRequirements: '响应文件 投标文件 文件组成 格式 签字 盖章 装订 密封 上传 递交 偏离表 承诺函 附件',
  qualificationReview: '资格条件 资格审查 投标人资格 资质 业绩 人员 法定代表人 授权',
  complianceCheck: '符合性检查 实质性响应 偏离 重大偏差 文件完整性 无效响应',
  openBid: '开标 开标时间 开标地点 开标要求 参与要求 无效标 异议 开标流程',
  evaluationBid: '评标委员会 评标方法 评标原则 评分构成 评审办法 评标',
  businessScoring: '商务评分 商务部分 企业业绩 资质 认证 荣誉 财务 人员',
  discardedBids: '无效投标 废标 否决投标 不予受理 无效响应 重大偏差 实质性偏离 保证金 截止时间 资格',
  signingProcess: '中标 中标通知书 合同授予 合同签订 履约保证金 合同文本',
  terminationCondition: '合同解除 合同终止 违约 不可抗力 争议解决',
  agentInfo: '代理机构 采购代理 联系人 电话 地址 邮箱 银行账户 开户行',
  keyInfo: '招标公告 文件获取 获取时间 售价 投标截止 开标时间 开标地点 递交',
  marginInfo: '投标保证金 保证金 缴纳方式 截止时间 退还 不予退还',
};
const MARKDOWN_MISSING_RESULT = '未提取到';

const OPTIONAL_BID_ANALYSIS_BUNDLES = [
  ['response-compliance', [
    'responseFileRequirements',
    'qualificationReview',
    'complianceCheck',
    'discardedBids',
  ]],
  ['timeline-admin', [
    'agentInfo',
    'keyInfo',
    'marginInfo',
    'openBid',
    'signingProcess',
    'terminationCondition',
  ]],
  ['evaluation-procurement', [
    'procurementList',
    'evaluationBid',
    'businessScoring',
  ]],
];

const OPTIONAL_BUNDLE_SCHEMAS = {
  agentInfo: { output: 'json', fields: ['company_name','address','contact_person','contact_phone','email','bank_account_name','bank_account_number','bank_account_address','bank_account_address_detail'] },
  keyInfo: { output: 'json', fields: ['bid_announcement_time','bid_file_get_way','bid_file_price','get_bid_file_time','bid_document_submission_location','bid_submission_deadline','bid_opening_time','bid_opening_address','other_notes'] },
  marginInfo: { output: 'json', fields: ['bidding_deposit','payment_method','due_date','refund_conditions','non_refundable_conditions','other_notes'] },
  openBid: { output: 'json', fields: ['time_place','part_req','invalid_bid','objection','bid_process'] },
  signingProcess: { output: 'json', fields: ['bid_notice','contract_sign','performance_bond','contract_text'] },
  terminationCondition: { output: 'json', fields: ['breach_termination','force_majeure','contract_termination','dispute_resolution'] },
  evaluationBid: { output: 'json', fields: ['committee','duties','scoring','method','principles','others'] },
  responseFileRequirements: { output: 'markdown' },
  qualificationReview: { output: 'markdown' },
  complianceCheck: { output: 'markdown' },
  discardedBids: { output: 'markdown' },
  procurementList: { output: 'markdown' },
  businessScoring: { output: 'markdown' },
};

const OPTIONAL_BUNDLE_INSTRUCTIONS = {
  responseFileRequirements: '提取响应/投标文件组成、固定模板、签字盖章、文件格式、份数、密封/上传/递交、偏离表及提交节点等要求，不要编造最终响应内容。',
  qualificationReview: '提取投标人资格条件、资格审查材料、资质、业绩、人员等要求；没有提及就写“没有提及”。',
  complianceCheck: '提取文件完整性、有效性、规范、偏差处理和实质性响应等符合性要求；没有提及就写“没有提及”。',
  discardedBids: '提取无效投标、否决投标、废标情形及高风险遗漏项；明确项与经验补充应区分；不要泛化罗列。',
  procurementList: '提取采购清单/采购需求、名称、规格、数量、参数、交付、验收、质保等实际出现的信息；尽量保持原始字段含义。',
  businessScoring: '提取商务评分因素，为商务响应编写提供直接依据；不要提取无关技术内容。',
  agentInfo: '提取代理机构名称、地址、联系人、电话、邮箱及银行账户相关信息。',
  keyInfo: '提取公告、文件获取、递交、截止、开标等关键时间节点和地点。',
  marginInfo: '提取投标保证金金额、缴纳方式、截止、退还、不予退还及注意事项。',
  openBid: '提取开标时间地点、参与要求、无效标认定、异议处理、开标流程。',
  evaluationBid: '提取评标委员会、职责、评分构成、评标方法、评标原则及其他评标信息。',
  signingProcess: '提取中标公示、合同签订、履约保证金、合同文本等流程信息。',
  terminationCondition: '提取违约解除、不可抗力、合同终止、争议解决等条件。',
};



function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

const stableSystemPrompt = `你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容；除非具体任务明确要求或允许根据经验补充，否则不要自行编造
2. 已提取到相关内容但局部信息没有提及时，明确写“没有提及”
3. 只输出最终结果，不输出过程、提示语或客套话
4. 始终使用简体中文`;

function jsonTask(title, goals, outputJson) {
  return `任务：${title}

目标：${goals}

约束：
1. 输出格式必须为 JSON。
2. 严格按照以下 JSON 格式输出，只修改 value，禁止修改 key 和结构。
3. 招标文件中没有的字段填充“没有提及”。

JSON 格式：
${outputJson}

仅输出 JSON，不要输出其他内容。`;
}

function buildInvalidBidAndRejectionItemsPrompt() {
  return `任务：提取并分析招标文件中的“无效投标”和“废标项”。

概念边界：
1. “无效投标”指投标人、投标文件、签章密封、递交时间、报价、保证金、资格条件、实质性响应等原因导致投标被认定为无效、否决、不予受理或按无效响应处理的情形。
2. “废标项”指可能导致项目废标、采购失败、重新招标、终止评审、有效投标人不足或实质性响应不足的条款或风险项。
3. 招标文件使用“否决投标”“投标无效”“不予受理”“无效响应”“重大偏差”“实质性偏离”“废标情形”等同义表达时，也要按上述边界归类。

输出要求：
1. 必须明确区分“无效投标”和“废标项”。
2. “招标文件中明确提到的”只能提取招标文件中明确出现或同义表达的内容，尽量保留招标文件中的关键句；如果没有提及，写“招标文件未提及”。
3. “此类标书还可能涉及的”需要根据你的经验，补充招标文件中未明确提及、但结合本招标文件类型和招投标经验判断非常重要的高风险遗漏项。
4. 不要罗列所有常见可能项，不要输出泛泛的通用清单；每个小节最多输出 3-5 条。
5. 不要使用表格，使用 Markdown 列表。
6. 仅输出下方格式，不要输出解释、过程或额外段落。
7. 不要输出三重引号、代码块标记或其他格式包裹符。

输出格式：
# 招标文件中明确提到的

## 无效投标
- ...

## 废标项
- ...

# 此类标书还可能涉及的

## 无效投标
- ...

## 废标项
- ...`;
}

const tasks = [
  {
    id: 'projectOverview', label: '项目概述', required: true, output: 'markdown', description: '提取项目基本信息、背景目的、规模预算、时间安排、实施内容和技术特点等。',
    prompt: () => `任务：提取并总结项目概述信息。

请重点关注项目名称、基本信息、背景目的、规模预算、时间安排、实施内容、技术特点和其他关键要求。

工作要求：保持信息全面准确，尽量使用招标文件中的内容；只关注与项目实施有关的内容，不提取商务信息；直接返回整理好的项目概述。`,
  },
  {
    id: 'techRequirements', label: '技术评分要求', required: true, output: 'markdown', description: '提取技术评分项、权重分值、评分标准和招标文件中的位置。',
    prompt: () => `任务：提取技术评分信息，并按语义区分“技术评分项”和“技术评分要求”。

重点识别“技术评分”“评标方法”“评分标准”“技术参数”“技术要求”“技术方案”“技术部分”“评审要素”相关章节，不要提取商务、价格、资质等无关条目。

分类原则：
1. 技术评分项：指投标人需要在技术方案中一一响应、展开编写，并可对应形成技术方案章节的具体评分内容，例如方案类、措施类、团队类、实施类、服务类、保障类、运维类、应急类、检查类等评分内容。
2. 技术评分要求：指用于约束评分、解释评分、定义扣分或判定规则的通用规则或说明，例如符合性要求、偏离扣分规则、判定口径、适用范围说明、表后说明、通用评审规则等。
3. 判断依据是该内容是否要求投标人在技术方案中展开具体方案内容；如果不是具体方案内容，即使带有分值或扣分规则，也归入技术评分要求。
4. 若原文存在层级关系，请保持顺序和来源，不要自行合并不相关条款。

输出格式：

## 技术评分项

【评分项名称】：<招标文件描述，保留专业术语>
【权重/分值】：<具体分值或占比>
【评分标准】：<详细规则>
【数据来源】：<章节、条款、页码或表格位置>

## 技术评分要求

【评分要求名称】：<要求或规则名称>
【适用范围】：<适用于哪些评分项或评审环节>
【要求/判定口径】：<具体要求、解释、扣分或判定规则>
【数据来源】：<章节、条款、页码或表格位置>

若某一类没有内容，请保留对应标题并写“没有提及”。直接返回提取结果。`,
  },
  { id: 'projectInfo', label: '项目信息', required: true, output: 'json', description: '项目名称、编号、类型、预算和地址。', prompt: () => jsonTask('提取项目信息', '提取项目名称、项目编号、项目类型、项目预算、项目地址。', `{"project_name":"项目名称","project_number":"项目编号","project_type":"项目类型","project_budget":"项目预算","project_address":"项目地址"}`) },
  { id: 'partAInfo', label: '甲方信息', required: true, output: 'json', description: '招标人公司、地址、联系人和电话。', prompt: () => jsonTask('提取甲方信息', '提取公司名称、地址、联系人、联系电话。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话"}`) },
  { id: 'deliveryAndServiceRequirements', label: '交货和服务要求', required: true, output: 'json', description: '实施周期、交付范围、地点、验收、质保、售后、响应、培训和文档要求。', prompt: () => jsonTask('提取交货和服务要求', '提取实施周期/工期/交付期限、交付范围、交付/实施地点、验收要求、质保期、售后服务要求、响应时限、培训要求、资料/文档交付要求。', `{"implementation_period":"实施周期/工期/交付期限","delivery_scope":"交付范围","delivery_location":"交付/实施地点","acceptance_requirements":"验收要求","warranty_period":"质保期","after_sales_service":"售后服务要求","response_time":"响应时限","training_requirements":"培训要求","documentation_requirements":"资料/文档交付要求"}`) },
  {
    id: 'procurementList', label: '采购清单', required: false, output: 'markdown', description: '采购内容、数量、规格参数、交付和验收要求。',
    prompt: () => `任务：提取招标文件、询比文件或采购文件中的采购清单/采购需求信息。

请从招标文件中识别与“采购清单、采购需求、采购内容、货物需求、服务内容、技术参数、规格要求、报价清单、分项报价、工程量清单”等含义相近的内容。

提取要求：
1. 优先保留招标文件中的表格、条目和字段含义，不要自行补充招标文件没有的信息。
2. 如果原文是表格，请尽量整理为 Markdown 表格；如果表格结构复杂，可以按“清单项 + 要求说明”的方式整理。
3. 如果不同章节分别描述采购内容、技术参数、数量、交付、验收、质保等要求，请合并整理，但要避免编造不存在的字段。
4. 字段名称不要求固定，按招标文件实际出现的信息组织，例如名称、规格型号、技术参数、单位、数量、预算/限价、交付地点、交付时间、验收要求、质保要求、备注等。
5. 如果没有找到明确采购清单，请说明“未找到明确采购清单”，并列出可能相关的采购需求段落摘要。
6. 只输出整理结果，不要输出分析过程。`,
  },
  {
    id: 'responseFileRequirements', label: '响应文件要求', required: true, output: 'markdown', description: '响应文件组成、格式模板、签章、递交和偏离表要求。',
    prompt: () => `任务：提取招标文件、询比文件或采购文件中关于响应文件/投标文件编制与提交的要求。

请识别与“响应文件、投标文件、报价文件、资格证明文件、商务响应、技术响应、偏离表、响应文件格式、投标文件格式、递交要求、签字盖章、密封上传”等含义相近的内容。

提取要求：
1. 按招标文件实际结构整理，不要强制套用固定模板。
2. 重点提取响应文件需要包含哪些部分，例如报价文件、商务文件、技术文件、资格证明、承诺函、授权委托书、响应表、偏离表、分项报价表等。
3. 如果招标文件提供了固定格式、表格或附件模板，请提取模板名称、用途、填写要求和关键字段。
4. 提取签字盖章、文件命名、装订/密封、上传格式、份数、递交截止时间、递交方式等要求。
5. 保持投标文件中所列的响应文件顺序，保证后续编写响应文件时，可以直接按照你提取的结果一一对应编写。
6. 区分“必须提供”和“如适用/可选提供”的内容；如果招标文件没有明确区分，不要自行判断。
7. 不要生成供应商自己的最终响应文件，不要编造公司信息、报价、资质、承诺内容。
8. 如果没有找到明确响应文件要求，请说明“未找到明确响应文件要求”，并列出可能相关的投标/响应文件格式段落摘要。
9. 只输出整理结果，不要输出分析过程。`,
  },
  { id: 'agentInfo', label: '代理机构信息', required: false, output: 'json', description: '代理机构联系方式和账户信息。', prompt: () => jsonTask('提取代理机构信息', '提取代理机构名称、地址、联系人、电话、邮箱和银行账户信息。', `{"company_name":"公司名称","address":"地址","contact_person":"联系人","contact_phone":"联系电话","email":"联系邮箱","bank_account_name":"银行账户名称","bank_account_number":"银行账户账号","bank_account_address":"银行账户开户行","bank_account_address_detail":"银行账户开户行地址"}`) },
  { id: 'keyInfo', label: '投标关键节点', required: false, output: 'json', description: '公告、获取文件、递交、截止和开标信息。', prompt: () => jsonTask('提取投标关键节点', '提取招标公告发布日期、招标文件获取方式、售价、获取时间、提交地点、截止时间、开标时间、开标地点和其他注意事项。', `{"bid_announcement_time":"招标公告发布日期","bid_file_get_way":"招标文件获取方式","bid_file_price":"招标文件售价","get_bid_file_time":"获取招标文件时间","bid_document_submission_location":"投标文件提交地点","bid_submission_deadline":"投标截止时间","bid_opening_time":"开标时间","bid_opening_address":"开标地点","other_notes":"其他注意事项"}`) },
  { id: 'marginInfo', label: '投标保证金', required: false, output: 'json', description: '保证金金额、方式、截止和退还条件。', prompt: () => jsonTask('提取投标保证金信息', '提取投标保证金、缴纳方式、截止日期、退还条件、不予退还情形和其他注意事项。', `{"bidding_deposit":"投标保证金","payment_method":"缴纳方式","due_date":"截止日期","refund_conditions":"退还条件","non_refundable_conditions":"不予退还的情形","other_notes":"其他注意事项"}`) },
  { id: 'qualificationReview', label: '资格性审查', required: false, output: 'markdown', description: '投标人资格条件和资格审查要求。', prompt: () => '任务：提取招标文件中关于投标人资格性审查的信息。整理成方便阅读的 Markdown，不要使用表格；如果招标文件是表格，请转换为列表。仅输出整理结果。' },
  { id: 'complianceCheck', label: '符合性检查', required: false, output: 'markdown', description: '文件完整性、有效性、规范和偏差处理要求。', prompt: () => '任务：总结招标文件中关于符合性检查的信息，包括文件完整性、文件有效性、文件规范、偏差处理等。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'openBid', label: '开标要求', required: false, output: 'json', description: '开标时间地点、参与要求、无效标和流程。', prompt: () => jsonTask('提取开标信息', '提取时间地点、参与要求、无效标认定、异议处理、开标流程。', `{"time_place":"时间地点","part_req":"参与要求","invalid_bid":"无效标认定","objection":"异议处理","bid_process":"开标流程"}`) },
  { id: 'evaluationBid', label: '评标要求', required: false, output: 'json', description: '评标委员会、评分构成、方法和原则。', prompt: () => jsonTask('提取评标信息', '提取评标委员会组成、职责、评分构成、评标方法类型、评标原则和方法细节、其他评标相关说明。', `{"committee":"评标委员会组成","duties":"评标委员会职责","scoring":"评分构成","method":"评标方法类型","principles":"评标原则和方法细节","others":"其他和评标相关的说明"}`) },
  { id: 'businessScoring', label: '商务评分要求', required: false, output: 'markdown', description: '商务评分因素，为商务方案准备。', prompt: () => '任务：提取招标文件中的商务评分因素，为编写投标文件中的商务方案做准备。整理成 Markdown，不要使用表格。仅输出整理结果。' },
  { id: 'discardedBids', label: '无效标与废标项', required: false, output: 'markdown', description: '投标无效、废标相关风险项。', prompt: buildInvalidBidAndRejectionItemsPrompt },
  { id: 'signingProcess', label: '合同授予与签订', required: false, output: 'json', description: '中标公示、合同签订、履约保证金和合同文本。', prompt: () => jsonTask('提取合同授予和签订流程', '提取中标公示、合同签订、履约保证金、合同文本等信息。', `{"bid_notice":"中标公示","contract_sign":"合同签订","performance_bond":"履约保证金","contract_text":"合同文本"}`) },
  { id: 'terminationCondition', label: '合同解除和终止', required: false, output: 'json', description: '违约解除、不可抗力、合同终止和争议解决。', prompt: () => jsonTask('提取合同解除和终止条件', '提取违约解除、不可抗力、合同终止、争议解决等信息。', `{"breach_termination":"违约解除","force_majeure":"不可抗力","contract_termination":"合同终止","dispute_resolution":"争议解决"}`) },
];

function getBidAnalysisTasks(mode) {
  return mode === 'full' ? tasks : tasks.filter((task) => task.required);
}

function normalizeBidAnalysisTaskIds(taskIds) {
  const requestedIds = new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((taskId) => String(taskId || '').trim())
    .filter(Boolean));
  return tasks.filter((task) => requestedIds.has(task.id)).map((task) => task.id);
}

function normalizeBidAnalysisConfig(mode, selectedTaskIds) {
  const requiredTaskIds = getBidAnalysisTasks('key').map((task) => task.id);
  const requiredSet = new Set(requiredTaskIds);
  const selectedSet = new Set([...requiredTaskIds, ...normalizeBidAnalysisTaskIds(selectedTaskIds)]);
  const selectedIds = tasks.filter((task) => selectedSet.has(task.id)).map((task) => task.id);
  const hasOptional = selectedIds.some((taskId) => !requiredSet.has(taskId));
  const hasAll = selectedIds.length === tasks.length;

  if (mode === 'full' || hasAll) {
    return { mode: 'full', taskIds: tasks.map((task) => task.id) };
  }
  if (mode === 'custom' || hasOptional) {
    return { mode: 'custom', taskIds: selectedIds };
  }
  return { mode: 'key', taskIds: requiredTaskIds };
}

function getBidAnalysisTaskById(taskId) {
  return tasks.find((task) => task.id === taskId);
}

// 为 Markdown 解析项统一约定整项无结果标记，避免与局部缺失混淆。
function buildTaskPrompt(task) {
  const prompt = task.prompt();
  if (task.output !== 'markdown') return prompt;
  return `${prompt}

整体无结果规则：仅当当前任务完全未提取到任何相关内容时，只返回“${MARKDOWN_MISSING_RESULT}”，不要附加标题、标点、解释或其他文字。只要提取到任何有效内容，就正常返回结果；局部字段或局部分类缺失时写“没有提及”，不要使用“${MARKDOWN_MISSING_RESULT}”。`;
}

function isMissingMarkdownResult(task, content) {
  return task.output === 'markdown' && String(content || '').trim() === MARKDOWN_MISSING_RESULT;
}

function buildTaskRetrievalQuery(task, sectionHint) {
  const id = String(task?.id || '').trim();
  const hint = TASK_RETRIEVAL_HINTS[id] || [task?.label || '', task?.description || ''].join(' ');
  return [hint, sectionHint || ''].filter(Boolean).join('\n');
}

function compactPromptText(value, maxChars) {
  const text = String(value || '').trim();
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!text || !limit || text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit * 0.72));
  const tail = Math.max(1, limit - head);
  return \`${text.slice(0, head)}\\n…（招标解析上下文已压缩）…\\n${text.slice(-tail)}\`;
}

function buildTenderAnalysisBundleContext(fileContent, taskIds, sectionHint, tenderContextIndex) {
  const source = String(fileContent || '');
  if (!source.trim()) return source;
  if (source.length <= TENDER_ANALYSIS_RETRIEVAL_THRESHOLD_CHARS) return source;

  const query = (taskIds || [])
    .map((id) => TASK_RETRIEVAL_HINTS[id] || '')
    .filter(Boolean)
    .join('\n');
  const result = retrieveTenderContext(tenderContextIndex || source, query, {
    maxSnippets: TENDER_ANALYSIS_MAX_SNIPPETS,
    maxChars: TENDER_ANALYSIS_BROAD_RETRIEVAL_CHARS,
  });
  const retrieved = formatTenderContextForPrompt(result);
  return retrieved
    ? '以下为关键招标解析任务共用的招标文件高相关片段。请严格基于这些片段完成各字段；片段没有的信息不要猜测。\n\n' + retrieved
    : compactPromptText(source, TENDER_ANALYSIS_BROAD_RETRIEVAL_CHARS);
}

function buildOptionalBidAnalysisBundleMessages(fileContent, taskIds, sectionHint, tenderContextIndex) {
  const context = buildTenderAnalysisBundleContext(fileContent, taskIds, sectionHint, tenderContextIndex);
  const specs = taskIds.map((taskId) => {
    const spec = OPTIONAL_BUNDLE_SCHEMAS[taskId] || { output: 'markdown' };
    if (spec.output === 'json') {
      return `"${taskId}": {${spec.fields.map((field) => `"${field}":"对应字段值"`).join(',')}}`;
    }
    return `"${taskId}":"Markdown 整理结果"`;
  }).join(',\n');
  const instructions = taskIds
    .map((taskId) => `【${taskId}】${OPTIONAL_BUNDLE_INSTRUCTIONS[taskId] || ''}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: stableSystemPrompt + '\n\n本次合并多个招标解析项。每个字段必须只基于招标文件上下文返回；没有提及的字段写“没有提及”。',
    },
    { role: 'user', content: '相关招标文件上下文：\n' + context },
    { role: 'user', content: '任务要求：\n' + instructions },
    { role: 'user', content: `只返回合法 JSON，顶层只能包含以下键，每个键都必须存在：\n{
${specs}
}` },
  ];
}

function normalizeOptionalBidAnalysisBundle(value, taskIds) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const normalized = {};
  for (const taskId of taskIds) {
    const spec = OPTIONAL_BUNDLE_SCHEMAS[taskId] || { output: 'markdown' };
    if (!(taskId in source)) {
      throw new Error(`合并招标解析结果缺少字段：${taskId}`);
    }
    if (spec.output === 'markdown') {
      const content = String(source[taskId] || '').trim();
      normalized[taskId] = content || MARKDOWN_MISSING_RESULT;
      continue;
    }
    if (!source[taskId] || typeof source[taskId] !== 'object' || Array.isArray(source[taskId])) {
      throw new Error(`合并招标解析结果 ${taskId} 必须是对象`);
    }
    const item = {};
    for (const field of spec.fields) {
      if (!(field in source[taskId])) {
        throw new Error(`合并招标解析结果 ${taskId} 缺少 ${field}`);
      }
      item[field] = String(source[taskId][field] ?? '没有提及').trim() || '没有提及';
    }
    normalized[taskId] = JSON.stringify(item);
  }
  return normalized;
}

function buildKeyBidAnalysisBundleMessages(fileContent, taskIds, sectionHint, tenderContextIndex) {
  const context = buildTenderAnalysisBundleContext(fileContent, taskIds, sectionHint, tenderContextIndex);
  return [
    {
      role: 'system',
      content: stableSystemPrompt + '\n\n本次把多个高频招标解析项合并到一次请求，必须同时返回所有字段。',
    },
    { role: 'user', content: '关键招标文件上下文：\n' + context },
    {
      role: 'user',
      content: `请一次性完成以下 5 个解析项，并只返回 JSON。不要添加其他字段。

1) projectOverview：完整提取项目基本信息、背景目的、规模预算、时间安排、实施内容和技术特点，返回简体中文 Markdown 字符串。
2) techRequirements：完整提取技术评分项、技术评分要求、分值/权重、评分标准和数据来源，返回简体中文 Markdown 字符串。
3) projectInfo：返回 JSON 对象，字段为 project_name、project_number、project_type、project_budget、project_address；没有则写“没有提及”。
4) partAInfo：返回 JSON 对象，字段为 company_name、address、contact_person、contact_phone；没有则写“没有提及”。
5) deliveryAndServiceRequirements：返回 JSON 对象，字段为 implementation_period、delivery_scope、delivery_location、acceptance_requirements、warranty_period、after_sales_service、response_time、training_requirements、documentation_requirements；没有则写“没有提及”。

返回格式：
{
  "projectOverview": "...",
  "techRequirements": "...",
  "projectInfo": {
    "project_name": "...",
    "project_number": "...",
    "project_type": "...",
    "project_budget": "...",
    "project_address": "..."
  },
  "partAInfo": {
    "company_name": "...",
    "address": "...",
    "contact_person": "...",
    "contact_phone": "..."
  },
  "deliveryAndServiceRequirements": {
    "implementation_period": "...",
    "delivery_scope": "...",
    "delivery_location": "...",
    "acceptance_requirements": "...",
    "warranty_period": "...",
    "after_sales_service": "...",
    "response_time": "...",
    "training_requirements": "...",
    "documentation_requirements": "..."
  }
}

必须覆盖全部字段；不要输出 Markdown 代码围栏。`
    },
  ];
}

function normalizeKeyBidAnalysisBundle(value) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const required = ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'];
  const missing = required.filter((key) => !(key in source));
  if (missing.length) throw new Error('合并招标解析结果缺少字段：' + missing.join('、'));
  return source;
}

function validateKeyBidAnalysisBundle(value) {
  const source = value || {};
  if (typeof source.projectOverview !== 'string' || typeof source.techRequirements !== 'string') {
    throw new Error('合并招标解析结果的 Markdown 字段格式无效');
  }
  const shape = {
    projectInfo: ['project_name','project_number','project_type','project_budget','project_address'],
    partAInfo: ['company_name','address','contact_person','contact_phone'],
    deliveryAndServiceRequirements: ['implementation_period','delivery_scope','delivery_location','acceptance_requirements','warranty_period','after_sales_service','response_time','training_requirements','documentation_requirements'],
  };
  for (const [group, fields] of Object.entries(shape)) {
    if (!source[group] || typeof source[group] !== 'object') throw new Error(`合并招标解析结果缺少 ${group}`);
    const missing = fields.filter((field) => !(field in source[group]));
    if (missing.length) throw new Error(`${group} 缺少字段：${missing.join('、')}`);
  }
}

function buildTenderAnalysisContext(fileContent, task, sectionHint, tenderContextIndex) {
  const source = String(fileContent || '');
  if (!source.trim()) return source;
  if (source.length <= TENDER_ANALYSIS_RETRIEVAL_THRESHOLD_CHARS) return source;

  const query = buildTaskRetrievalQuery(task, sectionHint);
  const maxChars = ['projectOverview', 'techRequirements'].includes(task?.id)
    ? TENDER_ANALYSIS_BROAD_RETRIEVAL_CHARS
    : TENDER_ANALYSIS_DEFAULT_RETRIEVAL_CHARS;
  const result = retrieveTenderContext(tenderContextIndex || source, query, {
    maxSnippets: TENDER_ANALYSIS_MAX_SNIPPETS,
    maxChars,
  });
  const retrieved = formatTenderContextForPrompt(result);
  if (retrieved) {
    return '以下为与“' + (task?.label || '当前解析任务') + '”最相关的招标文件原文片段。请基于这些片段完成任务；如某个字段在片段中没有出现，请填写“没有提及”，不要猜测。\n\n' + retrieved;
  }
  return compactPromptText(source, maxChars);
}

function buildTenderContextMessages(fileContent, sectionHint) {
  const messages = [
    { role: 'system', content: stableSystemPrompt },
  ];
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }
  messages.push({ role: 'user', content: `以下是完整招标文件。后续任务需要基于这份招标文件完成；如后续消息提供补充上下文，请按具体任务要求综合使用：\n\n${fileContent}` });
  return messages;
}

function buildMessages(fileContent, task, sectionHint) {
  const messages = buildTenderContextMessages(fileContent, sectionHint);
  messages.push(
    { role: 'user', content: buildTaskPrompt(task) },
  );
  return messages;
}

async function runSingleBidAnalysisPromptTask({ aiService, fileContent, task, sectionHint, logTitle, tenderContextIndex }) {
  const analysisContext = buildTenderAnalysisContext(fileContent, task, sectionHint, tenderContextIndex);
  return aiService.chat({
    messages: buildMessages(analysisContext, task, sectionHint),
    response_format: task.output === 'json' ? { type: 'json_object' } : undefined,
    logTitle: logTitle || `招标解析-${task.label}`,
  });
}

async function runBidAnalysisPromptTaskOnce({ aiService, fileContent, fileSegments, task, sectionHint, tenderContextIndex }) {
  const source = String(fileContent || '');
  if (source.length > TENDER_ANALYSIS_RETRIEVAL_THRESHOLD_CHARS && tenderContextIndex) {
    return runSingleBidAnalysisPromptTask({
      aiService,
      fileContent: source,
      task,
      sectionHint,
      tenderContextIndex,
    });
  }

  const segments = Array.isArray(fileSegments) && fileSegments.length
    ? fileSegments
    : splitUserTextByContextLimit(source, typeof aiService.getConfig === 'function' ? aiService.getConfig() : {});
  if (segments.length <= 1) {
    return runSingleBidAnalysisPromptTask({
      aiService,
      fileContent: segments[0] || source,
      task,
      sectionHint,
      tenderContextIndex,
    });
  }

  const segmentResults = await Promise.all(segments.map(async (segmentContent, index) => ({
    segmentIndex: index + 1,
    totalSegments: segments.length,
    content: await runSingleBidAnalysisPromptTask({
      aiService,
      fileContent: segmentContent,
      task,
      sectionHint,
      tenderContextIndex,
      logTitle: `招标解析-${task.label}-第${index + 1}段`,
    }),
  })));

  return mergeSegmentedAiResults({
    aiService,
    segmentResults,
    taskPrompt: buildTaskPrompt(task),
    output: task.output,
    systemPrompt: stableSystemPrompt,
    sectionHint,
    taskLabel: task.label,
    logTitle: `招标解析合并-${task.label}`,
  });
}

async function runOptionalBidAnalysisBundle({ aiService, fileContent, taskIds, sectionHint, tenderContextIndex, logTitle, batchId }) {
  const messages = buildOptionalBidAnalysisBundleMessages(fileContent, taskIds, sectionHint, tenderContextIndex);
  const result = await aiService.collectJsonResponse({
    messages,
    logTitle: logTitle || `招标解析合并-${batchId}`,
    stage: 'tender-analysis',
    batchId,
    progressLabel: '招标解析合并',
    failureMessage: '模型返回的合并招标解析结果格式无效',
    normalizer: (value) => normalizeOptionalBidAnalysisBundle(value, taskIds),
    validator: (value) => {
      if (!value || typeof value !== 'object') throw new Error('合并招标解析结果为空');
      taskIds.forEach((taskId) => {
        if (!(taskId in value)) throw new Error(`合并结果缺少 ${taskId}`);
      });
    },
    max_retries: 1,
  });
  return result;
}

async function runKeyBidAnalysisBundle({ aiService, fileContent, sectionHint, tenderContextIndex, logTitle }) {
  const messages = buildKeyBidAnalysisBundleMessages(
    fileContent,
    ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'],
    sectionHint,
    tenderContextIndex,
  );
  return aiService.collectJsonResponse({
    messages,
    logTitle: logTitle || '招标关键解析合并',
    stage: 'tender-analysis',
    batchId: 'tender-key-bundle',
    progressLabel: '招标关键解析合并',
    failureMessage: '模型返回的合并招标解析结果格式无效',
    normalizer: normalizeKeyBidAnalysisBundle,
    validator: validateKeyBidAnalysisBundle,
    max_retries: 1,
  });
}

// Markdown 整项无结果时完整重跑一次，第二次结果原样交给上层保存。
async function runBidAnalysisPromptTask(options) {
  const content = await runBidAnalysisPromptTaskOnce(options);
  if (!isMissingMarkdownResult(options.task, content)) return content;
  const taskId = options.task?.id || '';
  const retrievalHint = TASK_RETRIEVAL_HINTS[taskId] || '';
  if (retrievalHint && options.tenderContextIndex) {
    const probe = retrieveTenderContext(options.tenderContextIndex, retrievalHint, {
      maxSnippets: 1,
      maxChars: 1200,
    });
    if (!(probe?.snippets || []).length) {
      return content;
    }
  }
  return runBidAnalysisPromptTaskOnce(options);
}

function runInvalidBidAndRejectionItemsExtraction({ aiService, fileContent, sectionHint }) {
  const task = getBidAnalysisTaskById('discardedBids');
  if (!task) {
    throw new Error('未找到无效投标与废标项解析任务');
  }

  return runBidAnalysisPromptTask({ aiService, fileContent, task, sectionHint });
}

async function runBidAnalysisTask({ aiService, workspaceStore, updateTask, checkpointTask, payload }) {
  const config = normalizeBidAnalysisConfig(payload.mode, payload.selected_task_ids || payload.selectedTaskIds);
  const mode = config.mode;
  const selectedTaskIdSet = new Set(config.taskIds);
  const selectedTasks = tasks.filter((task) => selectedTaskIdSet.has(task.id));
  const fileContent = workspaceStore.readTenderMarkdown();
  if (!String(fileContent || '').trim()) {
    throw new Error('请先上传招标文件，再开始解析');
  }
  const storedPlanForHint = workspaceStore.loadTechnicalPlan() || {};
  if (storedPlanForHint.bidSectionMode === 'multiple') {
    if (storedPlanForHint.bidSectionExtractionStatus !== 'success' || !Array.isArray(storedPlanForHint.bidSections) || storedPlanForHint.bidSections.length < 2) {
      throw new Error('请先完成多标段识别，再开始解析招标文件');
    }
    if (!storedPlanForHint.tenderFile?.selectedSectionId || !storedPlanForHint.tenderFile?.selectedSectionTitle) {
      throw new Error('请先选择本次投标范围，再开始解析招标文件');
    }
    const selectedExists = storedPlanForHint.bidSections.some((section) => section.id === storedPlanForHint.tenderFile.selectedSectionId);
    if (!selectedExists) {
      throw new Error('当前投标范围已失效，请重新选择标段');
    }
  }
  const selectedSectionId = storedPlanForHint.tenderFile?.selectedSectionId;
  const selectedSection = selectedSectionId && Array.isArray(storedPlanForHint.bidSections)
    ? storedPlanForHint.bidSections.find((section) => section.id === selectedSectionId)
    : null;
  const sectionHint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlanForHint.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });
  const currentConfig = typeof aiService.getConfig === 'function' ? aiService.getConfig() : {};
  const fileSegments = splitUserTextByContextLimit(fileContent, currentConfig);
  const tenderContextIndex = createTenderContextIndex(fileContent);
  const forceRerun = payload.force_rerun === true || payload.forceRerun === true;
  const requestedTaskIds = Array.isArray(payload.task_ids)
    ? new Set(payload.task_ids.filter((taskId) => typeof taskId === 'string'))
    : null;
  const scopedTasks = requestedTaskIds
    ? selectedTasks.filter((task) => requestedTaskIds.has(task.id))
    : selectedTasks;
  if (requestedTaskIds && scopedTasks.length === 0) {
    throw new Error('未找到可重新解析的招标文件解析项');
  }
  function doneProgress(nextTasks) {
    const done = selectedTasks.filter((task) => ['success', 'error'].includes(nextTasks[task.id]?.status)).length;
    return Math.round((done / selectedTasks.length) * 100);
  }

  function getMissingRequiredTasks(nextTasks) {
    return tasks.filter((task) => task.required && !(nextTasks[task.id]?.status === 'success' && String(nextTasks[task.id]?.content || '').trim()));
  }

  const initialMessage = requestedTaskIds
    ? '开始重新解析选中的招标文件解析项。'
    : forceRerun
      ? '开始重新解析全部招标文件解析项。'
      : '开始解析招标文件。';
  const initialLogs = [initialMessage];
  let initialPartial = { bidAnalysisMode: mode, bidAnalysisSelectedTaskIds: config.taskIds };
  let initialEventPatch;
  let currentTasks = { ...(storedPlanForHint.bidAnalysisTasks || {}) };
  if (forceRerun && !requestedTaskIds) {
    const resetTasks = {};
    for (const task of selectedTasks) {
      const resetTask = { id: task.id, label: task.label, status: 'idle', content: '' };
      currentTasks[task.id] = resetTask;
      resetTasks[task.id] = resetTask;
    }
    initialPartial = {
      ...initialPartial,
      bidAnalysisTasks: resetTasks,
      bidAnalysisProgress: 0,
      outlineGenerationTask: undefined,
      globalFactsTask: undefined,
      globalFactsAdjustmentTask: undefined,
      globalFacts: [],
      contentGenerationTask: undefined,
      contentGenerationOptions: undefined,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentGenerationRuntime: undefined,
      outlineData: null,
    };
    initialEventPatch = {
      technicalPlanPatch: {
        projectOverview: '',
        techRequirements: '',
      },
    };
  }
  checkpointTask(
    { status: 'running', progress: 0, logs: initialLogs },
    initialPartial,
    initialEventPatch,
  );
  const tasksToRun = requestedTaskIds || forceRerun ? scopedTasks : scopedTasks.filter((task) => currentTasks[task.id]?.status !== 'success');

  function checkpointBidItem(taskPartial, item, progress, technicalPlanPatch = {}) {
    checkpointTask(
      taskPartial,
      { bidAnalysisItem: item, bidAnalysisProgress: progress },
      { bidItem: item, technicalPlanPatch },
    );
  }

  async function runKeyTasksBundle(taskGroup) {
    if (!taskGroup.length) return true;
    const taskIds = new Set(taskGroup.map((task) => task.id));
    taskGroup.forEach((task) => {
      const runningItem = { id: task.id, label: task.label, status: 'running', content: '' };
      currentTasks = { ...currentTasks, [task.id]: runningItem };
    });
    checkpointTask(
      { status: 'running', progress: doneProgress(currentTasks), logs: ['开始合并解析高频招标基础信息。'] },
      { bidAnalysisTasks: currentTasks, bidAnalysisProgress: doneProgress(currentTasks) },
    );

    try {
      const result = await runKeyBidAnalysisBundle({
        aiService,
        fileContent,
        sectionHint,
        tenderContextIndex,
        logTitle: '招标关键解析合并',
      });
      const groups = {
        projectOverview: result.projectOverview,
        techRequirements: result.techRequirements,
        projectInfo: JSON.stringify(result.projectInfo),
        partAInfo: JSON.stringify(result.partAInfo),
        deliveryAndServiceRequirements: JSON.stringify(result.deliveryAndServiceRequirements),
      };
      for (const task of taskGroup) {
        const completedItem = {
          id: task.id,
          label: task.label,
          status: 'success',
          content: String(groups[task.id] || '').trim(),
        };
        if (!completedItem.content) throw new Error(`合并解析项 ${task.label} 返回为空`);
        currentTasks = { ...currentTasks, [task.id]: completedItem };
      }
      checkpointBidItem(
        { status: 'running', progress: doneProgress(currentTasks) },
        currentTasks.projectOverview,
        doneProgress(currentTasks),
        {
          ...(currentTasks.projectOverview?.content ? { projectOverview: currentTasks.projectOverview.content } : {}),
          ...(currentTasks.techRequirements?.content ? { techRequirements: currentTasks.techRequirements.content } : {}),
        },
      );
      return true;
    } catch (error) {
      taskGroup.forEach((task) => handleTaskError(task, error));
      return false;
    }
  }

  async function runOne(task) {
    const runningItem = { id: task.id, label: task.label, status: 'running', content: '' };
    currentTasks = { ...currentTasks, [task.id]: runningItem };
    const runningProgress = doneProgress(currentTasks);
    checkpointBidItem(
      { status: 'running', progress: runningProgress },
      runningItem,
      runningProgress,
    );

    const content = await runBidAnalysisPromptTask({
      aiService,
      fileContent,
      fileSegments,
      task,
      sectionHint,
      tenderContextIndex,
    });
    const trimmedContent = String(content || '').trim();
    if (!trimmedContent) {
      throw new Error(`${task.label}解析结果为空，请重新解析`);
    }

    const completedItem = { id: task.id, label: task.label, status: 'success', content: trimmedContent };
    currentTasks = { ...currentTasks, [task.id]: completedItem };
    const progress = doneProgress(currentTasks);
    const technicalPlanPatch = {};
    if (task.id === 'projectOverview') technicalPlanPatch.projectOverview = trimmedContent;
    if (task.id === 'techRequirements') technicalPlanPatch.techRequirements = trimmedContent;
    checkpointBidItem(
      { status: 'running', progress },
      completedItem,
      progress,
      technicalPlanPatch,
    );
  }

  function handleTaskError(task, error) {
    const failedItem = { id: task.id, label: task.label, status: 'error', content: currentTasks[task.id]?.content || '', error: error.message || '解析失败' };
    currentTasks = { ...currentTasks, [task.id]: failedItem };
    const progress = doneProgress(currentTasks);
    checkpointBidItem(
      { status: 'running', progress, logs: [`${task.label}解析失败：${error.message || '未知错误'}`] },
      failedItem,
      progress,
    );
  }

  async function runOneSafely(task) {
    try {
      await runOne(task);
      return true;
    } catch (error) {
      handleTaskError(task, error);
      return false;
    }
  }

  async function runOptionalBundleGroup(bundleId, taskGroup) {
    if (!taskGroup.length) return true;
    taskGroup.forEach((task) => {
      const runningItem = { id: task.id, label: task.label, status: 'running', content: '' };
      currentTasks = { ...currentTasks, [task.id]: runningItem };
    });
    checkpointTask(
      { status: 'running', progress: doneProgress(currentTasks), logs: [`开始合并招标解析：${bundleId}` ] },
      { bidAnalysisTasks: currentTasks, bidAnalysisProgress: doneProgress(currentTasks) },
    );
    try {
      const taskIds = taskGroup.map((task) => task.id);
      const result = await runOptionalBidAnalysisBundle({
        aiService,
        fileContent,
        taskIds,
        sectionHint,
        tenderContextIndex,
        batchId: `tender-${bundleId}`,
        logTitle: `招标解析合并-${bundleId}`,
      });
      for (const task of taskGroup) {
        const completedItem = {
          id: task.id,
          label: task.label,
          status: 'success',
          content: String(result[task.id] || MARKDOWN_MISSING_RESULT).trim(),
        };
        currentTasks = { ...currentTasks, [task.id]: completedItem };
      }
      checkpointBidItem(
        { status: 'running', progress: doneProgress(currentTasks) },
        currentTasks[taskGroup[taskGroup.length - 1].id],
        doneProgress(currentTasks),
      );
      return true;
    } catch (error) {
      taskGroup.forEach((task) => handleTaskError(task, error));
      return false;
    }
  }

  const requiredTaskIds = new Set(['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements']);
  const keyBundleTasks = tasksToRun.filter((task) => requiredTaskIds.has(task.id));
  const remainingTasks = tasksToRun.filter((task) => !requiredTaskIds.has(task.id));
  if (keyBundleTasks.length === requiredTaskIds.size) {
    await runKeyTasksBundle(keyBundleTasks);
  } else if (keyBundleTasks.length) {
    await Promise.all(keyBundleTasks.map(runOneSafely));
  }

  const remainingSet = new Set(remainingTasks.map((task) => task.id));
  const bundledTaskIds = new Set();
  for (const [bundleId, bundleIds] of OPTIONAL_BID_ANALYSIS_BUNDLES) {
    const group = remainingTasks.filter((task) => bundleIds.includes(task.id));
    if (group.length === bundleIds.length) {
      group.forEach((task) => bundledTaskIds.add(task.id));
      await runOptionalBundleGroup(bundleId, group);
    }
  }

  const residualTasks = remainingTasks.filter((task) => !bundledTaskIds.has(task.id));
  await Promise.all(residualTasks.map(runOneSafely));

  const missingRequiredTasks = getMissingRequiredTasks(currentTasks);
  if (missingRequiredTasks.length) {
    const missingLabels = missingRequiredTasks.map((task) => task.label).join('、');
    const message = `必填解析项未完成：${missingLabels}，请重新解析失败项。`;
    checkpointTask({ status: 'error', progress: 100, error: message, logs: [message] });
    return;
  }

  checkpointTask({ status: 'success', progress: 100, error: undefined, logs: ['招标文件解析完成。'] });
}

module.exports = {
  buildInvalidBidAndRejectionItemsPrompt,
  buildTenderContextMessages,
  getBidAnalysisTaskById,
  getBidAnalysisTasks,
  runInvalidBidAndRejectionItemsExtraction,
  runBidAnalysisTask,
  runBidAnalysisPromptTask,
  runSingleBidAnalysisPromptTask,
};
