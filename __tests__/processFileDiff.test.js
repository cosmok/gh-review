const nock = require('nock');
const { Octokit } = require('@octokit/rest');
const { processFileDiff } = require('../index');

// Mock Octokit
const octokit = new Octokit();

// Mock data
const mockOwner = 'test-owner';
const mockRepo = 'test-repo';
const mockPr = {
  number: 1,
  title: 'Test PR',
  body: 'This is a test PR',
  base: {
    sha: 'base-sha',
    ref: 'main'
  },
  head: {
    sha: 'head-sha',
    ref: 'feature-branch'
  }
};

describe('processFileDiff', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    nock.cleanAll();
  });

  it('should handle new files correctly', async () => {
    const mockFile = {
      filename: 'new-file.js',
      status: 'added',
      changes: 10,
      additions: 10,
      deletions: 0,
      patch: 'mock patch content'
    };

    // Mock the GitHub API response for getContent
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent(mockFile.filename)}`)
      .query(true)
      .reply(200, {
        content: Buffer.from('// New file content\nconst test = 123;\nconsole.log(test);').toString('base64'),
        size: 100
      });

    const result = await processFileDiff(octokit, mockOwner, mockRepo, mockFile, mockPr);

    expect(result).toBeDefined();
    expect(result.filename).toBe(mockFile.filename);
    expect(result.status).toBe('added');
    expect(result.context).toContain('## New File:');
    expect(result.context).toContain('New file content');
    expect(result.diff).toBe(mockFile.patch);
  });

  it('should handle deleted files correctly', async () => {
    const mockFile = {
      filename: 'deleted-file.js',
      status: 'removed',
      changes: 5,
      additions: 0,
      deletions: 5,
      patch: 'mock patch content'
    };

    // Mock the GitHub API response for getContent
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent(mockFile.filename)}`)
      .query(true)
      .reply(200, {
        content: Buffer.from('// This file will be deleted\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);').toString('base64'),
        size: 80
      });

    const result = await processFileDiff(octokit, mockOwner, mockRepo, mockFile, mockPr);

    expect(result).toBeDefined();
    expect(result.filename).toBe(mockFile.filename);
    expect(result.status).toBe('removed');
    expect(result.context).toContain('## Deleted File:');
    expect(result.context).toContain('This file will be deleted');
  });

  it('should handle modified files with context', async () => {
    const mockFile = {
      filename: 'modified-file.js',
      status: 'modified',
      changes: 3,
      additions: 2,
      deletions: 1,
      patch: `@@ -1,5 +1,6 @@
 // Example file
 function test() {
+  console.log('New line');
-  console.log('Old line');
   return true;
 }`
    };

    // Mock the GitHub API responses for getContent
    const mockContent = `// Example file
function test() {
  console.log('Old line');
  return true;
}`;

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent(mockFile.filename)}`)
      .query(q => q.ref === 'base-sha')
      .reply(200, {
        content: Buffer.from(mockContent).toString('base64'),
        size: 100
      });

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent(mockFile.filename)}`)
      .query(q => q.ref === 'head-sha')
      .reply(200, {
        content: Buffer.from(mockContent.replace('Old line', 'New line\n  console.log(\'New line\')')).toString('base64'),
        size: 110
      });

    const result = await processFileDiff(octokit, mockOwner, mockRepo, mockFile, mockPr);

    expect(result).toBeDefined();
    expect(result.filename).toBe(mockFile.filename);
    expect(result.status).toBe('modified');
    expect(result.context).toContain('## Modified File:');
    expect(result.context).toContain('Changed lines with context');
    expect(result.context).toContain('Base');
    expect(result.context).toContain('Head');
  });

  it('should handle binary files', async () => {
    const mockFile = {
      filename: 'image.png',
      status: 'modified',
      changes: 0,
      additions: 0,
      deletions: 0,
      patch: null
    };

    const result = await processFileDiff(octokit, mockOwner, mockRepo, mockFile, mockPr);

    expect(result).toBeDefined();
    expect(result.filename).toBe(mockFile.filename);
    expect(result.error).toBe('Binary file - skipped');
  });
});
