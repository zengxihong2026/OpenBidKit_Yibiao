const CJK_TOKEN_RE = /[\u4e00-\u9fff]{2,}/g;
const WORD_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]{1,}/g;

function normalize(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function extractKeywords(text) {
  const source = normalize(text).toLowerCase();
  const cjkRuns = source.match(CJK_TOKEN_RE) || [];
  const chineseNgrams = [];
  const stopwords = new Set(['项目', '方案', '内容', '要求', '工作', '进行', '相关', '本章', '当前', '以及', '以及其']);
  for (const run of cjkRuns) {
    const length = run.length;
    for (let size = 2; size <= Math.min(4, length); size += 1) {
      for (let index = 0; index + size <= length; index += 1) {
        const token = run.slice(index, index + size);
        if (!stopwords.has(token)) chineseNgrams.push(token);
      }
    }
  }
  const words = source.match(WORD_TOKEN_RE) || [];
  const tokens = [...chineseNgrams, ...words]
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function splitTenderUnits(markdown) {
  const source = normalize(markdown);
  if (!source) return [];
  const lines = source.split('\n');
  const units = [];
  let headingPath = [];
  let buffer = [];

  function flush() {
    const text = buffer.join('\n').trim();
    if (!text) return;
    const compact = text.length > 3000 ? `${text.slice(0, 2600)}\n…（原文段落已截断）` : text;
    units.push({ headingPath: [...headingPath], text: compact, normalized: compact.toLowerCase() });
    buffer = [];
  }

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      const level = match[1].length;
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = match[2].trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (units.length) return units;
  return source.split(/\n{2,}/).map((text) => normalize(text)).filter(Boolean).map((text) => ({
    headingPath: [],
    text: text.length > 3000 ? `${text.slice(0, 3000)}\n…（原文段落已截断）` : text,
    normalized: text.toLowerCase(),
  }));
}

function scoreUnit(unit, keywords) {
  if (!keywords.length) return 0;
  const heading = unit.headingPath.join(' > ').toLowerCase();
  const haystack = `${heading}\n${unit.normalized}`;
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    const contentHits = haystack.split(keyword).length - 1;
    if (contentHits > 0) score += Math.min(8, contentHits * 2);
    if (heading.includes(keyword)) score += 8;
  }
  if (/(评分|废标|否决|资格|参数|指标|工期|验收|质保|服务|安全|应急|合同)/.test(haystack)) score += 1;
  return score;
}

function createTenderContextIndex(markdown) {
  const source = normalize(markdown);
  return {
    source_hash: source.length
      ? require('node:crypto').createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16)
      : '',
    source_chars: source.length,
    units: splitTenderUnits(source),
  };
}

function retrieveTenderContext(markdownOrIndex, query, options = {}) {
  const index = markdownOrIndex && typeof markdownOrIndex === 'object' && Array.isArray(markdownOrIndex.units)
    ? markdownOrIndex
    : createTenderContextIndex(markdownOrIndex);
  const units = index.units || [];
  if (!units.length) return { query: normalize(query), snippets: [], total_chars: 0 };
  const maxSnippets = Math.max(1, Number(options.maxSnippets) || 4);
  const maxChars = Math.max(500, Number(options.maxChars) || 6000);
  const keywords = extractKeywords(query);
  const ranked = units.map((unit, index) => ({ unit, index, score: scoreUnit(unit, keywords) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let totalChars = 0;
  const seen = new Set();
  for (const entry of ranked) {
    if (entry.score <= 0 && selected.length) break;
    const key = entry.unit.text.slice(0, 120);
    if (seen.has(key)) continue;
    if (totalChars + entry.unit.text.length > maxChars && selected.length) continue;
    seen.add(key);
    selected.push({ score: entry.score, heading_path: entry.unit.headingPath, text: entry.unit.text });
    totalChars += entry.unit.text.length;
    if (selected.length >= maxSnippets || totalChars >= maxChars) break;
  }
  if (!selected.length) {
    const fallback = units[0];
    if (fallback) {
      const fallbackText = fallback.text.length > Math.min(2000, maxChars)
        ? fallback.text.slice(0, Math.min(2000, maxChars))
        : fallback.text;
      selected.push({ score: 0, heading_path: fallback.headingPath, text: fallbackText });
      totalChars += fallbackText.length;
    }
  }
  return { query: normalize(query), keywords, snippets: selected, total_chars: totalChars };
}

function formatTenderContextForPrompt(result) {
  const snippets = result?.snippets || [];
  if (!snippets.length) return '';
  return snippets.map((snippet, index) => {
    const path = snippet.heading_path?.length ? snippet.heading_path.join(' > ') : '未识别章节';
    return `<tender_snippet id="T${index + 1}" heading="${path}">\n${snippet.text}\n</tender_snippet>`;
  }).join('\n\n');
}

module.exports = {
  extractKeywords,
  splitTenderUnits,
  createTenderContextIndex,
  retrieveTenderContext,
  formatTenderContextForPrompt,
};