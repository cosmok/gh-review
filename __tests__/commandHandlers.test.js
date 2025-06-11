const nock = require('nock');
const { Probot, ProbotOctokit } = require('probot');
const appModule = require('../index.js');

const {
  processReviewCommand,
  processWhatCommand,
  processFileDiff,
  analyzeWithAI
} = appModule;

// privateKey is now solely set in __tests__/setup.js via process.env.PRIVATE_KEY
// const validFakePrivateKey = `...`; // Removed

const issueCommentPayload = {
  action: 'created',
  issue: { number: 1, user: { login: 'test-user' }, pull_request: { url: 'http://example.com/pr/1' } },
  comment: { id: 12345, user: { login: 'test-user' }, body: '' },
  repository: { name: 'test-repo', owner: { login: 'test-owner' }, full_name: 'test-owner/test-repo' },
  installation: { id: 2 },
};

describe('Command Handlers', () => {
  let mockOctokit;

  const mockOwner = 'test-owner';
  const mockRepo = 'test-repo';
  const mockPr = {
    number: 1, title: 'Test PR', body: 'This is a test PR body.',
    base: { sha: 'base-sha', ref: 'main', user: { login: 'test-user' } },
    head: { sha: 'head-sha', ref: 'feature-branch', user: { login: 'test-user' } }
  };
  const globalMockFiles = [
    { filename: 'global_test.js', status: 'modified', changes: 3, additions: 2, deletions: 1, patch: '...' }
  ];

  beforeEach(() => {
    nock.disableNetConnect();
    mockOctokit = {
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 12345 } }),
        updateComment: jest.fn().mockResolvedValue({ data: {} }),
      },
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: { ...mockPr, diff: 'mock pr diff content' },
          headers: { 'content-type': 'application/vnd.github.v3.diff' }
        }),
        listFiles: jest.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from('// default mock file content').toString('base64'), encoding: 'base64', size: 100 }
        })
      },
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    jest.restoreAllMocks();
  });

  describe('/review command (direct call)', () => {
    const createMockFile = (filename, status = 'modified') => ({
      filename, status,
      changes: Math.floor(Math.random() * 10) + 1,
      additions: Math.floor(Math.random() * 5) + 1,
      deletions: Math.floor(Math.random() * 5),
      patch: 'mock patch data',
    });

    it('should process /review command successfully, injecting dependencies', async () => {
      const filesPayload = [
        createMockFile('file1.js'),
        createMockFile('file2.txt'),
        createMockFile('image.png'),
        createMockFile('file3.js', 'removed')
      ];

      const mockProcessFileDiffDep = jest.fn().mockImplementation(async (octokit, owner, repo, file, pr) => {
        return {
          filename: file.filename, status: file.status, changes: file.changes,
          additions: file.additions, deletions: file.deletions,
          diff: 'mocked diff for ' + file.filename,
          context: 'mocked context for ' + file.filename,
          error: null,
        };
      });
      const mockAnalyzeWithAIDep = jest.fn().mockResolvedValue('Detailed AI analysis for a file.');

      await processReviewCommand(
        mockOctokit, mockOwner, mockRepo, mockPr, filesPayload,
        { processFileDiffDep: mockProcessFileDiffDep, analyzeWithAIDep: mockAnalyzeWithAIDep }
      );

      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining('Starting AI code review...'),
      }));
      expect(mockOctokit.issues.updateComment).toHaveBeenCalledTimes(1);

      const updatedCommentBody = mockOctokit.issues.updateComment.mock.calls[0][0].body;

      const processableFiles = filesPayload.filter(file => {
        const isBinary = file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i);
        return file.status !== 'removed' && !isBinary;
      });

      expect(mockProcessFileDiffDep).toHaveBeenCalledTimes(processableFiles.length);
      expect(mockAnalyzeWithAIDep).toHaveBeenCalledTimes(processableFiles.length);

      for (const file of processableFiles) {
        expect(mockProcessFileDiffDep).toHaveBeenCalledWith(mockOctokit, mockOwner, mockRepo, file, mockPr);
        expect(mockAnalyzeWithAIDep).toHaveBeenCalledWith(
          expect.any(String),
          'mocked diff for ' + file.filename,
          file.filename,
          'mocked context for ' + file.filename
        );
        expect(updatedCommentBody).toContain('Detailed AI analysis for a file.');
      }
      if (processableFiles.length > 0) {
         expect(updatedCommentBody).toContain('Files with Potential Issues');
      } else {
         expect(updatedCommentBody).toContain('No potential issues found');
      }
    });
  });

  describe('/what command (direct call)', () => {
    it('should process /what command successfully, injecting dependency', async () => {
      const mockDiffResponseData = {
        ...mockPr,
        diff: 'diff --git a/file.js b/file.js\nindex 0000000..1111111 100644\n--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,1 @@\n-old line\n+new line'
      };
      mockOctokit.pulls.get.mockResolvedValue({
        data: mockDiffResponseData,
        headers: { 'content-type': 'application/vnd.github.v3.diff' }
      });

      const mockAnalyzeWithAI_what = jest.fn().mockResolvedValue('Specific AI summary for /what');

      await processWhatCommand(
        mockOctokit, mockOwner, mockRepo, mockPr, globalMockFiles,
        { analyzeWithAIDep: mockAnalyzeWithAI_what }
      );

      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
        body: '🤖 Analyzing changes...',
      }));
      expect(mockOctokit.issues.updateComment).toHaveBeenCalledTimes(1);
      const updatedCommentBody = mockOctokit.issues.updateComment.mock.calls[0][0].body;
      expect(updatedCommentBody).toContain('Specific AI summary for /what');

      expect(mockAnalyzeWithAI_what).toHaveBeenCalledTimes(1);
      expect(mockAnalyzeWithAI_what).toHaveBeenCalledWith(
        expect.stringContaining('# PR Summary Request'),
        mockDiffResponseData.diff,
        'PR Summary'
      );
    });
  });

  describe('Issue Comment Event via Probot', () => {
    let currentAppModuleForProbotTest; // Renamed to avoid confusion with top-level appModule
    let reviewCommandSpy;
    // let whatCommandSpy;

    beforeEach(() => {
      // process.env.PRIVATE_KEY is set in __tests__/setup.js
      // No need to set it here again if setup.js is guaranteed to run first and set it correctly.
      jest.resetModules();
      currentAppModuleForProbotTest = require('../index.js');

      reviewCommandSpy = jest.spyOn(currentAppModuleForProbotTest, 'processReviewCommand').mockResolvedValue(undefined);
      // whatCommandSpy = jest.spyOn(currentAppModuleForProbotTest, 'processWhatCommand').mockResolvedValue(undefined);
    });

    it('should trigger review for /review comment by calling the spied processReviewCommand', async () => {
      const eventPayload = JSON.parse(JSON.stringify(issueCommentPayload));
      eventPayload.comment.body = '/review';
      eventPayload.issue.pull_request = { url: 'https://api.github.com/repos/test-owner/test-repo/pulls/1' };
      eventPayload.repository.owner.login = mockOwner;
      eventPayload.repository.name = mockRepo;
      eventPayload.issue.number = mockPr.number;
      eventPayload.installation = { id: 2 };

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      const prNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/' + mockPr.number)
        .reply(200, { ...mockPr, number: mockPr.number, head: { sha: 'a' }, base: { sha: 'b' }, body: 'PR body text' });

      const filesPayload = [
        { filename: 'file.js', status: 'modified', changes: 1, additions: 1, deletions: 0, patch: '...' }
      ];
      const filesNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/' + mockPr.number + '/files')
        .reply(200, filesPayload);

      const initialCommentNock = nock('https://api.github.com')
        .post('/repos/' + mockOwner + '/' + mockRepo + '/issues/' + mockPr.number + '/comments', (body) => {
          return body.body.includes('Starting AI code review...');
        })
        .reply(200, { id: 12345 });

      await currentAppModuleForProbotTest.app.receive({ name: 'issue_comment', id: 'test-event-id', payload: eventPayload });

      expect(tokenNock.isDone()).toBe(true);
      expect(prNock.isDone()).toBe(true);
      expect(filesNock.isDone()).toBe(true);
      expect(initialCommentNock.isDone()).toBe(true);

      expect(reviewCommandSpy).toHaveBeenCalledTimes(1);
      expect(reviewCommandSpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        expect.objectContaining({ number: mockPr.number }),
        expect.arrayContaining([expect.objectContaining({ filename: 'file.js' })]),
        {
          processFileDiffDep: currentAppModuleForProbotTest.processFileDiff,
          analyzeWithAIDep: currentAppModuleForProbotTest.analyzeWithAI
        }
      );
    });
  });
});
