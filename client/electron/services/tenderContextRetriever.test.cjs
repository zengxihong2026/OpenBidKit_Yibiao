const assert = require('node:assert/strict');
const { extractKeywords, retrieveTenderContext, formatTenderContextForPrompt } = require('./tenderContextRetriever.cjs');

const text = [
  '# 第一章 项目概况',
  '本项目工期为120日历天，要求按期完成并通过验收。',
  '',
  '# 第二章 质量保证',
  '建立质量控制体系，明确验收标准和质保服务。',
  '',
  '# 第三章 安全管理',
  '制定应急预案，明确安全责任和风险控制措施。',
].join('\n');

const keywords = extractKeywords('工期 验收 项目周期');
assert.ok(keywords.includes('工期'));
const semanticResult = retrieveTenderContext(text, '施工组织设计与工期安排', { maxSnippets: 2, maxChars: 1200 });
assert.ok(semanticResult.snippets.length >= 1);

const result = retrieveTenderContext(text, '工期 验收', { maxSnippets: 2, maxChars: 1200 });
assert.ok(result.snippets.length >= 1);
assert.ok(result.snippets[0].text.includes('120日历天'));
assert.ok(result.total_chars <= 1200);

const prompt = formatTenderContextForPrompt(result);
assert.ok(prompt.includes('<tender_snippet'));
console.log('tenderContextRetriever tests passed');