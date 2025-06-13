// Import required modules
require('dotenv').config();
const { Probot } = require('probot');
const { Octokit } = require('@octokit/rest');
const { GoogleGenAI } = require('@google/genai');
const pLimit = require("p-limit").default || require("p-limit");

// Configuration constants
function structuredLog(severity, message, fields = {}) {
  const logData = JSON.stringify({ severity, message, ...fields, timestamp: new Date().toISOString() });
  switch (severity.toLowerCase()) {
    case 'error':
      console.error(logData);
      break;
    case 'warn':
      console.warn(logData);
      break;
    case 'info':
      console.info(logData);
      break;
    case 'debug':
      console.debug(logData);
      break;
    default:
      console.log(logData); // Fallback for unknown or default severity
  }
}
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '100000', 10);
const MAX_DIFF_LENGTH = parseInt(process.env.MAX_DIFF_LENGTH || '8000', 10);
const MAX_DIFF_LINES = parseInt(process.env.MAX_DIFF_LINES || '500', 10);
const MAX_CONTEXT_LINES = parseInt(process.env.MAX_CONTEXT_LINES || '200', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '3', 10);
const MAX_FILES_TO_PROCESS = parseInt(process.env.MAX_FILES_TO_PROCESS || '20', 10);
// Label that triggers an AI review when added to a PR
const TRIGGER_LABEL = process.env.TRIGGER_LABEL || 'ai-review';

// Verify required environment variables (This will run when module is loaded)
const requiredVars = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    structuredLog('ERROR', 'Missing required environment variable', { varName });
    process.exit(1); // Exit if env vars are missing
  }
}

// Initialize rate limiter
const limit = pLimit(CONCURRENCY_LIMIT);

// Initialize Google GenAI (using Vertex AI under the hood)
// If GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION are not set, this might error early.
let genAI;
try {
  genAI = new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION,
  });
} catch (e) {
  structuredLog('ERROR', 'Failed to initialize GoogleGenAI', { error: e.message, stack: e.stack });
  // Decide if process should exit or if this is recoverable/testable
}


// Initialize the AI model -- allow override via environment variable
const model = process.env.GENAI_MODEL || 'gemini-2.5-flash-preview-05-20';

// --- Helper functions (analyzeWithAI, truncateToLines, etc.) remain in module scope ---
async function analyzeWithAI(prompt, codeSnippet, filePath, context = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const truncatedSnippet = truncateToLines(codeSnippet, MAX_DIFF_LINES);
    const truncatedContext = context ? truncateToLines(context, MAX_CONTEXT_LINES) : '';
    const generationConfig = {
      maxOutputTokens: 4096, temperature: 0.2, topP: 0.8, topK: 40,
    };
    const result = await genAI.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: `# Code Review Task: ${filePath}\n\n## Context\n${truncatedContext || 'No additional context provided.'}\n\n## Changes\n\`\`\`diff\n${truncatedSnippet}\n\`\`\`\n\n## Instructions\n${prompt}\n\n## Guidelines\n- Be specific and reference line numbers from the diff\n- Only report issues you're certain about\n- Suggest concrete improvements when possible` }] }],
      config: generationConfig,
    });
    clearTimeout(timeoutId);
    return result.text;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      structuredLog('WARNING', 'AI analysis timed out', { filePath });
      return 'Analysis timed out. The diff might be too large or the service might be busy.';
    }
    let message = error.message || 'Unknown error';
    if (message.includes('Unexpected token') && message.includes('<')) {
      message = 'Google GenAI returned an invalid response. Check your credentials and network settings.';
    }
    const previewSource = error.response?.data || error.stack || '';
    const preview = typeof previewSource === 'string'
      ? previewSource.split('\n').slice(0, 3).join('\n')
      : '';
    structuredLog('ERROR', 'Error in analyzeWithAI', {
      filePath,
      error: message,
      preview: preview || undefined,
      stack: error.stack || undefined,
    });
    return null;
  }
}

function truncateToLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n[... ${lines.length - maxLines} more lines ...]`;
}

function removeLeadingMarkdownHeading(text) {
  if (!text) return '';
  return text.replace(/^\s*#{1,6}\s.*\n+/, '');
}

function getSurroundingLines(content, lineNumbers, contextLines = 10) {
  if (!content) return '';
  const lines = content.split('\n');
  const lineSet = new Set(lineNumbers);
  const includedLines = new Set();
  lineNumbers.forEach(lineNum => {
    const start = Math.max(1, lineNum - contextLines);
    const end = Math.min(lines.length, lineNum + contextLines);
    for (let i = start; i <= end; i++) includedLines.add(i - 1);
  });
  const result = [];
  let lastLine = -2;
  Array.from(includedLines).sort((a, b) => a - b).forEach(idx => {
    if (idx > lastLine + 1 && lastLine !== -2) result.push('...');
    const lineNum = idx + 1;
    const lineContent = lines[idx] || '';
    const linePrefix = lineSet.has(lineNum) ? '> ' : '  ';
    result.push(linePrefix + lineNum.toString().padStart(4) + ': ' + lineContent);
    lastLine = idx;
  });
  return result.join('\n');
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

function getChangedLineNumbers(diff) {
  if (!diff) return [];
  const lineNumbers = [];
  const lines = diff.split('\n');
  let currentLine = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/\+([0-9]+),?([0-9]*)/);
      if (match) currentLine = parseInt(match[1], 10) - 1;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) lineNumbers.push(currentLine + 1);
    if (!line.startsWith('-') || line.startsWith('---')) currentLine++;
  }
  return lineNumbers;
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

async function processFileDiff(octokit, owner, repo, file, pr) {
  const startTime = Date.now();
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
    headContent: ''
  };
  try {
    if (file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i)) {
      fileInfo.error = 'Binary file - skipped'; return fileInfo;
    }
    const diff = file.patch ? file.patch : '';
    fileInfo.diff = diff.length > MAX_DIFF_LENGTH ? diff.substring(0, MAX_DIFF_LENGTH) + '\n[...truncated...]' : diff;
    if (file.status === 'added') {
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      fileInfo.context = `## New File: ${file.filename}\n\nFile content (truncated if large):\n\`\`\`\n${content}\n\`\`\``;
      fileInfo.changedLines = getChangedLineNumbers(diff);
      fileInfo.headContent = content;
    } else if (file.status === 'removed') {
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha, { startLine: 1, endLine: 100, contextLines: 0 });
      fileInfo.context = `## Deleted File: ${file.filename}\n\nOriginal file content (first 100 lines):\n\`\`\`\n${content}\n\`\`\``;
    } else if (file.status === 'modified' || file.status === 'renamed') {
      const changedLines = getChangedLineNumbers(diff);
      const baseContent = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha);
      const headContent = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      const expandedLines = expandLineNumbersToBlock(headContent, changedLines);
      fileInfo.context = `## Modified File: ${file.filename}\n\n### Changed lines with context (10 lines before/after):\n\n#### Base (${pr.base.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(baseContent, expandedLines, 10)}\n\`\`\`\n\n#### Head (${pr.head.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(headContent, expandedLines, 10)}\n\`\`\``;
      fileInfo.changedLines = changedLines;
      fileInfo.headContent = headContent;
    }
    if (pr.body) fileInfo.context += `\n\n### PR Description/Context:\n> ${pr.body.replace(/\n/g, '\n> ')}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  } catch (error) {
    structuredLog('ERROR', 'Error processing file diff', { file: file.filename, error: error.message, stack: error.stack });
    fileInfo.error = `Processing error: ${error.message}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  }
}

async function processWhatCommand(octokit, owner, repo, pr, files, dependencies = {}, options = {}) {
  const {
    processFileDiffDep = processFileDiff,
    analyzeWithAIDep = analyzeWithAI,
    initialComment
  } = dependencies;
  const { returnSummary = false } = options;
  try {
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: 'diff' } })
      .catch(error => { structuredLog('ERROR', 'Error getting PR diff', { error: error.message, stack: error.stack }); throw new Error('Failed to retrieve PR diff.'); });
    const diff = typeof data === 'string' ? data : data.diff;
    
    const prompt = `# PR Summary Request\n\n## PR Details\n- Title: ${pr.title}\n- Author: ${pr.user?.login || 'Unknown'}\n- Changed Files: ${files.length} files with ${files.reduce((a, f) => a + f.changes, 0)} changes\n\n## Instructions\nPlease provide a concise summary of the changes in this pull request.\nFocus on the main purpose and key changes. Be brief and to the point.\nHighlight any major architectural changes or potential impacts.`;
    if (returnSummary) {
      const analysis = await analyzeWithAIDep(prompt, diff, 'PR Summary');
      return analysis || '';
    } else {
      const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '🤖 Analyzing changes...' });
      const analysis = await analyzeWithAIDep(prompt, diff, 'PR Summary');
      if (analysis) {
        await octokit.issues.updateComment({ owner, repo, comment_id: comment.id, body: `## 📝 PR Summary\n\n${removeLeadingMarkdownHeading(analysis)}\n\n_Summary generated by AI - [Feedback?](https://github.com/your-org/feedback/issues)_` });
      }
    }
  } catch (error) {
    structuredLog('ERROR', 'Error in processWhatCommand', { error: error.message, stack: error.stack });
    await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: `❌ Error generating PR summary: ${error.message || 'Unknown error'}` });
  }
}

async function processReviewCommand(octokit, owner, repo, pr, files, dependencies = {}, summary = '') {
  const startTime = Date.now();
  const {
    processFileDiffDep = processFileDiff,
    analyzeWithAIDep = analyzeWithAI,
    initialComment
  } = dependencies;
  let reviewComment;
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
    const processFile = async (file) => {
      try {
        const fileDiff = await processFileDiffDep(octokit, owner, repo, file, pr);
        if (!fileDiff || fileDiff.error) return { filename: file.filename, status: 'error', error: fileDiff?.error };
        const prompt = `# Code Review Request\n\n## File: ${file.filename} (${file.status})\nChanges: ${file.changes} (${file.additions}+ ${file.deletions}-)\n\n## Review Guidelines\n1. Focus on the changes shown in the diff\n2. Check for bugs, security issues, and performance concerns\n3. Suggest improvements for code quality and best practices\n4. Only report issues you're certain about\n5. Reference specific line numbers from the diff\n\n## Context\n${fileDiff.context ? truncateToLines(fileDiff.context, 100) : 'No context available'}\n\n## Changes\n\`\`\`diff\n${fileDiff.diff}\n\`\`\``;
        const analysis = await analyzeWithAIDep(prompt, fileDiff.diff, file.filename, fileDiff.context);

        if (analysis && fileDiff.changedLines && fileDiff.changedLines.length > 0) {
          const linesToComment = fileDiff.changedLines.slice(0, 3);
          for (const line of linesToComment) {
            const snippet = getSurroundingLines(fileDiff.headContent || '', [line], 3);
            const inlinePrompt = `# Line Review\n\nProvide feedback for the following change in ${file.filename} around line ${line}:\n\n\`\`\`\n${snippet}\n\`\`\``;
            const lineAnalysis = await analyzeWithAIDep(inlinePrompt, snippet, file.filename, fileDiff.context);
            if (lineAnalysis) {
              try {
                await octokit.pulls.createReviewComment({
                  owner,
                  repo,
                  pull_number: pr.number,
                  commit_id: pr.head.sha,
                  path: file.filename,
                  body: lineAnalysis,
                  line,
                  side: 'RIGHT'
                });
              } catch (e) {
                structuredLog('ERROR', 'Failed to create inline comment', { file: file.filename, line, error: e.message, stack: e.stack });
              }
            }
          }
        }

        return { filename: file.filename, status: analysis ? 'reviewed' : 'error', analysis, error: analysis ? null : 'Failed to analyze file' };
      } catch (error) {
        structuredLog('ERROR', 'Error processing file', { file: file.filename, error: error.message, stack: error.stack });
        return { filename: file.filename, status: 'error', error: error.message };
      }
    };
    const results = await Promise.all(filesToProcess.map(file => limit(() => processFile(file))));
    const successfulReviews = results.filter(r => r.status === 'reviewed' && r.analysis);
    const filesWithIssues = successfulReviews.filter(r => !r.analysis.toLowerCase().includes('no issues found'));
    const errors = results.filter(r => r.status === 'error');
    const processingTime = (Date.now() - startTime) / 1000;
    let reviewBody = '';
    if (summary) {
      reviewBody += `## 📝 PR Summary\n\n${removeLeadingMarkdownHeading(summary)}\n\n`;
    }
    reviewBody += `## 🔍 AI Code Review Summary\n\n✅ Processed ${successfulReviews.length} files in ${processingTime.toFixed(1)}s\n⚠️  Found potential issues in ${filesWithIssues.length} files\n❌ ${errors.length} files had errors\n\n`;
    if (filesWithIssues.length > 0) {
      reviewBody += `## 🚨 Files with Potential Issues\n\n`;
      for (const file of filesWithIssues) reviewBody += `### 📄 ${file.filename}\n${file.analysis}\n\n`;
    } else if (successfulReviews.length > 0) reviewBody += '🎉 No potential issues found in the reviewed files!\n\n';
    if (errors.length > 0) reviewBody += `## ⚠️ Processing Errors\n\nThe following files could not be processed:\n${errors.map(e => `- ${e.filename}: ${e.error || 'Unknown error'}`).join('\n')}\n\n`;
    reviewBody += '---\n🔍 This is an automated review powered by Google GenAI.\n⚠️ This is a best-effort review and may not catch all issues.\n🔍 Always perform your own thorough review before merging.\n⏱️ Total processing time: ' + processingTime.toFixed(1) + 's';
    await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: reviewBody });
  } catch (error) {
    structuredLog('ERROR', 'Error in processReviewCommand', { error: error.message, stack: error.stack });
    try {
      const errorMessage = error.message || 'Unknown error occurred';
      const errorBody = `## ❌ Error During Review\n\nAn error occurred while processing your review request:\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nPlease try again later or contact support if the issue persists.`;
      if (reviewComment) await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: errorBody });
      else await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: errorBody });
    } catch (updateError) { structuredLog('ERROR', 'Failed to post error comment', { error: updateError.message }); }
  }
}

// --- registerEventHandlers attaches all Probot event handlers ---
function registerEventHandlers(probot, options = {}) {
  const {
    enableIssueComment = process.env.ENABLE_ISSUE_COMMENT_EVENT !== 'false',
    enableLabel = process.env.ENABLE_LABEL_EVENT === 'true',
    reviewLabel = process.env.REVIEW_TRIGGER_LABEL || 'ai-review',
    reviewKeyword = process.env.REVIEW_COMMENT_KEYWORD || '/review',
    summaryKeyword = process.env.SUMMARY_COMMENT_KEYWORD || '/what',
  } = options;

  if (enableIssueComment) {
    probot.on('issue_comment.created', async (context) => {
      const { comment, issue, repository } = context.payload;
      const { body } = comment;
      if (!body.startsWith(summaryKeyword) && !body.startsWith(reviewKeyword)) return;
      if (!issue.pull_request) return;

    const prNumber = issue.number;
    const { name: repoName, owner } = repository;
    const repoOwner = owner.login;

    const octokitInstance = new Octokit({
      auth: `token ${await context.octokit.apps.createInstallationAccessToken({
        installation_id: context.payload.installation.id,
        repository_ids: [repository.id]
      }).then(({ data }) => data.token)}`
    });

    try {
      const { data: pr } = await octokitInstance.pulls.get({ owner: repoOwner, repo: repoName, pull_number: prNumber });
      const { data: files } = await octokitInstance.pulls.listFiles({ owner: repoOwner, repo: repoName, pull_number: prNumber });

      const dependencies = {
        processFileDiffDep: processFileDiff, // Pass actual functions
        analyzeWithAIDep: analyzeWithAI
      };

      if (body.startsWith(summaryKeyword)) {
        await module.exports.processWhatCommand(octokitInstance, repoOwner, repoName, pr, files, dependencies);
      } else if (body.startsWith(reviewKeyword)) {
        const summary = await module.exports.processWhatCommand(
          octokitInstance,
          repoOwner,
          repoName,
          pr,
          files,
          dependencies,
          { returnSummary: true }
        );
        const { data: initialComment } = await octokitInstance.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: prNumber,
          body: '🔍 Starting AI code review... This may take a few minutes.'
        });
        // stash the comment on the octokit instance so the command can reuse it
        octokitInstance.__initialReviewComment = initialComment;
        await module.exports.processReviewCommand(
          octokitInstance,
          repoOwner,
          repoName,
          pr,
          files,
          dependencies,
          summary
        );
      }
    } catch (error) {
      structuredLog('ERROR', 'Error processing PR comment', { error: error.message, stack: error.stack });
      await octokitInstance.issues.createComment({ owner: repoOwner, repo: repoName, issue_number: prNumber, body: '❌ An error occurred while processing your request.' });
    }
    });
  }

  if (enableLabel) {
    probot.on('pull_request.labeled', async (context) => {
      const { label, pull_request: pr, repository } = context.payload;
      if (!label || label.name !== reviewLabel) return;

      const prNumber = pr.number;
      const { name: repoName, owner } = repository;
      const repoOwner = owner.login;

      const octokitInstance = new Octokit({
        auth: `token ${await context.octokit.apps.createInstallationAccessToken({
          installation_id: context.payload.installation.id,
          repository_ids: [repository.id]
        }).then(({ data }) => data.token)}`
      });

      try {
        const { data: fullPr } = await octokitInstance.pulls.get({ owner: repoOwner, repo: repoName, pull_number: prNumber });
        const { data: files } = await octokitInstance.pulls.listFiles({ owner: repoOwner, repo: repoName, pull_number: prNumber });

        const dependencies = { processFileDiffDep: processFileDiff, analyzeWithAIDep: analyzeWithAI };
        const summary = await module.exports.processWhatCommand(octokitInstance, repoOwner, repoName, fullPr, files, dependencies, { returnSummary: true });
        const { data: initialComment } = await octokitInstance.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: prNumber,
          body: '🔍 Starting AI code review... This may take a few minutes.'
        });
        octokitInstance.__initialReviewComment = initialComment;
        await module.exports.processReviewCommand(octokitInstance, repoOwner, repoName, fullPr, files, dependencies, summary);
      } catch (error) {
        structuredLog('ERROR', 'Error processing label event', { error: error.message, stack: error.stack });
        await octokitInstance.issues.createComment({ owner: repoOwner, repo: repoName, issue_number: prNumber, body: '❌ An error occurred while processing your request.' });
      }
    });
  }

  probot.on('pull_request.labeled', async (context) => {
    const { pull_request: pr, repository, label } = context.payload;
    if (!pr || label.name !== TRIGGER_LABEL) return;

    const prNumber = pr.number;
    const { name: repoName, owner } = repository;
    const repoOwner = owner.login;

    const octokitInstance = new Octokit({
      auth: `token ${await context.octokit.apps.createInstallationAccessToken({
        installation_id: context.payload.installation.id,
        repository_ids: [repository.id]
      }).then(({ data }) => data.token)}`
    });

    try {
      const { data: prData } = await octokitInstance.pulls.get({ owner: repoOwner, repo: repoName, pull_number: prNumber });
      const { data: files } = await octokitInstance.pulls.listFiles({ owner: repoOwner, repo: repoName, pull_number: prNumber });

      const dependencies = {
        processFileDiffDep: processFileDiff,
        analyzeWithAIDep: analyzeWithAI
      };

      const summary = await module.exports.processWhatCommand(
        octokitInstance,
        repoOwner,
        repoName,
        prData,
        files,
        dependencies,
        { returnSummary: true }
      );
      const { data: initialComment } = await octokitInstance.issues.createComment({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
        body: '🔍 Starting AI code review... This may take a few minutes.'
      });
      octokitInstance.__initialReviewComment = initialComment;

      await module.exports.processReviewCommand(
        octokitInstance,
        repoOwner,
        repoName,
        prData,
        files,
        dependencies,
        summary
      );
    } catch (error) {
      structuredLog('ERROR', 'Error processing PR label event', { error: error.message, stack: error.stack });
    }
  });

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
  processReviewCommand,
  getFileContent,
  getChangedLineNumbers,
  expandLineNumbersToBlock,
  getSurroundingLines,
  analyzeWithAI,
  truncateToLines,
  removeLeadingMarkdownHeading,
  constants: {
    MAX_FILE_SIZE,
    MAX_DIFF_LENGTH,
    MAX_DIFF_LINES,
    MAX_CONTEXT_LINES,
    REQUEST_TIMEOUT,
    CONCURRENCY_LIMIT,
    MAX_FILES_TO_PROCESS,
    TRIGGER_LABEL
  }
};

