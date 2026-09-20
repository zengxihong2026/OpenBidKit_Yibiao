const { retrieveTenderContext, formatTenderContextForPrompt } = require('./tenderContextRetriever.cjs');

const KNOWLEDGE_VERSION = 1;

const CATEGORY_QUERIES = {
  scope: '项目概况 项目范围 建设内容 实施内容 工作内容 服务内容 项目目标',
  scoring: '技术评分 评分标准 技术评分项 评分细则 评审因素 评标办法 技术参数',
  compliance: '否决投标 无效投标 废标 资格审查 符合性检查 实质性响应 重大偏差',
  qualification: '资格条件 资质 资格审查 投标人要求 项目经理 技术负责人 业绩 人员',
  response: '投标文件 响应文件 文件组成 格式 签字 盖章 偏离表 承诺函 附件 递交',
  delivery: '交付 工期 实施周期 交付期限 实施地点 验收 质保 售后 响应时间 培训',
  contract: '合同 合同签订 履约保证金 付款 违约 合同解除 争议解决 服务期限',
  technical: '技术参数 规格型号 数量 性能 指标 设备 系统 功能 技术要求 标准 规范',
};

function compactText(value, maxChars) {
  const text = String(value || '').trim();
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!text || !limit || text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit * 0.72));
  const tail = Math.max(1, limit - head);
  return `${text.slice(0, head)}
…（招标知识已压缩）…
${text.slice(-tail)}`;
}

function buildBidAnalysisFactIndex(bidAnalysisTasks = {}) {
  const mapping = [
    ['projectInfo', 'scope'],
    ['deliveryAndServiceRequirements', 'delivery'],
    ['qualificationReview', 'qualification'],
    ['complianceCheck', 'compliance'],
    ['responseFileRequirements', 'response'],
    ['evaluationBid', 'scoring'],
    ['businessScoring', 'scoring'],
    ['discardedBids', 'compliance'],
    ['signingProcess', 'contract'],
    ['terminationCondition', 'contract'],
    ['procurementList', 'technical'],
    ['keyInfo', 'delivery'],
    ['marginInfo', 'compliance'],
  ];
  const result = Object.fromEntries(Object.keys(CATEGORY_QUERIES).map((key) => [key, []]));
  for (const [taskId, category] of mapping) {
    const task = bidAnalysisTasks?.[taskId];
    const content = task?.status === 'success' ? String(task.content || '').trim() : '';
    if (!content) continue;
    result[category].push({
      source: taskId,
      content: compactText(content, 1800),
    });
  }
  return result;
}

function buildTenderKnowledgeSnapshot({
  tenderContextIndex,
  tenderMarkdown = '',
  bidAnalysisTasks = {},
  projectOverview = '',
  maxCategoryChars = 1800,
} = {}) {
  const categories = {};
  const bidFacts = buildBidAnalysisFactIndex(bidAnalysisTasks);

  for (const [category, query] of Object.entries(CATEGORY_QUERIES)) {
    const factBlocks = (bidFacts[category] || [])
      .map((item) => `[${item.source}]\n${item.content}`)
      .join('\n\n');

    let tenderBlocks = '';
    if (tenderContextIndex || String(tenderMarkdown || '').trim()) {
      const retrieved = retrieveTenderContext(tenderContextIndex || tenderMarkdown, query, {
        maxSnippets: 3,
        maxChars: maxCategoryChars,
      });
      tenderBlocks = formatTenderContextForPrompt(retrieved);
    }

    const merged = [
      factBlocks ? `已有解析结果：\n${factBlocks}` : '',
      tenderBlocks ? `招标原文依据：\n${tenderBlocks}` : '',
    ].filter(Boolean).join('\n\n');

    categories[category] = compactText(merged, maxCategoryChars);
  }

  categories.scope = [
    categories.scope,
    projectOverview ? `项目概述：\n${compactText(projectOverview, 1800)}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    version: KNOWLEDGE_VERSION,
    source_hash: tenderContextIndex?.source_hash || '',
    categories,
  };
}

function formatTenderKnowledgeForPrompt(snapshot, maxChars = 6500) {
  const source = snapshot?.categories || {};
  const labels = {
    scope: '项目范围与目标',
    scoring: '评分与技术要求',
    compliance: '合规、否决与符合性',
    qualification: '资格与人员要求',
    response: '响应文件要求',
    delivery: '交付、验收与服务',
    contract: '合同与履约',
    technical: '技术参数与标准',
  };
  const blocks = [];
  for (const [key, label] of Object.entries(labels)) {
    const content = String(source[key] || '').trim();
    if (content) blocks.push(`## ${label}\n${content}`);
  }
  return compactText(blocks.join('\n\n'), maxChars);
}

module.exports = {
  KNOWLEDGE_VERSION,
  CATEGORY_QUERIES,
  buildTenderKnowledgeSnapshot,
  formatTenderKnowledgeForPrompt,
};