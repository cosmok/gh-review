const crypto = require('crypto');

function countTokens(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function truncateToLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n[... ${lines.length - maxLines} more lines ...]`;
}

function removeLeadingMarkdownHeading(text) {
  if (!text) return '';
  const noHeading = text.replace(/^\s*#{1,6}\s.*\n+/, '');
  const lines = noHeading.split('\n');
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^(\s*)/)[1].length);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map(line => line.slice(minIndent)).join('\n');
}

function diffAnchor(file) {
  return crypto.createHash('md5').update(file).digest('hex');
}

function linkLineNumbers(text, refs, owner, repo, prNumber) {
  if (!text || !Array.isArray(refs) || refs.length === 0) return text;
  let result = text;
  for (const { file, lines } of refs) {
    const anchor = diffAnchor(file);
    for (const line of lines) {
      const regex = new RegExp(`\\b[Ll]ine\\s+${line}\\b`, 'g');
      const link = `[line ${line}](https://github.com/${owner}/${repo}/pull/${prNumber}/files#diff-${anchor}R${line})`;
      result = result.replace(regex, link);
    }
  }
  return result;
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

function shouldPostInlineComment(comment) {
  if (!comment) return false;
  const c = comment.toLowerCase();
  const skipPhrases = [
    'no issues',
    'no issue',
    'no suggestions',
    'no suggestion',
    'no improvements',
    'looks good',
    'lgtm',
    'nothing to change',
    'nothing to improve',
    'no feedback',
    'good job',
    'no actionable',
    'no changes',
    'no further action'
  ];
  return !skipPhrases.some(p => c.includes(p));
}

function addSuggestionFormatting(comment) {
  if (!comment) return '';
  return comment.replace(/```(?:diff|patch)\n([\s\S]*?)```/g, (_match, code) => {
    const trimmed = code.trim();
    return '```suggestion\n' + trimmed + '\n```';
  });
}

module.exports = {
  countTokens,
  truncateToLines,
  removeLeadingMarkdownHeading,
  diffAnchor,
  linkLineNumbers,
  getSurroundingLines,
  shouldPostInlineComment,
   addSuggestionFormatting,
};

