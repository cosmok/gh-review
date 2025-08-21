const nock = require('nock');
const { Probot, ProbotOctokit } = require('probot');
const appModule = require('../index.js');

const {
  processReviewCommand,
  processWhatCommand,
  processFileDiff,
  analyzeWithAI,
  processReviewCommentReply,
  processAskCommand
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

const prLabeledPayload = {
  action: 'labeled',
  pull_request: { number: 1 },
  repository: { name: 'test-repo', owner: { login: 'test-owner' }, full_name: 'test-owner/test-repo' },
  installation: { id: 2 },
  label: { name: 'ai-review' },
};

const reviewCommentPayload = {
  action: 'created',
  pull_request: { number: 1 },
  repository: { name: 'test-repo', owner: { login: 'test-owner' }, full_name: 'test-owner/test-repo' },
  installation: { id: 2 },
  comment: {
    id: 10,
    body: '',
    in_reply_to_id: 5,
    path: 'file.js',
    diff_hunk: '@@ line @@\n+code'
  }
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
        listCommits: jest.fn().mockResolvedValue({ data: [ { commit: { message: 'test commit' } } ] }),
      },
      repos: {
        getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from('// default mock file content').toString('base64'), encoding: 'base64', size: 100 }
        })
      },
      request: jest.fn().mockResolvedValue({ data: 'mock pr diff content' }),
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
      expect(mockAnalyzeWithAIDep).toHaveBeenCalledTimes(processableFiles.length + 2);

      for (const file of processableFiles) {
        expect(mockProcessFileDiffDep).toHaveBeenCalledWith(mockOctokit, mockOwner, mockRepo, file, mockPr, expect.any(Object));
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

    it('merges similar line comments using AI', async () => {
      mockOctokit.pulls.createReviewComment = jest.fn().mockResolvedValue({});
      const file = createMockFile('merge.js');
      const filesPayload = [file];

      const mockProcessFileDiffDep = jest.fn().mockResolvedValue({
        filename: file.filename,
        status: file.status,
        diff: 'diff',
        context: 'ctx',
        changedLines: [3, 4],
        headContent: 'code',
        error: null,
      });

      const mockAnalyzeWithAIDep = jest.fn()
        .mockResolvedValueOnce('manager plan')
        .mockResolvedValueOnce('file analysis')
        .mockResolvedValueOnce('LINES: 3,4\nCOMMENT: combined\nEND_COMMENT')
        .mockResolvedValueOnce('final summary');

      await processReviewCommand(
        mockOctokit,
        mockOwner,
        mockRepo,
        mockPr,
        filesPayload,
        { processFileDiffDep: mockProcessFileDiffDep, analyzeWithAIDep: mockAnalyzeWithAIDep }
      );

      expect(mockAnalyzeWithAIDep.mock.calls[4][0]).toMatch(/Merge Line Comments/);
      expect(mockOctokit.pulls.createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ path: file.filename, line: 3, body: expect.stringContaining('combined') })
      );
      const updatedBody = mockOctokit.issues.updateComment.mock.calls[0][0].body;
      expect(updatedBody).toContain('[L3](');
    });

    it('skips inline comments when no suggestions are returned', async () => {
      mockOctokit.pulls.createReviewComment = jest.fn().mockResolvedValue({});
      const file = createMockFile('clean.js');
      const filesPayload = [file];

      const mockProcessFileDiffDep = jest.fn().mockResolvedValue({
        filename: file.filename,
        status: file.status,
        diff: 'diff',
        context: 'ctx',
        changedLines: [1, 2],
        headContent: 'code',
        error: null,
      });

      const mockAnalyzeWithAIDep = jest.fn().mockImplementation((prompt) => {
        if (/Merge Line Comments/.test(prompt)) {
          return Promise.resolve('LINES: 1,2\nCOMMENT: No issues found\nEND_COMMENT');
        }
        return Promise.resolve('analysis');
      });

      await processReviewCommand(
        mockOctokit,
        mockOwner,
        mockRepo,
        mockPr,
        filesPayload,
        { processFileDiffDep: mockProcessFileDiffDep, analyzeWithAIDep: mockAnalyzeWithAIDep }
      );

      expect(mockOctokit.pulls.createReviewComment).not.toHaveBeenCalled();
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

    it('should handle /what when pulls.get returns a string diff', async () => {
      const diffString = 'diff --git a/app.js b/app.js\n@@ -1 +1 @@\n-console.log("old")\n+console.log("new")';
      mockOctokit.pulls.get.mockResolvedValue({ data: diffString });

      const mockAnalyze = jest.fn().mockResolvedValue('String diff summary');

      await processWhatCommand(
        mockOctokit,
        mockOwner,
        mockRepo,
        mockPr,
        globalMockFiles,
        { analyzeWithAIDep: mockAnalyze }
      );

      expect(mockAnalyze).toHaveBeenCalledWith(
        expect.stringContaining('# PR Summary Request'),
        diffString,
        'PR Summary'
      );
    });

    it('falls back to octokit.request when diff is missing', async () => {
      mockOctokit.pulls.get.mockResolvedValue({ data: mockPr });
      mockOctokit.request.mockResolvedValue({ data: 'fallback diff' });

      const mockAnalyze = jest.fn().mockResolvedValue('Fallback diff summary');

      await processWhatCommand(
        mockOctokit,
        mockOwner,
        mockRepo,
        mockPr,
        globalMockFiles,
        { analyzeWithAIDep: mockAnalyze }
      );

      expect(mockOctokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        expect.objectContaining({
          owner: mockOwner,
          repo: mockRepo,
          pull_number: mockPr.number,
        })
      );
      expect(mockAnalyze).toHaveBeenCalledWith(
        expect.stringContaining('# PR Summary Request'),
        'fallback diff',
        'PR Summary'
      );
    });
  });

  describe('Issue Comment Event via Probot', () => {
    let currentAppModuleForProbotTest; // Renamed to avoid confusion with top-level appModule
    let reviewCommandSpy;
    let whatCommandSpy;

    beforeEach(() => {
      // process.env.PRIVATE_KEY is set in __tests__/setup.js
      // No need to set it here again if setup.js is guaranteed to run first and set it correctly.
      jest.resetModules();
      currentAppModuleForProbotTest = require('../index.js');

      reviewCommandSpy = jest.spyOn(currentAppModuleForProbotTest, 'processReviewCommand').mockResolvedValue(undefined);
      whatCommandSpy = jest.spyOn(currentAppModuleForProbotTest, 'processWhatCommand').mockResolvedValue('mock summary');
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

      expect(whatCommandSpy).toHaveBeenCalledTimes(1);
      expect(reviewCommandSpy).toHaveBeenCalledTimes(1);
      expect(reviewCommandSpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        expect.objectContaining({ number: mockPr.number }),
        expect.arrayContaining([expect.objectContaining({ filename: 'file.js' })]),
        expect.objectContaining({
          processFileDiffDep: currentAppModuleForProbotTest.processFileDiff,
          analyzeWithAIDep: currentAppModuleForProbotTest.analyzeWithAI,
          initialComment: expect.any(Object),
          logContext: expect.objectContaining({ requestId: expect.any(String) })
        }),
        expect.any(String)
      );
  });
  });

  describe('Label Event via Probot', () => {
    let currentAppModuleForLabelTest;
    let reviewCommandSpy;
    let whatCommandSpy;

    beforeEach(() => {
      process.env.ENABLE_LABEL_EVENT = 'true';
      process.env.TRIGGER_LABEL = 'ai-review';
      jest.resetModules();
      currentAppModuleForLabelTest = require('../index.js');
      reviewCommandSpy = jest.spyOn(currentAppModuleForLabelTest, 'processReviewCommand').mockResolvedValue(undefined);
      whatCommandSpy = jest.spyOn(currentAppModuleForLabelTest, 'processWhatCommand').mockResolvedValue('mock summary');
    });

    afterEach(() => {
      delete process.env.ENABLE_LABEL_EVENT;
      delete process.env.TRIGGER_LABEL;
    });

    it('triggers review when the configured label is added', async () => {
      const labelPayload = {
        action: 'labeled',
        label: { name: 'ai-review' },
        pull_request: { number: 1, head: { sha: 'a' }, base: { sha: 'b' }, body: 'PR body text' },
        repository: { name: mockRepo, owner: { login: mockOwner } },
        installation: { id: 2 }
      };

      const prNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/1')
        .reply(200, { ...mockPr });

      const filesPayload = [
        { filename: 'file.js', status: 'modified', changes: 1, additions: 1, deletions: 0, patch: '...' }
      ];
      const filesNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/1/files')
        .reply(200, filesPayload);

      const initialCommentNock = nock('https://api.github.com')
        .post('/repos/' + mockOwner + '/' + mockRepo + '/issues/1/comments')
        .reply(200, { id: 12345 });

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      await currentAppModuleForLabelTest.app.receive({ name: 'pull_request', id: 'test-event-id', payload: labelPayload });

      expect(tokenNock.isDone()).toBe(true);
      expect(prNock.isDone()).toBe(true);
      expect(filesNock.isDone()).toBe(true);
      expect(initialCommentNock.isDone()).toBe(true);

      expect(whatCommandSpy).toHaveBeenCalledTimes(1);
      expect(reviewCommandSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Pull Request Label Event via Probot', () => {
    let currentApp;
    let reviewSpy;
    let whatSpy;

    beforeEach(() => {
      process.env.ENABLE_LABEL_EVENT = 'true';
      process.env.TRIGGER_LABEL = 'ai-review';
      jest.resetModules();
      currentApp = require('../index.js');
      reviewSpy = jest.spyOn(currentApp, 'processReviewCommand').mockResolvedValue(undefined);
      whatSpy = jest.spyOn(currentApp, 'processWhatCommand').mockResolvedValue('mock summary');
    });

    afterEach(() => {
      delete process.env.ENABLE_LABEL_EVENT;
      delete process.env.TRIGGER_LABEL;
    });

    it('triggers review when label matches', async () => {
      const eventPayload = JSON.parse(JSON.stringify(prLabeledPayload));
      eventPayload.pull_request.number = mockPr.number;
      eventPayload.repository.owner.login = mockOwner;
      eventPayload.repository.name = mockRepo;
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
        .post('/repos/' + mockOwner + '/' + mockRepo + '/issues/' + mockPr.number + '/comments')
        .reply(200, { id: 12345 });

      await currentApp.app.receive({ name: 'pull_request', id: 'test-event-id', payload: eventPayload });

      expect(tokenNock.isDone()).toBe(true);
      expect(prNock.isDone()).toBe(true);
      expect(filesNock.isDone()).toBe(true);
      expect(initialCommentNock.isDone()).toBe(true);
      expect(whatSpy).toHaveBeenCalledTimes(1);
      expect(reviewSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Review Comment Event via Probot', () => {
    let currentApp;
    let replySpy;

    beforeEach(() => {
      jest.resetModules();
      currentApp = require('../index.js');
      replySpy = jest.spyOn(currentApp, 'processReviewCommentReply').mockResolvedValue(undefined);
    });

    it('triggers reply when /review is used in a review comment', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/review please';
      payload.comment.id = 123;

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      const parentNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/comments/5')
        .reply(200, { id: 5, body: 'orig', diff_hunk: '@@' });

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(tokenNock.isDone()).toBe(true);
      expect(parentNock.isDone()).toBe(true);
      expect(replySpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        1,
        expect.objectContaining({ id: 123 }),
        expect.objectContaining({ id: 5 }),
        'please'
      );
    });

    it('handles /review with no extra text', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/review';
      payload.comment.id = 321;

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      const parentNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/comments/5')
        .reply(200, { id: 5, body: 'orig', diff_hunk: '@@' });

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(tokenNock.isDone()).toBe(true);
      expect(parentNock.isDone()).toBe(true);
      expect(replySpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        1,
        expect.objectContaining({ id: 321 }),
        expect.objectContaining({ id: 5 }),
        ''
      );
    });

    it('does not trigger on case mismatch', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/Review please';

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(replySpy).not.toHaveBeenCalled();
    });

    it('parses additional text with multiple commands', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/review please /review again';
      payload.comment.id = 456;

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      const parentNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/comments/5')
        .reply(200, { id: 5, body: 'orig', diff_hunk: '@@' });

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(tokenNock.isDone()).toBe(true);
      expect(parentNock.isDone()).toBe(true);
      expect(replySpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        1,
        expect.objectContaining({ id: 456 }),
        expect.objectContaining({ id: 5 }),
        'please /review again'
      );
    });

    it('handles errors when parent comment fetch fails', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/review fail';

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      const parentNock = nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/comments/5')
        .reply(500);

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(tokenNock.isDone()).toBe(true);
      expect(parentNock.isDone()).toBe(true);
      expect(replySpy).not.toHaveBeenCalled();
    });

    it('responds to /ask on a top-level review comment', async () => {
      const payload = JSON.parse(JSON.stringify(reviewCommentPayload));
      payload.comment.body = '/ask what?';
      payload.comment.id = 777;
      delete payload.comment.in_reply_to_id;

      const tokenNock = nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-token' });

      await currentApp.app.receive({ name: 'pull_request_review_comment', id: 'test-event-id', payload });

      expect(tokenNock.isDone()).toBe(true);
      expect(replySpy).toHaveBeenCalledWith(
        expect.any(Object),
        mockOwner,
        mockRepo,
        1,
        expect.objectContaining({ id: 777 }),
        expect.objectContaining({ id: 777 }),
        'what?'
      );
    });
  });

  describe('processReviewCommentReply function', () => {
    it('posts AI reply using parent comment id', async () => {
      const mockOcto = {
        pulls: {
          createReplyForReviewComment: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn().mockResolvedValue({ data: [] })
        }
      };
      const comment = { id: 10, diff_hunk: '@@', path: 'file.js' };
      const parent = { id: 5, body: 'hello', diff_hunk: '@@' };
      await processReviewCommentReply(mockOcto, 'o', 'r', 1, comment, parent, 'hi');
      expect(mockOcto.pulls.createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'o',
        repo: 'r',
        pull_number: 1,
        comment_id: 5,
        body: 'Mock AI response'
      }));
    });

    it('sends error reply when posting fails', async () => {
      const mockOcto = { pulls: { createReplyForReviewComment: jest.fn(), listReviewComments: jest.fn().mockResolvedValue({ data: [] }) } };
      mockOcto.pulls.createReplyForReviewComment
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({});
      const comment = { id: 11, diff_hunk: '', path: '' };
      const parent = { id: 6, body: '' };
      await processReviewCommentReply(mockOcto, 'o', 'r', 2, comment, parent);
      expect(mockOcto.pulls.createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({
        comment_id: 6,
        body: expect.stringContaining('Error processing review request')
      }));
    });

    it('validates required parameters', async () => {
      await expect(processReviewCommentReply(null, 'o', 'r', 1, {}, {})).rejects.toThrow('Missing required parameters');
    });
    it('includes thread context when generating reply', async () => {
      const threadComments = [
        { id: 5, body: 'root', user: { login: 'alice' } },
        { id: 6, body: 'first reply', in_reply_to_id: 5, user: { login: 'bob' } },
        { id: 10, body: '/ask second?', in_reply_to_id: 5, user: { login: 'carol' } }
      ];
      const mockOcto = {
        pulls: {
          createReplyForReviewComment: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn().mockResolvedValue({ data: threadComments })
        }
      };
      const comment = { id: 10, diff_hunk: '', path: 'f.js' };
      const parent = { id: 5, body: 'root', diff_hunk: '', path: 'f.js' };
      await processReviewCommentReply(mockOcto, 'o', 'r', 1, comment, parent, 'second?');
      expect(mockOcto.pulls.listReviewComments).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 1, per_page: 100 }));
      expect(mockOcto.pulls.createReplyForReviewComment).toHaveBeenCalled();
    });
  });

  describe('processAskCommand function', () => {
    it('posts answer to question', async () => {
      const mockOcto = {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { diff: 'diff data' } }),
          listCommits: jest.fn().mockResolvedValue({ data: [ { commit: { message: 'cm' } } ] })
        },
        issues: { createComment: jest.fn().mockResolvedValue({}) }
      };
      const analyze = jest.fn().mockResolvedValue('answer');
      const pr = { number: 1 };
      await processAskCommand(mockOcto, 'o', 'r', pr, [], 'why?', { analyzeWithAIDep: analyze, thread: 'alice: hi' });
      expect(analyze).toHaveBeenCalledWith(expect.any(String), 'diff data', 'PR Question', expect.stringContaining('alice: hi'));
      expect(analyze).toHaveBeenCalledWith(expect.any(String), 'diff data', 'PR Question', expect.stringContaining('cm'));
      expect(mockOcto.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'answer' }));
    });
  });
});
