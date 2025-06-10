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

// Verify required environment variables
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
    process.exit(1);
  }
}

// Initialize rate limiter
const limit = pLimit(CONCURRENCY_LIMIT);

// Initialize Vertex AI
const vertexAi = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});

// Initialize the AI model
const model = 'gemini-1.5-pro';

// Initialize Probot
const app = new Probot({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  webhookSecret: process.env.WEBHOOK_SECRET
});

console.log('✅ All required environment variables are set');



// Function to analyze code with Vertex AI with better error handling and timeouts
async function analyzeWithAI(prompt, codeSnippet, filePath, context = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // Truncate large inputs
    const truncatedSnippet = truncateToLines(codeSnippet, MAX_DIFF_LINES);
    const truncatedContext = context ? truncateToLines(context, MAX_CONTEXT_LINES) : '';

    const generationConfig = {
      maxOutputTokens: 4096,
      temperature: 0.2,
      topP: 0.8,
      topK: 40,
    };

    const chat = vertexAi.preview.getGenerativeModel({
      model: model,
      generationConfig,
    });

    // Structure the prompt more effectively
    const fullPrompt = `# Code Review Task: ${filePath}\n\n` +
      `## Context\n${truncatedContext || 'No additional context provided.'}\n\n` +
      `## Changes\n\`\`\`diff\n${truncatedSnippet}\n\`\`\`\n\n` +
      `## Instructions\n${prompt}\n\n` +
      `## Guidelines\n` +
      `- Be specific and reference line numbers from the diff\n` +
      `- Only report issues you're certain about\n` +
      `- Suggest concrete improvements when possible`;

    const result = await chat.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: fullPrompt }],
        },
      ],
    });

    clearTimeout(timeoutId);
    return result.response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('AI analysis timed out');
      return 'Analysis timed out. The diff might be too large or the service might be busy.';
    }
    console.error('Error in analyzeWithAI:', error);
    return null;
  }
}

// Helper function to truncate text to a maximum number of lines
function truncateToLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + 
    `\n[... ${lines.length - maxLines} more lines ...]`;
}

// Helper function to get lines around specific line numbers
function getSurroundingLines(content, lineNumbers, contextLines = 10) {
  if (!content) return '';
  
  const lines = content.split('\n');
  const lineSet = new Set(lineNumbers);
  const includedLines = new Set();
  
  // Include the target lines and their surrounding context
  lineNumbers.forEach(lineNum => {
    const start = Math.max(1, lineNum - contextLines);
    const end = Math.min(lines.length, lineNum + contextLines);
    for (let i = start; i <= end; i++) {
      includedLines.add(i - 1); // Convert to 0-based index
    }
  });
  
  // Build the result with line numbers
  const result = [];
  let lastLine = -2;
  
  Array.from(includedLines).sort((a, b) => a - b).forEach(idx => {
    // Add ellipsis if there's a gap in line numbers
    if (idx > lastLine + 1 && lastLine !== -2) {
      result.push('...');
    }
    
    const lineNum = idx + 1; // Convert back to 1-based for display
    const lineContent = lines[idx] || '';
    const linePrefix = lineSet.has(lineNum) ? '> ' : '  ';
    result.push(`${linePrefix}${lineNum.toString().padStart(4)}: ${lineContent}`);
    lastLine = idx;
  });
  
  return result.join('\n');
}

// Function to safely get file content with size limits and error handling
async function getFileContent(octokit, owner, repo, path, ref, options = {}) {
  const { startLine, endLine, contextLines } = options;
  
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
      headers: {
        'accept': 'application/vnd.github.v3.raw'
      }
    });

    // If the file is too large, return a message instead of the content
    if (data.size > MAX_FILE_SIZE) {
      console.log(`File ${path} is too large (${data.size} bytes), truncating content`);
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return content.substring(0, MAX_FILE_SIZE) + '\n[...truncated due to size...]';
    }

    let content = Buffer.from(data.content, 'base64').toString('utf-8');
    
    // If specific lines are requested, extract them with context
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
      console.log(`File not found: ${path} at ${ref}`);
      return '[File not found or deleted]';
    }
    console.error(`Error getting file content for ${path}:`, error.message);
    return `[Error retrieving file: ${error.message}]`;
  }
}

// Function to extract line numbers from a diff
function getChangedLineNumbers(diff) {
  if (!diff) return [];
  
  const lineNumbers = [];
  const lines = diff.split('\n');
  let currentLine = 0;
  
  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Parse the line numbers from the diff header
      const match = line.match(/\+([0-9]+),?([0-9]*)/);
      if (match) {
        currentLine = parseInt(match[1], 10) - 1; // Convert to 0-based
      }
      continue;
    }
    
    // Only count added/modified lines (starts with '+' but not '+++')
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumbers.push(currentLine + 1); // Convert back to 1-based
    }
    
    // Increment line counter for all lines except removed lines
    if (!line.startsWith('-') || line.startsWith('---')) {
      currentLine++;
    }
  }
  
  return lineNumbers;
}

// Function to process a single file diff with context and error handling
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
    context: ''
  };

  try {
    // Skip binary files
    if (file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i)) {
      fileInfo.error = 'Binary file - skipped';
      return fileInfo;
    }

    // Get the diff for this file
    const diff = file.patch ? file.patch : '';
    fileInfo.diff = diff.length > MAX_DIFF_LENGTH 
      ? diff.substring(0, MAX_DIFF_LENGTH) + '\n[...truncated...]' 
      : diff;

    // Handle different file statuses
    if (file.status === 'added') {
      // For new files, get the entire file content (truncated if too large)
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      fileInfo.context = `## New File: ${file.filename}\n\n` +
                        `File content (truncated if large):\n\`\`\`\n${content}\n\`\`\``;
      
    } else if (file.status === 'removed') {
      // For deleted files, get the first 100 lines of the original file
      const content = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha, {
        startLine: 1,
        endLine: 100,
        contextLines: 0
      });
      fileInfo.context = `## Deleted File: ${file.filename}\n\n` +
                        `Original file content (first 100 lines):\n\`\`\`\n${content}\n\`\`\``;
      
    } else if (file.status === 'modified' || file.status === 'renamed') {
      // For modified files, get context around the changed lines
      const changedLines = getChangedLineNumbers(diff);
      const baseContent = await getFileContent(octokit, owner, repo, file.filename, pr.base.sha);
      const headContent = await getFileContent(octokit, owner, repo, file.filename, pr.head.sha);
      
      fileInfo.context = `## Modified File: ${file.filename}\n\n` +
                        `### Changed lines with context (10 lines before/after):\n\n` +
                        `#### Base (${pr.base.sha.slice(0, 7)}):\n\`\`\`\n` +
                        `${getSurroundingLines(baseContent, changedLines, 10)}\n\`\`\`\n\n` +
                        `#### Head (${pr.head.sha.slice(0, 7)}):\n\`\`\`\n` +
                        `${getSurroundingLines(headContent, changedLines, 10)}\n\`\`\``;
    }
    
    // Include PR comments if available
    if (pr.body) {
      fileInfo.context += `\n\n### PR Description/Context:\n> ${pr.body.replace(/\n/g, '\n> ')}`;
    }
    
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
    
  } catch (error) {
    console.error(`Error processing diff for ${file.filename}:`, error);
    fileInfo.error = `Processing error: ${error.message}`;
    fileInfo.processingTime = Date.now() - startTime;
    return fileInfo;
  }
}

// Handle pull request comments
app.on('issue_comment.created', async (context) => {
  const { comment, issue, repository } = context.payload;
  const { body } = comment;
  
  // Only process PR comments that start with /what or /review
  if (!body.startsWith('/what') && !body.startsWith('/review')) {
    return;
  }

  // Check if it's a PR (issues have pull_request: null)
  if (!issue.pull_request) {
    return;
  }

  const prNumber = issue.number;
  const { name: repoName, owner } = repository;
  const repoOwner = owner.login;

  // Initialize Octokit with installation access token
  const octokit = new Octokit({
    auth: `token ${await context.octokit.apps.createInstallationAccessToken({
      installation_id: context.payload.installation.id,
      repository_ids: [repository.id]
    }).then(({ data }) => data.token)}`
  });

  try {
    // Get PR details
    const { data: pr } = await octokit.pulls.get({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber
    });

    // Get the list of files changed in the PR
    const { data: files } = await octokit.pulls.listFiles({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber
    });

    // Process the command
    if (body.startsWith('/what')) {
      await processWhatCommand(octokit, repoOwner, repoName, pr, files);
    } else if (body.startsWith('/review')) {
      await processReviewCommand(octokit, repoOwner, repoName, pr, files);
    }
  } catch (error) {
    console.error('Error processing PR comment:', error);
    await octokit.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: prNumber,
      body: '❌ An error occurred while processing your request. Please try again later.'
    });
  }
});

// Process the /what command with rate limiting and better error handling
async function processWhatCommand(octokit, owner, repo, pr, files) {
  try {
    // Get the diff of the PR with error handling
    const { data: diff } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
      mediaType: { format: 'diff' },
      headers: {
        'accept': 'application/vnd.github.v3.diff'
      }
    }).catch(error => {
      console.error('Error getting PR diff:', error);
      throw new Error('Failed to retrieve PR diff. Please try again later.');
    });

    // Prepare a more structured prompt
    const prompt = `# PR Summary Request\n\n` +
      `## PR Details\n` +
      `- Title: ${pr.title}\n` +
      `- Author: ${pr.user?.login || 'Unknown'}\n` +
      `- Changed Files: ${files.length} files with ${files.reduce((a, f) => a + f.changes, 0)} changes\n\n` +
      `## Instructions\n` +
      `Please provide a concise summary of the changes in this pull request.\n` +
      `Focus on the main purpose and key changes. Be brief and to the point.\n` +
      `Highlight any major architectural changes or potential impacts.`;

    // Add a loading comment
    const { data: comment } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: '🤖 Analyzing changes...'
    });

    // Process with AI
    const analysis = await analyzeWithAI(prompt, diff, 'PR Summary');
    
    if (analysis) {
      // Update the comment with the analysis
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: comment.id,
        body: `## 📝 PR Summary\n\n${analysis}\n\n` +
              `_Summary generated by AI - [Feedback?](https://github.com/your-org/feedback/issues)_`
      });
    }
  } catch (error) {
    console.error('Error in processWhatCommand:', error);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: `❌ Error generating PR summary: ${error.message || 'Unknown error'}`
    });
  }
}

// Process the /review command with rate limiting and better error handling
async function processReviewCommand(octokit, owner, repo, pr, files) {
  const startTime = Date.now();
  let reviewComment;

  try {
    // Create an in-progress comment
    const { data: comment } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: '🔍 Starting AI code review... This may take a few minutes.'
    });
    reviewComment = comment;

    // Filter out binary and removed files
    const filesToProcess = files.filter(file => {
      if (file.status === 'removed') return false;
      return !file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i);
    });

    // Process files with rate limiting
    const processFile = async (file) => {
      try {
        const fileDiff = await processFileDiff(octokit, owner, repo, file, pr);
        if (!fileDiff || fileDiff.error) {
          return { filename: file.filename, status: 'error', error: fileDiff?.error };
        }

        const prompt = `# Code Review Request\n\n` +
          `## File: ${file.filename} (${file.status})\n` +
          `Changes: ${file.changes} (${file.additions}+ ${file.deletions}-)\n\n` +
          `## Review Guidelines\n` +
          `1. Focus on the changes shown in the diff\n` +
          `2. Check for bugs, security issues, and performance concerns\n` +
          `3. Suggest improvements for code quality and best practices\n` +
          `4. Only report issues you're certain about\n` +
          `5. Reference specific line numbers from the diff\n\n` +
          `## Context\n${fileDiff.context ? truncateToLines(fileDiff.context, 100) : 'No context available'}\n\n` +
          `## Changes\n\`\`\`diff\n${fileDiff.diff}\n\`\`\``;

        const analysis = await analyzeWithAI(prompt, fileDiff.diff, file.filename, fileDiff.context);
        
        return {
          filename: file.filename,
          status: analysis ? 'reviewed' : 'error',
          analysis,
          error: analysis ? null : 'Failed to analyze file'
        };
      } catch (error) {
        console.error(`Error processing ${file.filename}:`, error);
        return { filename: file.filename, status: 'error', error: error.message };
      }
    };

    // Process files in parallel with concurrency limit
    const processQueue = filesToProcess.map(file => limit(() => processFile(file)));
    const results = await Promise.all(processQueue);

    // Generate review summary
    const successfulReviews = results.filter(r => r.status === 'reviewed' && r.analysis);
    const filesWithIssues = successfulReviews.filter(r => !r.analysis.toLowerCase().includes('no issues found'));
    const errors = results.filter(r => r.status === 'error');
    const processingTime = (Date.now() - startTime) / 1000;

    // Build review body
    let reviewBody = `## 🔍 AI Code Review Summary\n\n` +
      `✅ Processed ${successfulReviews.length} files in ${processingTime.toFixed(1)}s\n` +
      `⚠️  Found potential issues in ${filesWithIssues.length} files\n` +
      `❌ ${errors.length} files had errors\n\n`;

    // Add sections for files with issues
    if (filesWithIssues.length > 0) {
      reviewBody += `## 🚨 Files with Potential Issues\n\n`;
      for (const file of filesWithIssues) {
        reviewBody += `### 📄 ${file.filename}\n${file.analysis}\n\n`;
      }
    } else if (successfulReviews.length > 0) {
      reviewBody += '🎉 No potential issues found in the reviewed files!\n\n';
    }

    // Add error details if any
    if (errors.length > 0) {
      reviewBody += `## ⚠️ Processing Errors\n\n` +
        `The following files could not be processed:\n` +
        errors.map(e => `- ${e.filename}: ${e.error || 'Unknown error'}`).join('\n') +
        '\n\n';
    }

    // Add footer
    reviewBody += '---\n' +
      '🔍 This is an automated review powered by Google Vertex AI.\n' +
      '⚠️ This is a best-effort review and may not catch all issues.\n' +
      '🔍 Always perform your own thorough review before merging.\n' +
      `⏱️ Total processing time: ${processingTime.toFixed(1)}s`;

    // Update the comment with the final review
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: reviewComment.id,
      body: reviewBody
    });

  } catch (error) {
    console.error('Error in processReviewCommand:', error);
    try {
      const errorMessage = error.message || 'Unknown error occurred';
      const errorBody = `## ❌ Error During Review\n\n` +
        `An error occurred while processing your review request:\n\n` +
        `\`\`\`\n${errorMessage}\n\`\`\`\n\n` +
        `Please try again later or contact support if the issue persists.`;
      
      if (reviewComment) {
        await octokit.issues.updateComment({
          owner,
          repo,
          comment_id: reviewComment.id,
          body: errorBody
        });
      } else {
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: errorBody
        });
      }
    } catch (updateError) {
      console.error('Failed to post error comment:', updateError);
    }
  }
}

// Handle installation events
app.on('installation.created', async (context) => {
  const { installation, repositories = [] } = context.payload;
  console.log(`App installed on ${repositories.length} repositories`);
});

// Handle errors
app.onError((error) => {
  console.error('App error:', error);
});

// Only start the server if this file is run directly (not required/included)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.start().then(() => {
    console.log(`GitHub App is running on port ${port}`);
  });
}

// Export everything needed for testing
module.exports = {
  // Core app
  app,
  
  // Main functions
  processFileDiff,
  processWhatCommand,
  processReviewCommand,
  
  // Helper functions
  getFileContent,
  getChangedLineNumbers,
  getSurroundingLines,
  analyzeWithAI,
  truncateToLines,
  
  // Constants for testing
  constants: {
    MAX_FILE_SIZE,
    MAX_DIFF_LENGTH,
    MAX_DIFF_LINES,
    MAX_CONTEXT_LINES,
    REQUEST_TIMEOUT,
    CONCURRENCY_LIMIT
  }
};
