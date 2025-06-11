// Import required modules
require('dotenv').config();
const { Probot } = require('probot');
const { Octokit } = require('@octokit/rest');
const { VertexAI } = require('@google-cloud/vertexai');
const pLimit = require('p-limit');

// Configuration constants
const MAX_FILE_SIZE = 100000; // 100KB max file size
const MAX_DIFF_LENGTH = 8000; // Max diff length to process
const MAX_DIFF_LINES = 500; // Max lines of diff to process per file
const MAX_CONTEXT_LINES = 200; // Max lines of context to include
const REQUEST_TIMEOUT = 30000; // 30 seconds timeout for AI requests
const CONCURRENCY_LIMIT = 3; // Max concurrent file processing

// Verify required environment variables (This will run when module is loaded)
const requiredVars = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS'
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1); // This will exit if run in a context where env vars are not set (e.g. some tests)
  }
}

// Initialize rate limiter
const limit = pLimit(CONCURRENCY_LIMIT);

// Initialize Vertex AI (This will also run when module is loaded)
// If GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION are not set, this might error early.
let vertexAi;
try {
  vertexAi = new VertexAI({
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION,
  });
} catch (e) {
  console.error("Failed to initialize VertexAI, check GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION:", e);
  // Decide if process should exit or if this is recoverable/testable
}


// Initialize the AI model
const model = 'gemini-1.5-pro';

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
    const chat = vertexAi.preview.getGenerativeModel({ model, generationConfig });
    const fullPrompt = `# Code Review Task: ${filePath}\n\n## Context\n${truncatedContext || 'No additional context provided.'}\n\n## Changes\n\`\`\`diff\n${truncatedSnippet}\n\`\`\`\n\n## Instructions\n${prompt}\n\n## Guidelines\n- Be specific and reference line numbers from the diff\n- Only report issues you're certain about\n- Suggest concrete improvements when possible`;
    const result = await chat.generateContent({ contents: [{ role: 'user', parts: [{ text: fullPrompt }] }] });
    clearTimeout(timeoutId);
    return result.response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('AI analysis timed out for ' + filePath);
      return 'Analysis timed out. The diff might be too large or the service might be busy.';
    }
    console.error('Error in analyzeWithAI for ' + filePath + ':', error);
    return null;
  }
}

function truncateToLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n[... ${lines.length - maxLines} more lines ...]`;
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
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref, headers: { 'accept': 'application/vnd.github.v3.raw' } });
    if (data.size > MAX_FILE_SIZE) {
      console.log(`File ${path} is too large (${data.size} bytes), truncating content`);
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return content.substring(0, MAX_FILE_SIZE) + '\n[...truncated due to size...]';
    }
    let content = Buffer.from(data.content, 'base64').toString('utf-8');
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
    if (error.status === 404) console.log(`File not found: ${path} at ${ref}`);
    else console.error(`Error getting file content for ${path}:`, error.message);
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

async function processFileDiff(octokit, owner, repo, file, pr) {
  const startTime = Date.now();
  const fileInfo = { /* ... initial fields ... */
    filename: file.filename, status: file.status, changes: file.changes,
    additions: file.additions, deletions: file.deletions, error: null,
    processingTime: 0, diff: '', context: ''
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
    } else if (file.status === 'removed') {
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha, { startLine: 1, endLine: 100, contextLines: 0 });
      fileInfo.context = `## Deleted File: ${file.filename}\n\nOriginal file content (first 100 lines):\n\`\`\`\n${content}\n\`\`\``;
    } else if (file.status === 'modified' || file.status === 'renamed') {
      const changedLines = getChangedLineNumbers(diff);
      const baseContent = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha);
      const headContent = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      fileInfo.context = `## Modified File: ${file.filename}\n\n### Changed lines with context (10 lines before/after):\n\n#### Base (${pr.base.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(baseContent, changedLines, 10)}\n\`\`\`\n\n#### Head (${pr.head.sha.slice(0,7)}):\n\`\`\`\n${getSurroundingLines(headContent, changedLines, 10)}\n\`\`\``;
    }
    if (pr.body) fileInfo.context += `\n\n### PR Description/Context:\n> ${pr.body.replace(/\n/g, '\n> ')}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  } catch (error) {
    console.error(`Error processing diff for ${file.filename}:`, error);
    fileInfo.error = `Processing error: ${error.message}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  }
}

async function processWhatCommand(octokit, owner, repo, pr, files, dependencies) {
  try {
    const { data: diffData } = await octokit.pulls.get({
      owner, repo, pull_number: pr.number, mediaType: { format: 'diff' }, headers: { 'accept': 'application/vnd.github.v3.diff' }
    }).catch(error => { console.error('Error getting PR diff:', error); throw new Error('Failed to retrieve PR diff.'); });
    
    const prompt = `# PR Summary Request\n\n## PR Details\n- Title: ${pr.title}\n- Author: ${pr.user?.login || 'Unknown'}\n- Changed Files: ${files.length} files with ${files.reduce((a, f) => a + f.changes, 0)} changes\n\n## Instructions\nPlease provide a concise summary of the changes in this pull request.\nFocus on the main purpose and key changes. Be brief and to the point.\nHighlight any major architectural changes or potential impacts.`;
    const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '🤖 Analyzing changes...' });
    const analysis = await dependencies.analyzeWithAIDep(prompt, diffData.diff, 'PR Summary'); // Use diffData.diff
    if (analysis) {
      await octokit.issues.updateComment({ owner, repo, comment_id: comment.id, body: `## 📝 PR Summary\n\n${analysis}\n\n_Summary generated by AI - [Feedback?](https://github.com/your-org/feedback/issues)_` });
    }
  } catch (error) {
    console.error('Error in processWhatCommand:', error);
    await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: `❌ Error generating PR summary: ${error.message || 'Unknown error'}` });
  }
}

async function processReviewCommand(octokit, owner, repo, pr, files, dependencies) {
  const startTime = Date.now();
  let reviewComment;
  try {
    const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: '🔍 Starting AI code review... This may take a few minutes.' });
    reviewComment = comment;
    const filesToProcess = files.filter(file => {
      if (file.status === 'removed') return false;
      return !file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i);
    });
    const processFile = async (file) => {
      try {
        const fileDiff = await dependencies.processFileDiffDep(octokit, owner, repo, file, pr);
        if (!fileDiff || fileDiff.error) return { filename: file.filename, status: 'error', error: fileDiff?.error };
        const prompt = `# Code Review Request\n\n## File: ${file.filename} (${file.status})\nChanges: ${file.changes} (${file.additions}+ ${file.deletions}-)\n\n## Review Guidelines\n1. Focus on the changes shown in the diff\n2. Check for bugs, security issues, and performance concerns\n3. Suggest improvements for code quality and best practices\n4. Only report issues you're certain about\n5. Reference specific line numbers from the diff\n\n## Context\n${fileDiff.context ? truncateToLines(fileDiff.context, 100) : 'No context available'}\n\n## Changes\n\`\`\`diff\n${fileDiff.diff}\n\`\`\``;
        const analysis = await dependencies.analyzeWithAIDep(prompt, fileDiff.diff, file.filename, fileDiff.context);
        return { filename: file.filename, status: analysis ? 'reviewed' : 'error', analysis, error: analysis ? null : 'Failed to analyze file' };
      } catch (error) { console.error(`Error processing ${file.filename}:`, error); return { filename: file.filename, status: 'error', error: error.message }; }
    };
    const results = await Promise.all(filesToProcess.map(file => limit(() => processFile(file))));
    const successfulReviews = results.filter(r => r.status === 'reviewed' && r.analysis);
    const filesWithIssues = successfulReviews.filter(r => !r.analysis.toLowerCase().includes('no issues found'));
    const errors = results.filter(r => r.status === 'error');
    const processingTime = (Date.now() - startTime) / 1000;
    let reviewBody = `## 🔍 AI Code Review Summary\n\n✅ Processed ${successfulReviews.length} files in ${processingTime.toFixed(1)}s\n⚠️  Found potential issues in ${filesWithIssues.length} files\n❌ ${errors.length} files had errors\n\n`;
    if (filesWithIssues.length > 0) {
      reviewBody += `## 🚨 Files with Potential Issues\n\n`;
      for (const file of filesWithIssues) reviewBody += `### 📄 ${file.filename}\n${file.analysis}\n\n`;
    } else if (successfulReviews.length > 0) reviewBody += '🎉 No potential issues found in the reviewed files!\n\n';
    if (errors.length > 0) reviewBody += `## ⚠️ Processing Errors\n\nThe following files could not be processed:\n${errors.map(e => `- ${e.filename}: ${e.error || 'Unknown error'}`).join('\n')}\n\n`;
    reviewBody += '---\n🔍 This is an automated review powered by Google Vertex AI.\n⚠️ This is a best-effort review and may not catch all issues.\n🔍 Always perform your own thorough review before merging.\n⏱️ Total processing time: ' + processingTime.toFixed(1) + 's';
    await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: reviewBody });
  } catch (error) {
    console.error('Error in processReviewCommand:', error);
    try {
      const errorMessage = error.message || 'Unknown error occurred';
      const errorBody = `## ❌ Error During Review\n\nAn error occurred while processing your review request:\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nPlease try again later or contact support if the issue persists.`;
      if (reviewComment) await octokit.issues.updateComment({ owner, repo, comment_id: reviewComment.id, body: errorBody });
      else await octokit.issues.createComment({ owner, repo, issue_number: pr.number, body: errorBody });
    } catch (updateError) { console.error('Failed to post error comment:', updateError); }
  }
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

  // --- Event Handlers ---
  probot.on('issue_comment.created', async (context) => {
    const { comment, issue, repository } = context.payload;
    const { body } = comment;
    if (!body.startsWith('/what') && !body.startsWith('/review')) return;
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

      if (body.startsWith('/what')) {
        await processWhatCommand(octokitInstance, repoOwner, repoName, pr, files, dependencies);
      } else if (body.startsWith('/review')) {
        await processReviewCommand(octokitInstance, repoOwner, repoName, pr, files, dependencies);
      }
    } catch (error) {
      console.error('Error processing PR comment:', error);
      await octokitInstance.issues.createComment({ owner: repoOwner, repo: repoName, issue_number: prNumber, body: '❌ An error occurred while processing your request.' });
    }
  });

  probot.on('installation.created', async (context) => {
    const { installation, repositories = [] } = context.payload;
    console.log(`App installed on ${repositories.length} repositories`);
  });

  probot.onError((error) => {
    console.error('App error:', error);
  });

  return probot;
}

// Initialize the global app instance using the factory
const app = createProbotApp();
console.log('✅ Probot App created and event handlers registered.');


// Only start the server if this file is run directly
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.start().then(() => {
    console.log(`GitHub App is running on port ${port}`);
  }).catch(error => {
    console.error("Failed to start Probot app:", error);
    process.exit(1);
  });
}

// Export everything needed
module.exports = {
  app, // The global app instance
  createProbotApp, // The factory function
  processFileDiff,
  processWhatCommand,
  processReviewCommand,
  getFileContent,
  getChangedLineNumbers,
  getSurroundingLines,
  analyzeWithAI,
  truncateToLines,
  constants: {
    MAX_FILE_SIZE, MAX_DIFF_LENGTH, MAX_DIFF_LINES, MAX_CONTEXT_LINES, REQUEST_TIMEOUT, CONCURRENCY_LIMIT
  }
};

[end of index.js]
