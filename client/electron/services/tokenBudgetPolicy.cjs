const DEFAULT_STAGE_OUTPUT_TOKEN_LIMITS = Object.freeze({
  'tender-analysis': 12000,
  'outline-generation': 9000,
  'global-facts': 9000,
  'content-planning': 7000,
  'content-generation': 16000,
  consistency: 6000,
  'original-restore': 6000,
  'original-coverage': 6000,
  'json-repair': 5000,
  'word-adjustment': 6000,
  'table-cleanup': 6000,
  illustration: 12000,
});

const DEFAULT_AGENT_READ_BUDGETS = Object.freeze({
  'tender-analysis': { max_total_chars: 24000, max_file_chars: 8000, max_files: 8 },
  'outline-generation': { max_total_chars: 22000, max_file_chars: 9000, max_files: 8 },
  'global-facts': { max_total_chars: 26000, max_file_chars: 10000, max_files: 10 },
  'content-generation': { max_total_chars: 18000, max_file_chars: 7000, max_files: 8 },
  consistency: { max_total_chars: 20000, max_file_chars: 7000, max_files: 8 },
  'original-restore': { max_total_chars: 22000, max_file_chars: 8000, max_files: 10 },
  'original-coverage': { max_total_chars: 18000, max_file_chars: 7000, max_files: 8 },
  illustration: { max_total_chars: 12000, max_file_chars: 6000, max_files: 6 },
});

const DEFAULT_TOKEN_PROFILE = 'balanced';

function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  return ['economy', 'balanced', 'quality'].includes(profile) ? profile : DEFAULT_TOKEN_PROFILE;
}

function scaleLimit(value, profile) {
  const base = Number(value) || 0;
  if (!base) return 0;
  if (profile === 'economy') return Math.max(256, Math.floor(base * 0.75));
  if (profile === 'quality') return Math.floor(base * 1.25);
  return base;
}

function getStageOutputTokenLimit(stage, config = {}) {
  const explicit = Number(config?.output_token_limit);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const profile = normalizeProfile(config?.token_optimization_profile);
  return scaleLimit(DEFAULT_STAGE_OUTPUT_TOKEN_LIMITS[String(stage || '').trim()] || 0, profile);
}

function getAgentReadBudget(stage, config = {}) {
  const profile = normalizeProfile(config?.token_optimization_profile);
  const base = DEFAULT_AGENT_READ_BUDGETS[String(stage || '').trim()] || {
    max_total_chars: 18000,
    max_file_chars: 7000,
    max_files: 8,
  };
  const ratio = profile === 'economy' ? 0.75 : profile === 'quality' ? 1.25 : 1;
  return {
    max_total_chars: Math.max(2000, Math.floor(base.max_total_chars * ratio)),
    max_file_chars: Math.max(1000, Math.floor(base.max_file_chars * ratio)),
    max_files: Math.max(1, Math.floor(base.max_files * (profile === 'economy' ? 0.8 : profile === 'quality' ? 1.2 : 1))),
  };
}

module.exports = {
  DEFAULT_STAGE_OUTPUT_TOKEN_LIMITS,
  DEFAULT_AGENT_READ_BUDGETS,
  DEFAULT_TOKEN_PROFILE,
  normalizeProfile,
  getStageOutputTokenLimit,
  getAgentReadBudget,
};
