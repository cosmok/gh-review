// Import required modules
require('dotenv').config();
const { Probot } = require('probot');
const { Octokit } = require('@octokit/rest');
const { createClient } = require('./llm');
const pLimit = require("p-limit").default || require("p-limit");
const { createTwoFilesPatch } = require('diff');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { structuredLog } = require('./logger');
const {
  countTokens,
  truncateToLines,
  removeLeadingMarkdownHeading,
  linkLineNumbers,
  diffAnchor,
  getSurroundingLines,
  shouldPostInlineComment,
} = require('./utils');

function loadPrompt(filename, values = {}) {
  const fullPath = path.join(__dirname, 'prompts', filename);
  let template = fs.readFileSync(fullPath, 'utf8');
  for (const [key, val] of Object.entries(values)) {
    const regex = new RegExp(`{{\s*${key}\s*}}`, 'g');
    template = template.replace(regex, val);
  }
  return template;
}

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '100000', 10);
const MAX_DIFF_LENGTH = parseInt(process.env.MAX_DIFF_LENGTH || '8000', 10);
const MAX_DIFF_LINES = parseInt(process.env.MAX_DIFF_LINES || '500', 10);
const MAX_CONTEXT_LINES = parseInt(process.env.MAX_CONTEXT_LINES || '200', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '3', 10);
const MAX_FILES_TO_PROCESS = parseInt(process.env.MAX_FILES_TO_PROCESS || '20', 10);
const INSTRUCTION_FILENAME = process.env.INSTRUCTION_FILENAME || 'AI_REVIEW_INSTRUCTIONS.md';
const ENABLE_REPO_INSTRUCTIONS = (process.env.ENABLE_REPO_INSTRUCTIONS  &&  process.env.ENABLE_REPO_INSTRUCTIONS == 'true') ? true : false;
// Label that triggers an AI review when added to a PR
const TRIGGER_LABEL = process.env.TRIGGER_LABEL || 'ai-review';

// Verify required environment variables (This will run when module is loaded)
const requiredVars = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    structuredLog('ERROR', 'Missing required environment variable', { varName });
    process.exit(1); // Exit if env vars are missing
  }
}

// Initialize rate limiter
const limit = pLimit(CONCURRENCY_LIMIT);

// Initialize the LLM client based on configuration (Google, OpenAI, Anthropic)
let llmClient;
try {
  llmClient = createClient();
} catch (e) {
  structuredLog('ERROR', 'Failed to initialize LLM client', { error: e.message, stack: e.stack });
}

// --- Helper functions (analyzeWithAI, truncateToLines, etc.) remain in module scope ---
async function analyzeWithAI(prompt, codeSnippet, filePath, context = '', logContext = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const startTime = Date.now();
  try {
    const truncatedSnippet = truncateToLines(codeSnippet, MAX_DIFF_LINES);
    const truncatedContext = context ? truncateToLines(context, MAX_CONTEXT_LINES) : '';
    const message = `# Code Review Task: ${filePath}\n\n## Context\n${truncatedContext || 'No additional context provided.'}\n\n## Changes\n\`\`\`diff\n${truncatedSnippet}\n\`\`\`\n\n## Instructions\n${prompt}\n\n## Guidelines\n- Be specific and reference line numbers from the diff\n- Only report issues you're certain about\n- Suggest concrete improvements when possible`;
    const inputChars = message.length;
    const inputTokens = countTokens(message);
    structuredLog('INFO', 'LLM request started', { filePath, inputChars, inputTokens, repo: logContext.repo, pr: logContext.pr, model: llmClient?.model });
    const resultText = await llmClient.generate(message, { logContext });
    const durationMs = Date.now() - startTime;
    const outputChars = resultText ? resultText.length : 0;
    const outputTokens = countTokens(resultText);
    logContext.totalTokens = (logContext.totalTokens || 0) + inputTokens + outputTokens;
    structuredLog('INFO', 'LLM response received', { filePath, outputChars, outputTokens, repo: logContext.repo, pr: logContext.pr, model: llmClient?.model, durationMs });
    if (!resultText) {
      structuredLog('WARN', 'LLM returned empty response', { filePath, pr: logContext.pr, durationMs });
    }
    clearTimeout(timeoutId);
    return resultText;
  } catch (error) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    if (error.name === 'AbortError') {
      const msg = 'Analysis timed out. The diff might be too large or the service might be busy.';
      structuredLog('WARN', 'AI analysis timed out', { filePath, pr: logContext.pr, durationMs });
      throw new Error(msg);
    }
    let message = error.message || 'Unknown error';
    if (message.includes('Unexpected token') && message.includes('<')) {
      message = 'LLM service returned an invalid response. Check your credentials and network settings.';
    }
    const previewSource = error.response?.data || error.stack || '';
    const preview = typeof previewSource === 'string'
      ? previewSource.split('\n').slice(0, 3).join('\n')
      : '';

    let logMessage = 'Error in analyzeWithAI';
    const logFields = {
      filePath,
      pr: logContext.pr,
      durationMs,
      error: message,
      preview: preview || undefined,
      stack: error.stack || undefined,
    };
    if (/token/i.test(message) && /(limit|length|context)/i.test(message)) {
      logMessage = 'LLM token limit exceeded';
      logFields.maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '0', 10);
      message = 'LLM token limit exceeded. Consider increasing LLM_MAX_TOKENS or reducing the diff size.';
    }
    structuredLog('ERROR', logMessage, logFields);
    throw new Error(message);
  }
}

async function mergeSimilarLineAnalyses(lineAnalyses, fileName, managerPlan, analyzeWithAIDep, logContext = {}) {
  if (!lineAnalyses || lineAnalyses.length === 0) return [];
  if (lineAnalyses.length === 1) return lineAnalyses.map(l => ({ lines: [l.line], comment: l.comment }));
  const prompt = loadPrompt('merge_line_comments.md', { fileName });
  const input = lineAnalyses.map(l => `Line ${l.line}: ${l.comment}`).join('\n');
  let response;
  try {
    response = await analyzeWithAIDep(prompt, input, fileName, managerPlan, logContext);
  } catch (e) {
    structuredLog('ERROR', 'Failed to merge line analyses', { file: fileName, error: e.message });
    return lineAnalyses.map(l => ({ lines: [l.line], comment: l.comment }));
  }
  try {
    const sections = String(response)
      .split(/\nEND_COMMENT\s*(?:\n|$)/i)
      .map(s => s.trim())
      .filter(Boolean);
    const merged = [];
    for (const section of sections) {
      const match = section.match(/LINES\s*:\s*([0-9,\s]+)[\r\n]+COMMENT\s*:\s*([\s\S]*)/i);
      if (match) {
        const lines = match[1]
          .split(/[,\s]+/)
          .map(n => parseInt(n, 10))
          .filter(n => !isNaN(n));
        const comment = match[2].trim();
        if (lines.length > 0 && comment) merged.push({ lines, comment });
      }
    }
    if (merged.length > 0) return merged;
  } catch (e) {
    structuredLog('ERROR', 'Failed to parse merged line comments', { file: fileName, error: e.message });
  }
  return lineAnalyses.map(l => ({ lines: [l.line], comment: l.comment }));
}

async function getFileContent(octokit, owner, repo, path, ref, options = {}) {
  const { startLine, endLine, contextLines } = options;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    const fileSize = typeof data === 'string' ? Buffer.byteLength(data) : data.size;
    if (fileSize > MAX_FILE_SIZE) {
      structuredLog('INFO', 'Truncating large file', { path, fileSize });
      let content = typeof data === 'string'
        ? data
        : Buffer.from(data.content, data.encoding || 'base64').toString('utf-8');
      return content.substring(0, MAX_FILE_SIZE) + '\n[...truncated due to size...]';
    }
    let content = typeof data === 'string'
      ? data
      : Buffer.from(data.content, data.encoding || 'base64').toString('utf-8');
    if (startLine !== undefined && endLine !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, startLine - contextLines - 1);
      const end = Math.min(lines.length, endLine + contextLines);
      content = lines.slice(start, end).join('\n');
      if (start > 0) content = '...\n' + content;
      if (end < lines.length) content += '\n...';
    }
    return content;
  } catch (error) {
    if (error.status === 404) {
      structuredLog('INFO', 'File not found', { path, ref });
    } else {
      structuredLog('ERROR', 'Error getting file content', { path, error: error.message, stack: error.stack });
    }
    return error.status === 404 ? '[File not found or deleted]' : `[Error retrieving file: ${error.message}]`;
  }
}

async function getCommitMessages(octokit, owner, repo, prNumber) {
  try {
    const { data } = await octokit.pulls.listCommits({ owner, repo, pull_number: prNumber });
    return data.map(c => `- ${c.commit.message.split('\n')[0]}`).join('\n');
  } catch (error) {
    structuredLog('ERROR', 'Error getting commit messages', { error: error.message, stack: error.stack });
    return '';
  }
}

async function getRepoInstructions(octokit, owner, repo, filePath, ref) {
  if (!ENABLE_REPO_INSTRUCTIONS) return '';

  // Always attempt to load repo-level instructions first
  let repoLevel = '';
  try {
    const rootContent = await getFileContent(octokit, owner, repo, INSTRUCTION_FILENAME, ref);
    if (rootContent && !rootContent.startsWith('[File not found')) repoLevel = rootContent;
  } catch (e) {
    if (e.status !== 404) {
      structuredLog('ERROR', 'Error reading repo instructions', { path: INSTRUCTION_FILENAME, error: e.message });
    }
  }

  // Then look for the closest folder-level instructions, walking up the tree
  // from the file's directory until (but excluding) the repo root
  let folderLevel = '';
  const parts = path.posix.dirname(filePath).split('/');
  for (let i = parts.length; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const searchPath = path.posix.join(dir, INSTRUCTION_FILENAME);
    if (searchPath === INSTRUCTION_FILENAME) continue; // skip repo root handled above
    try {
      const content = await getFileContent(octokit, owner, repo, searchPath, ref);
      if (content && !content.startsWith('[File not found')) { folderLevel = content; break; }
    } catch (e) {
      if (e.status !== 404) {
        structuredLog('ERROR', 'Error reading repo instructions', { path: searchPath, error: e.message });
      }
    }
  }

  if (repoLevel && folderLevel) {
    if (repoLevel.trim() === folderLevel.trim()) return repoLevel;
    return `${folderLevel}\n\n${repoLevel}`;
  }
  return folderLevel || repoLevel || '';
}

function summarizePackageJsonChanges(baseContent, headContent) {
  try {
    const basePkg = JSON.parse(baseContent || '{}');
    const headPkg = JSON.parse(headContent || '{}');
    const sections = ['dependencies', 'devDependencies'];
    const lines = [];
    for (const section of sections) {
      const baseDeps = basePkg[section] || {};
      const headDeps = headPkg[section] || {};
      const added = Object.keys(headDeps).filter(k => !(k in baseDeps));
      const removed = Object.keys(baseDeps).filter(k => !(k in headDeps));
      const updated = Object.keys(headDeps)
        .filter(k => baseDeps[k] && headDeps[k] !== baseDeps[k])
        .map(k => `${k} (${baseDeps[k]} -> ${headDeps[k]})`);
      if (added.length)
        lines.push(`Added ${section}: ${added.map(a => `${a}@${headDeps[a]}`).join(', ')}`);
      if (removed.length)
        lines.push(`Removed ${section}: ${removed.map(r => `${r}@${baseDeps[r]}`).join(', ')}`);
      if (updated.length)
        lines.push(`Updated ${section}: ${updated.join(', ')}`);
    }
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

function getChangedLineNumbers(diff) {
  if (!diff) return { headLines: [], baseLines: [] };
  const headLines = [];
  const baseLines = [];
  const lines = diff.split('\n');
  let currentHead = 0;
  let currentBase = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/-([0-9]+),?([0-9]*) \+([0-9]+),?([0-9]*)/);
      if (match) {
        currentBase = parseInt(match[1], 10) - 1;
        currentHead = parseInt(match[3], 10) - 1;
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      headLines.push(currentHead + 1);
      currentHead++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      baseLines.push(currentBase + 1);
      currentBase++;
    } else {
      currentHead++;
      currentBase++;
    }
  }
  return { headLines, baseLines };
}

// Expand a list of changed line numbers to include the full surrounding code
// block. This attempts to capture logical units like functions or switch
// statements so the AI sees the entire context. The heuristics support
// both brace-based languages and indentation-based languages like Python.
function expandLineNumbersToBlock(content, lineNumbers) {
  if (!content || !lineNumbers || lineNumbers.length === 0) return lineNumbers;
  const lines = content.split('\n');
  const sorted = Array.from(new Set(lineNumbers)).sort((a, b) => a - b);

  function expandRange(startIdx, endIdx) {
    const hasBraces = content.includes('{') && content.includes('}');
    if (hasBraces) {
      let depth = 0;
      for (let i = startIdx; i >= 0; i--) {
        depth += (lines[i].match(/}/g) || []).length;
        depth -= (lines[i].match(/{/g) || []).length;
        if (depth < 0 || /\b(switch|function|def|class|if|for|while)\b/.test(lines[i])) {
          startIdx = i;
          break;
        }
      }

      depth = 0;
      for (let i = endIdx; i < lines.length; i++) {
        depth += (lines[i].match(/{/g) || []).length;
        depth -= (lines[i].match(/}/g) || []).length;
        if (depth < 0) {
          endIdx = i;
          break;
        }
      }
    } else {
      const indentMatch = lines[startIdx].match(/^\s*/);
      const baseIndent = indentMatch ? indentMatch[0].length : 0;
      for (let i = startIdx - 1; i >= 0; i--) {
        if (lines[i].trim() === '') continue;
        const currentIndent = lines[i].match(/^\s*/)[0].length;
        if (currentIndent < baseIndent) { startIdx = i + 1; break; }
      }
      for (let i = endIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        const currentIndent = lines[i].match(/^\s*/)[0].length;
        if (currentIndent < baseIndent) { endIdx = i - 1; break; }
      }
    }
    return [startIdx, endIdx];
  }

  const ranges = [];
  let rangeStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push([rangeStart - 1, prev - 1]);
      rangeStart = prev = sorted[i];
    }
  }
  ranges.push([rangeStart - 1, prev - 1]);

  const expandedSet = new Set();
  for (const [s, e] of ranges) {
    const [startIdx, endIdx] = expandRange(s, e);
    for (let i = startIdx; i <= endIdx; i++) expandedSet.add(i + 1);
  }

  return Array.from(expandedSet).sort((a, b) => a - b);
}

// Generate a unified diff limited to the changed region with 10 lines of context
// around the modification. This helps provide full local context without the
// noise of the entire file.
function generateContextDiff(baseContent, headContent, baseLinesNums, headLinesNums, fileName) {
  const baseLinesArr = baseContent.split('\n');
  const headLinesArr = headContent.split('\n');
  if ((!baseLinesNums || baseLinesNums.length === 0) && (!headLinesNums || headLinesNums.length === 0)) {
    return createTwoFilesPatch(fileName, fileName, baseContent, headContent, '', '', { context: 10 });
  }

  const minBase = baseLinesNums && baseLinesNums.length ? Math.max(1, Math.min(...baseLinesNums)) : baseLinesArr.length;
  const maxBase = baseLinesNums && baseLinesNums.length ? Math.max(...baseLinesNums) : 1;
  const minHead = headLinesNums && headLinesNums.length ? Math.max(1, Math.min(...headLinesNums)) : headLinesArr.length;
  const maxHead = headLinesNums && headLinesNums.length ? Math.max(...headLinesNums) : 1;

  const start = Math.max(0, Math.min(minBase, minHead) - 1 - 10);
  const end = Math.min(Math.max(baseLinesArr.length, headLinesArr.length) - 1, Math.max(maxBase, maxHead) - 1 + 10);

  const baseSnippet = baseLinesArr.slice(start, end + 1).join('\n');
  const headSnippet = headLinesArr.slice(start, end + 1).join('\n');

  const rawDiff = createTwoFilesPatch(fileName, fileName, baseSnippet, headSnippet, '', '', { context: 10 });

  // Adjust hunk headers to reflect original line numbers
  const offset = start; // zero-based index of first included line
  const adjusted = rawDiff.replace(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/g, (m, a, b, c, d) => {
    const oldStart = parseInt(a, 10) + offset;
    const newStart = parseInt(c, 10) + offset;
    const oldRange = b ? `,${b}` : '';
    const newRange = d ? `,${d}` : '';
    return `@@ -${oldStart}${oldRange} +${newStart}${newRange} @@`;
  });

  return adjusted;
}

async function processFileDiff(octokit, owner, repo, file, pr, logContext = {}) {
  const startTime = Date.now();
  structuredLog('DEBUG', 'Processing file diff', { requestId: logContext.requestId, file: file.filename });
  const fileInfo = {
    filename: file.filename,
    status: file.status,
    changes: file.changes,
    additions: file.additions,
    deletions: file.deletions,
    error: null,
    processingTime: 0,
    diff: '',
    context: '',
    changedLines: [],
    headContent: '',
    instructions: ''
  };
  try {
    if (file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i)) {
      fileInfo.error = 'Binary file - skipped'; return fileInfo;
    }
    fileInfo.instructions = await getRepoInstructions(octokit, owner, repo, file.filename, pr.head.sha);
    const diff = file.patch ? file.patch : '';
    if (file.status === 'added') {
      fileInfo.diff = diff.length > MAX_DIFF_LENGTH ? diff.substring(0, MAX_DIFF_LENGTH) + '\n[...truncated...]' : diff;
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      fileInfo.context = `## New File: ${file.filename}\n\nFile content (truncated if large):\n\`\`\`\n${content}\n\`\`\``;
      fileInfo.changedLines = getChangedLineNumbers(diff).headLines;
      fileInfo.headContent = content;
      if (file.filename.endsWith('package.json')) {
        const pkgSummary = summarizePackageJsonChanges('', content);
        if (pkgSummary) fileInfo.context += `\n\n### Dependency Changes\n${pkgSummary}`;
      }
    } else if (file.status === 'removed') {
      fileInfo.diff = diff.length > MAX_DIFF_LENGTH ? diff.substring(0, MAX_DIFF_LENGTH) + '\n[...truncated...]' : diff;
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha, { startLine: 1, endLine: 100, contextLines: 0 });
      fileInfo.context = `## Deleted File: ${file.filename}\n\nOriginal file content (first 100 lines):\n\`\`\`\n${content}\n\`\`\``;
      if (file.filename.endsWith('package.json')) {
        const pkgSummary = summarizePackageJsonChanges(content, '');
        if (pkgSummary) fileInfo.context += `\n\n### Dependency Changes\n${pkgSummary}`;
      }
    } else if (file.status === 'modified' || file.status === 'renamed') {
      const { headLines, baseLines } = getChangedLineNumbers(diff);
      const baseContent = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha);
      const headContent = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      const expandedHead = expandLineNumbersToBlock(headContent, headLines);
      const expandedBase = expandLineNumbersToBlock(baseContent, baseLines);
      fileInfo.context = `## Modified File: ${file.filename}\n\n### Changed lines with context (10 lines before/after):\n\n#### Base (${pr.base.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(baseContent, expandedBase, 10)}\n\`\`\`\n\n#### Head (${pr.head.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(headContent, expandedHead, 10)}\n\`\`\``;
      fileInfo.changedLines = headLines;
      fileInfo.headContent = headContent;
      fileInfo.diff = generateContextDiff(baseContent, headContent, expandedBase, expandedHead, file.filename);
      if (fileInfo.diff.length > MAX_DIFF_LENGTH) {
        fileInfo.diff = fileInfo.diff.substring(0, MAX_DIFF_LENGTH) + '\n[...truncated...]';
      }
      if (file.filename.endsWith('package.json')) {
        const pkgSummary = summarizePackageJsonChanges(baseContent, headContent);
        if (pkgSummary) fileInfo.context += `\n\n### Dependency Changes\n${pkgSummary}`;
      }
    }
    if (pr.body) fileInfo.context += `\n\n### PR Description/Context:\n> ${pr.body.replace(/\n/g, '\n> ')}`;
    fileInfo.processingTime = Date.now() - startTime;
    structuredLog('DEBUG', 'File diff processed', { requestId: logContext.requestId, file: file.filename });
    return fileInfo;
  } catch (error) {
    structuredLog('ERROR', 'Error processing file diff', { file: file.filename, error: error.message, stack: error.stack, requestId: logContext.requestId });
    fileInfo.error = `Processing error: ${error.message}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  }
}

async function processWhatCommand(octokit, owner, repo, pr, files, dependencies = {}, options = {}) {
  const {
    processFileDiffDep = processFileDiff,
    analyzeWithAIDep = analyzeWithAI,
    initialComment,
    logContext = {}
  } = dependencies;
  const { returnSummary = false } = options;
  logContext.repo = logContext.repo || `${owner}/${repo}`;
  logContext.pr = logContext.pr || pr.number;
  logContext.totalTokens = logContext.totalTokens || 0;
  structuredLog('INFO', 'Summary generation started', { requestId: logContext.requestId, pr: pr.number, repo: `${owner}/${repo}` });
  try {
    let diff;
    try {
      const { data } = await octokit.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } });
      diff = typeof data === 'string' ? data : data.diff;
    } catch (error) {
      structuredLog('ERROR', 'Error getting PR diff', { error: error.message, stack: error.stack });
      throw new Error('Failed to retrieve PR diff.');
    }
    if (!diff) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: pr.number,
          headers: { accept: 'application/vnd.github.v3.diff' }
        });
        diff = data;
      } catch (error) {
        structuredLog('ERROR', 'Fallback diff fetch failed', { error: error.message, stack: error.stack });
        throw new Error('Failed to retrieve PR diff.');
      }
    }
    structuredLog('DEBUG', 'PR diff retrieved', { requestId: logContext.requestId, diffLength: diff.length });
    
    const changed = `${files.length} files with ${files.reduce((a, f) => a + f.changes, 0)} changes`;
    const prompt = loadPrompt('pr_summary_request.md', {
      prTitle: pr.title,
      prAuthor: pr.user?.login || 'Unknown',
      changedFiles: changed
    });
    if (returnSummary) {
      try {
        const analysis = await analyzeWithAIDep(prompt, diff, 'PR Summary', undefined, logContext);
        structuredLog('DEBUG', 'PR summary analysis completed', { requestId: logContext.requestId, hasAnalysis: !!analysis });
        return analysis || '';
      } catch (e) {
        structuredLog('ERROR', 'PR summary analysis failed', { error: e.message, requestId: logContext.requestId });
        return '';
      }
    } else {
      const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '🤖 Analyzing changes...' });
      try {
        const analysis = await analyzeWithAIDep(prompt, diff, 'PR Summary', undefined, logContext);
        structuredLog('DEBUG', 'PR summary analysis completed', { requestId: logContext.requestId, hasAnalysis: !!analysis });
        if (analysis) {
          await octokit.issues.updateComment({ owner, repo, comment_id: comment.id, body: `## 📝 PR Summary\n\n${removeLeadingMarkdownHeading(analysis)}\n\n_Summary generated by AI - [Feedback?](https://github.com/your-org/feedback/issues)_` });
          structuredLog('INFO', 'Summary response posted', { requestId: logContext.requestId, pr: pr.number });
        } else {
          structuredLog('WARN', 'No analysis returned from LLM', { requestId: logContext.requestId });
          await octokit.issues.updateComment({ owner, repo, comment_id: comment.id, body: '❌ Error generating PR summary: No analysis returned' });
        }
      } catch (e) {
        structuredLog('ERROR', 'PR summary analysis failed', { error: e.message, requestId: logContext.requestId });
        await octokit.issues.updateComment({ owner, repo, comment_id: comment.id, body: `❌ Error generating PR summary: ${e.message}` });
      }
    }
  } catch (error) {
    structuredLog('ERROR', 'Error in processWhatCommand', { error: error.message, stack: error.stack, requestId: logContext.requestId });
    await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: `❌ Error generating PR summary: ${error.message || 'Unknown error'}` });
  }
}

async function processAskCommand(octokit, owner, repo, pr, files, question, dependencies = {}) {
  const {
    analyzeWithAIDep = analyzeWithAI,
    logContext = {},
    thread = ''
  } = dependencies;
  logContext.repo = logContext.repo || `${owner}/${repo}`;
  logContext.pr = logContext.pr || pr.number;
  logContext.totalTokens = logContext.totalTokens || 0;
  structuredLog('INFO', 'Question processing started', { requestId: logContext.requestId, pr: pr.number, repo: `${owner}/${repo}` });
  let diff = '';
  try {
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } });
    diff = typeof data === 'string' ? data : data.diff;
  } catch (error) {
    structuredLog('ERROR', 'Error getting PR diff', { error: error.message, stack: error.stack });
  }
  const commitMessages = await getCommitMessages(octokit, owner, repo, pr.number);
  const contextParts = [];
  if (thread) contextParts.push(`Conversation:\n${thread}`);
  if (commitMessages) contextParts.push(`Commits:\n${commitMessages}`);
  const context = contextParts.join('\n\n');
  const prompt = loadPrompt('ask_question.md', { question });
  try {
    const answer = await analyzeWithAIDep(prompt, diff, 'PR Question', context, logContext);
    if (answer) {
      await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: removeLeadingMarkdownHeading(answer) });
    } else {
      await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '❌ No answer generated.' });
    }
  } catch (e) {
    structuredLog('ERROR', 'Question analysis failed', { error: e.message, requestId: logContext.requestId });
    await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: `❌ Error answering question: ${e.message}` });
  }
}

async function processReviewCommand(octokit, owner, repo, pr, files, dependencies = {}, summary = '') {
  const startTime = Date.now();
  const {
    processFileDiffDep = processFileDiff,
    analyzeWithAIDep = analyzeWithAI,
    initialComment,
    logContext = {}
  } = dependencies;
  logContext.repo = logContext.repo || `${owner}/${repo}`;
  logContext.pr = logContext.pr || pr.number;
  logContext.totalTokens = logContext.totalTokens || 0;
  let reviewComment;
  const postedLineAnalyses = new Set();
  const referencedLines = [];
  try {
    if (initialComment || octokit.__initialReviewComment) {
      reviewComment = initialComment || octokit.__initialReviewComment;
      delete octokit.__initialReviewComment;
    } else {
      const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '🔍 Starting AI code review... This may take a few minutes.' });
      reviewComment = comment;
    }
    const filesToProcess = files.filter(file => {
      if (file.status === 'removed') return false;
      return !file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i);
    }).slice(0, MAX_FILES_TO_PROCESS);
    structuredLog('INFO', 'Review started', { requestId: logContext.requestId, pr: pr.number, repo: `${owner}/${repo}`, files: filesToProcess.length });

    const commitMessages = await getCommitMessages(octokit, owner, repo, pr.number);

    const fileInfos = [];
    for (const file of filesToProcess) {
      const info = await processFileDiffDep(octokit, owner, repo, file, pr, logContext);
      if (!info || info.error) {
        structuredLog('WARN', 'File processing failed', { requestId: logContext.requestId, file: file.filename, error: info?.error });
        fileInfos.push({ filename: file.filename, status: 'error', error: info?.error });
      } else {
        structuredLog('INFO', 'File processed', { requestId: logContext.requestId, file: file.filename });
        fileInfos.push({ filename: file.filename, status: 'ok', info });
      }
    }

    const combinedDiff = fileInfos
      .filter(f => f.status === 'ok')
      .map(f => `### ${f.info.filename}\n${f.info.diff}`)
      .join('\n');

    const managerPrompt = loadPrompt('manager_summary.md');
    let managerPlan = '';
    try {
      managerPlan = await analyzeWithAIDep(managerPrompt, combinedDiff, 'Manager Plan', commitMessages, logContext);
    } catch (e) {
      structuredLog('ERROR', 'Manager plan analysis failed', { requestId: logContext.requestId, error: e.message });
      managerPlan = '';
    }

      const results = await Promise.all(fileInfos.map(f => limit(async () => {
        if (f.status !== 'ok') return { filename: f.filename, status: 'error', error: f.error };
        const { info } = f;
        const reviewerPrompt = loadPrompt('reviewer_task.md', {
          fileName: info.filename,
          managerPlan,
          repoInstructions: info.instructions || ''
        });
        let analysis;
        let analysisError;
        try {
          analysis = await analyzeWithAIDep(reviewerPrompt, info.diff, info.filename, info.context, logContext);
        } catch (e) {
          analysisError = e.message;
        }

        let lineAnalyses = [];
        if (analysis && info.changedLines && info.changedLines.length > 0) {
          const linesToComment = info.changedLines.slice(0, 3);
          for (const line of linesToComment) {
            const snippet = getSurroundingLines(info.headContent || '', [line], 3);
            const inlinePrompt = loadPrompt('line_review.md', {
              line,
              fileName: info.filename,
              managerPlan,
              snippet,
              repoInstructions: info.instructions || ''
            });
            let lineAnalysis;
            try {
              lineAnalysis = await analyzeWithAIDep(inlinePrompt, snippet, info.filename, info.context, logContext);
            } catch (e) {
              structuredLog('ERROR', 'Inline analysis failed', { file: info.filename, line, error: e.message });
            }
            if (lineAnalysis) lineAnalyses.push({ line, comment: lineAnalysis.trim() });
          }
          if (lineAnalyses.length > 0) {
            lineAnalyses = await mergeSimilarLineAnalyses(lineAnalyses, info.filename, managerPlan, analyzeWithAIDep, logContext);
            for (const { lines, comment } of lineAnalyses) {
              const trimmed = comment.trim();
              if (!shouldPostInlineComment(trimmed)) continue;
              const key = trimmed.toLowerCase();
              if (!postedLineAnalyses.has(key)) {
                postedLineAnalyses.add(key);
                try {
                  await octokit.pulls.createReviewComment({
                    owner,
                    repo,
                    pull_number: pr.number,
                    commit_id: pr.head.sha,
                    path: info.filename,
                    body: `${trimmed}\n\n_Lines: ${lines.join(', ')}_`,
                    line: lines[0],
                    side: 'RIGHT'
                  });
                  referencedLines.push({ file: info.filename, lines });
                } catch (e) {
                  structuredLog('ERROR', 'Failed to create inline comment', { file: info.filename, line: lines[0], error: e.message, stack: e.stack });
                }
              }
            }
          }
        }

        const result = {
          filename: info.filename,
          status: analysis ? 'reviewed' : 'error',
          analysis,
          error: analysis ? null : (analysisError || 'Failed to analyze file')
        };
        if (result.status === 'reviewed') {
          structuredLog('INFO', 'File reviewed', { requestId: logContext.requestId, file: result.filename });
        } else {
          structuredLog('ERROR', 'File review failed', { requestId: logContext.requestId, file: result.filename, error: result.error });
        }
        return result;
      })));

    const combinedReviews = results.filter(r => r.analysis).map(r => `### ${r.filename}\n${r.analysis}`).join('\n');
    const finalPrompt = loadPrompt('final_review.md');
    let finalSummary = '';
    try {
      finalSummary = await analyzeWithAIDep(finalPrompt, combinedReviews, 'Manager Final', managerPlan, logContext);
    } catch (e) {
      structuredLog('ERROR', 'Final summary analysis failed', { requestId: logContext.requestId, error: e.message });
      finalSummary = `Final summary unavailable: ${e.message}`;
    }

    const successfulReviews = results.filter(r => r.status === 'reviewed' && r.analysis);
    const filesWithIssues = successfulReviews.filter(r => !r.analysis.toLowerCase().includes('no issues'));
    const errors = results.filter(r => r.status === 'error');
    const processingTime = (Date.now() - startTime) / 1000;

    const linkedSummary = linkLineNumbers(removeLeadingMarkdownHeading(finalSummary), referencedLines, owner, repo, pr.number);
    let reviewBody = '';
    reviewBody += `## 🔍 AI Code Review Summary\n\n${linkedSummary}\n\n`;

    if (referencedLines.length > 0) {
      reviewBody += `### 📌 Referenced Lines\n\n`;
      for (const ref of referencedLines) {
        const anchor = diffAnchor(ref.file);
        const links = ref.lines.map(l => `[L${l}](https://github.com/${owner}/${repo}/pull/${pr.number}/files#diff-${anchor}R${l})`).join(', ');
        reviewBody += `- ${ref.file}: ${links}\n`;
      }
      reviewBody += '\n';
    }

    if (filesWithIssues.length > 0) {
      reviewBody += `## 🚨 Files with Potential Issues\n\n`;
      for (const file of filesWithIssues) reviewBody += `### 📄 ${file.filename}\n`;
    } else if (successfulReviews.length > 0) reviewBody += '🎉 No potential issues found in the reviewed files!\n\n';

    if (errors.length > 0) reviewBody += `## ⚠️ Processing Errors\n\nThe following files could not be processed:\n${errors.map(e => `- ${e.filename}: ${e.error || 'Unknown error'}`).join('\n')}\n\n`;

    reviewBody += '---\n🔍 This is an automated review powered by AI.\n⚠️ This is a best-effort review and may not catch all issues.\n🔍 Always perform your own thorough review before merging.\n⏱️ Total processing time: ' + processingTime.toFixed(1) + 's';
    await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: reviewBody });
    structuredLog('INFO', 'Review completed', { requestId: logContext.requestId, pr: pr.number, repo: `${owner}/${repo}`, filesReviewed: results.length, processingTime, totalTokens: logContext.totalTokens, model: llmClient?.model });
  } catch (error) {
    structuredLog('ERROR', 'Error in processReviewCommand', { error: error.message, stack: error.stack, requestId: logContext.requestId });
    try {
      const errorMessage = error.message || 'Unknown error occurred';
      const errorBody = `## ❌ Error During Review\n\nAn error occurred while processing your review request:\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nPlease try again later or contact support if the issue persists.`;
      if (reviewComment) await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: errorBody });
      else await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: errorBody });
    } catch (updateError) { structuredLog('ERROR', 'Failed to post error comment', { error: updateError.message }); }
  }
}

async function processReviewCommentReply(octokit, owner, repo, prNumber, comment, parent, requestText = '', logContext = {}) {
  if (!octokit || !owner || !repo || !prNumber || !comment || !parent) {
    throw new Error('Missing required parameters');
  }
  logContext.repo = logContext.repo || `${owner}/${repo}`;
  logContext.pr = logContext.pr || prNumber;
  logContext.totalTokens = logContext.totalTokens || 0;
  const requestId = logContext.requestId || comment.__requestId;
  try {
    let threadText = '';
    try {
      const { data: all } = await octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 100 });
      const threadComments = all
        .filter(c => c.id === parent.id || c.in_reply_to_id === parent.id)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .filter(c => c.id !== comment.id);
      threadText = threadComments
        .map(c => `${c.user?.login || 'unknown'}: ${c.body}`)
        .join('\n');
    } catch (e) {
      structuredLog('WARN', 'Failed to fetch thread comments', { error: e.message, requestId });
      threadText = parent.body || '';
    }
    const prompt = loadPrompt('comment_reply.md', {
      thread: threadText,
      request: requestText || ''
    });
    structuredLog('INFO', 'Reply generation started', { requestId, pr: prNumber });
    const snippet = comment.diff_hunk || parent.diff_hunk || '';
    const response = await analyzeWithAI(prompt, snippet, comment.path || '', threadText, logContext);
    if (response) {
      await octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: parent.id,
        body: response.trim()
      });
      structuredLog('INFO', 'Reply posted', { requestId, pr: prNumber });
    }
  } catch (error) {
    structuredLog('ERROR', 'Error in processReviewCommentReply', { error: error.message, stack: error.stack, requestId });
    try {
      await octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        comment_id: parent.id,
        body: `❌ Error processing review request: ${error.message}`
      });
    } catch (replyError) {
      structuredLog('ERROR', 'Failed to post error reply', { error: replyError.message, requestId });
    }
  }
}

async function getInstallationOctokit(context, repository) {
  const token = await context.octokit.apps.createInstallationAccessToken({
    installation_id: context.payload.installation.id,
    repository_ids: [repository.id]
  }).then(({ data }) => data.token);
  return new Octokit({ auth: `token ${token}` });
}

async function handlePrAction(context, repository, prNumber, action, requestId) {
  const repoName = repository.name;
  const repoOwner = repository.owner.login;
  const octokit = await getInstallationOctokit(context, repository);
  const deps = { processFileDiffDep: processFileDiff, analyzeWithAIDep: analyzeWithAI, logContext: { requestId, repo: `${repoOwner}/${repoName}`, totalTokens: 0 } };
  structuredLog('INFO', 'Processing trigger', { requestId, action, prNumber, repo: `${repoOwner}/${repoName}` });
  try {
    const { data: pr } = await octokit.pulls.get({ owner: repoOwner, repo: repoName, pull_number: prNumber });
    const { data: files } = await octokit.pulls.listFiles({ owner: repoOwner, repo: repoName, pull_number: prNumber });

    if (action === 'summary') {
      await module.exports.processWhatCommand(octokit, repoOwner, repoName, pr, files, deps);
    } else if (action === 'review') {
      const summary = await module.exports.processWhatCommand(
        octokit,
        repoOwner,
        repoName,
        pr,
        files,
        deps,
        { returnSummary: true }
      );
      const { data: initialComment } = await octokit.issues.createComment({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
        body: '🔍 Starting AI code review... This may take a few minutes.'
      });
      octokit.__initialReviewComment = initialComment;
      await module.exports.processReviewCommand(octokit, repoOwner, repoName, pr, files, { ...deps, initialComment }, summary);
    }
  } catch (error) {
    structuredLog('ERROR', 'Error processing PR event', { error: error.message, stack: error.stack, requestId });
    await octokit.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: prNumber,
      body: '❌ An error occurred while processing your request.'
    });
  }
}

// --- registerEventHandlers attaches all Probot event handlers ---
function registerEventHandlers(probot, options = {}) {
  const {
    enableIssueComment = process.env.ENABLE_ISSUE_COMMENT_EVENT !== 'false',
    enableReviewComment = process.env.ENABLE_REVIEW_COMMENT_EVENT !== 'false',
    enableLabel = process.env.ENABLE_LABEL_EVENT === 'true',
    reviewLabel = process.env.TRIGGER_LABEL || 'ai-review',
    reviewKeyword = process.env.REVIEW_COMMENT_KEYWORD || '/review',
    summaryKeyword = process.env.SUMMARY_COMMENT_KEYWORD || '/what',
    askKeyword = process.env.ASK_COMMENT_KEYWORD || '/ask',
  } = options;

  if (enableIssueComment) {
    probot.on('issue_comment.created', async (context) => {
      const { comment, issue, repository } = context.payload;
      const { body } = comment;
      if (!body.startsWith(summaryKeyword) && !body.startsWith(reviewKeyword) && !body.startsWith(askKeyword)) return;
      if (!issue.pull_request) return;

      const prNumber = issue.number;
      const requestId = crypto.randomUUID();
      const repoFull = repository.full_name;
      if (body.startsWith(askKeyword)) {
        const question = body.slice(askKeyword.length).trim();
        structuredLog('INFO', 'Trigger received', { requestId, source: 'issue_comment', action: 'ask', prNumber, repo: repoFull });
        const octokit = await getInstallationOctokit(context, repository);
        const { data: pr } = await octokit.pulls.get({ owner: repository.owner.login, repo: repository.name, pull_number: prNumber });
        const { data: files } = await octokit.pulls.listFiles({ owner: repository.owner.login, repo: repository.name, pull_number: prNumber });
        let thread = '';
        try {
          const { data: comments } = await octokit.issues.listComments({ owner: repository.owner.login, repo: repository.name, issue_number: prNumber, per_page: 100 });
          const prior = comments.filter(c => c.id !== comment.id)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          thread = prior.map(c => `${c.user?.login || 'unknown'}: ${c.body}`).join('\n');
        } catch (e) {
          structuredLog('WARN', 'Failed to fetch issue comments', { error: e.message, requestId });
        }
        await module.exports.processAskCommand(octokit, repository.owner.login, repository.name, pr, files, question, { logContext: { requestId, repo: repoFull, totalTokens: 0 }, thread });
      } else {
        const action = body.startsWith(reviewKeyword) ? 'review' : 'summary';
        structuredLog('INFO', 'Trigger received', { requestId, source: 'issue_comment', action, prNumber, repo: repoFull });
        await handlePrAction(context, repository, prNumber, action, requestId);
      }
    });
  }

  if (enableReviewComment) {
    probot.on('pull_request_review_comment.created', async (context) => {
      const { comment, pull_request: pr, repository } = context.payload;
      const { body, in_reply_to_id } = comment;
      const startsReview = body.startsWith(reviewKeyword);
      const startsAsk = body.startsWith(askKeyword);
      if (!startsReview && !startsAsk) return;
      if (startsReview && !in_reply_to_id) return;
      const repoOwner = repository.owner.login;
      const repoName = repository.name;
      const prNumber = pr.number;
      const requestId = crypto.randomUUID();
      structuredLog('INFO', 'Trigger received', { requestId, source: 'review_comment', prNumber, repo: repository.full_name });
      const octokit = await getInstallationOctokit(context, repository);
      let parent;
      if (in_reply_to_id) {
        try {
          const { data } = await octokit.pulls.getReviewComment({ owner: repoOwner, repo: repoName, comment_id: in_reply_to_id });
          parent = data;
        } catch (e) {
          structuredLog('ERROR', 'Failed to fetch parent comment', { error: e.message, stack: e.stack, requestId });
          return;
        }
      } else {
        parent = comment;
      }
      const keyword = startsAsk ? askKeyword : reviewKeyword;
      const userRequest = body.slice(keyword.length).trim();
      comment.__requestId = requestId;
      await module.exports.processReviewCommentReply(octokit, repoOwner, repoName, prNumber, comment, parent, userRequest, { requestId, repo: repository.full_name, totalTokens: 0 });
    });
  }

  if (enableLabel) {
    probot.on('pull_request.labeled', async (context) => {
      const { label, pull_request: pr, repository } = context.payload;
      if (!label || label.name !== reviewLabel) return;
      const requestId = crypto.randomUUID();
      structuredLog('INFO', 'Trigger received', { requestId, source: 'label', action: 'review', prNumber: pr.number, repo: repository.full_name });
      await handlePrAction(context, repository, pr.number, 'review', requestId);
    });
  }


  probot.on('installation.created', async (context) => {
    const { repositories = [] } = context.payload;
    structuredLog('INFO', 'App installed', { repositories: repositories.length });
  });

  probot.onError((error) => {
    structuredLog('ERROR', 'App error', { error: error.message, stack: error.stack });
  });
}

// --- createProbotApp Function Definition ---
function createProbotApp(config = {}) {
  const finalAppId = config.appId || process.env.APP_ID;
  const finalPrivateKey = (config.privateKey || process.env.PRIVATE_KEY || ''); // Ensure it's a string
  const finalWebhookSecret = config.webhookSecret || process.env.WEBHOOK_SECRET;

  // The .replace is crucial if PRIVATE_KEY env var has escaped newlines
  const probot = new Probot({
    appId: finalAppId,
    privateKey: finalPrivateKey.replace(/\\n/g, '\n'),
    webhookSecret: finalWebhookSecret,
  });

  registerEventHandlers(probot, config.eventOptions || {});

  return probot;
}

// Initialize the global app instance using the factory for tests
const app = createProbotApp();
structuredLog('INFO', 'Probot app initialized');

// Start the Probot server when run directly
if (require.main === module) {
  const { run } = require('probot');
  run(registerEventHandlers).catch(error => {
    structuredLog('ERROR', 'Failed to start Probot app', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

// Export everything needed
module.exports = {
  app, // The global app instance
  createProbotApp, // The factory function
  registerEventHandlers,
  processFileDiff,
  processWhatCommand,
  processAskCommand,
  processReviewCommand,
  processReviewCommentReply,
  getFileContent,
  getChangedLineNumbers,
  expandLineNumbersToBlock,
  getSurroundingLines,
  mergeSimilarLineAnalyses,
  analyzeWithAI,
  truncateToLines,
  removeLeadingMarkdownHeading,
  linkLineNumbers,
  summarizePackageJsonChanges,
  getRepoInstructions,
  constants: {
    MAX_FILE_SIZE,
    MAX_DIFF_LENGTH,
    MAX_DIFF_LINES,
    MAX_CONTEXT_LINES,
    REQUEST_TIMEOUT,
    CONCURRENCY_LIMIT,
    MAX_FILES_TO_PROCESS,
    TRIGGER_LABEL,
    INSTRUCTION_FILENAME,
    ENABLE_REPO_INSTRUCTIONS
  }
};

