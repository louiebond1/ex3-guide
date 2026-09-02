#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const found = args.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const baseUrl = getArg('base-url', process.env.EVAL_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const judgeMode = getArg('judge', 'rules');
const evalPath = path.join(__dirname, '..', 'evals', 'smartrecruiters-ai-evals.json');
const suite = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function gradeRules(testCase, answer) {
  const rules = testCase.rules || {};
  const failures = [];
  const normAnswer = normalize(answer);

  for (const term of rules.required || []) {
    if (!normAnswer.includes(normalize(term))) {
      failures.push(`missing "${term}"`);
    }
  }

  for (const term of rules.banned || []) {
    if (normAnswer.includes(normalize(term))) {
      failures.push(`banned "${term}"`);
    }
  }

  if (rules.maxWords && wordCount(answer) > rules.maxWords) {
    failures.push(`too long (${wordCount(answer)} words > ${rules.maxWords})`);
  }

  if (rules.noSourceMarkers && /【[^】]*】|ã€[^ã€‘]*ã€‘|Ã£â‚¬Â[^Ã£â‚¬â€˜]*Ã£â‚¬â€˜/.test(String(answer || ''))) {
    failures.push('source marker leaked');
  }

  return {
    pass: failures.length === 0,
    reason: failures.length ? failures.join('; ') : 'rules passed',
  };
}

async function askAssistant(testCase) {
  const res = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: testCase.question,
      context: testCase.context || null,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function gradeWithAI(testCase, answer) {
  if (!process.env.OPENAI_API_KEY) {
    return { pass: false, score: 0, reason: 'OPENAI_API_KEY missing for AI judge' };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_EVAL_MODEL || process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = [
    'Grade this SmartRecruiters assistant answer.',
    'Return only JSON: {"pass":boolean,"score":0-5,"reason":"short reason"}.',
    'Criteria: correctness, groundedness, concision, actionability, and staying in scope.',
    '',
    `Question: ${testCase.question}`,
    `Context: ${JSON.stringify(testCase.context || {})}`,
    `Answer: ${answer}`,
  ].join('\n');

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = completion.choices[0]?.message?.content || '';
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    const parsed = JSON.parse(jsonText);
    return {
      pass: Boolean(parsed.pass) && Number(parsed.score || 0) >= 3.5,
      score: Number(parsed.score || 0),
      reason: String(parsed.reason || '').slice(0, 240),
    };
  } catch {
    return { pass: false, score: 0, reason: `AI judge returned non-JSON: ${raw.slice(0, 160)}` };
  }
}

async function main() {
  const cases = suite.cases || [];
  console.log(`Running ${cases.length} evals against ${baseUrl} (judge=${judgeMode})`);

  const results = [];
  for (const testCase of cases) {
    const result = { id: testCase.id, pass: false, rule: null, ai: null, answer: '' };
    try {
      const response = await askAssistant(testCase);
      result.answer = response.answer || '';
      result.rule = gradeRules(testCase, result.answer);
      result.pass = result.rule.pass;

      if (judgeMode === 'ai') {
        result.ai = await gradeWithAI(testCase, result.answer);
        result.pass = result.pass && result.ai.pass;
      }
    } catch (err) {
      result.rule = { pass: false, reason: err.message };
      result.pass = false;
    }
    results.push(result);

    const status = result.pass ? 'PASS' : 'FAIL';
    const ruleReason = result.rule ? result.rule.reason : 'no rule grade';
    const aiReason = result.ai ? ` | ai ${result.ai.score}/5: ${result.ai.reason}` : '';
    console.log(`${status} ${result.id} - ${ruleReason}${aiReason}`);
  }

  const failures = results.filter(r => !r.pass);
  console.log(`\n${results.length - failures.length}/${results.length} passed`);

  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Eval runner failed:', err.message);
  process.exit(1);
});
