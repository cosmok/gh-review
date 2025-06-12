const nock = require('nock');
const { Probot, ProbotOctokit } = require('probot');
// app will be imported after jest.mock
// const app = require('../index.js');

// processReviewCommand and processWhatCommand are imported after jest.mock

const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nFAKE_KEY\n-----END RSA PRIVATE KEY-----';
const issueCommentPayload = {
  action: 'created',
  issue: { number: 1, user: { login: 'test-user' }, pull_request: { url: 'http://example.com/pr/1' } },
  comment: { id: 12345, user: { login: 'test-user' }, body: '' },
  repository: { name: 'test-repo', owner: { login: 'test-owner' }, full_name: 'test-owner/test-repo' },
  installation: { id: 2 },
};

const MOCKED_DIFF_CONTENT_PREFIX = '### Mocked Diff Content for ';
const MOCKED_CONTEXT_CONTENT_PREFIX = '### Mocked Context Content for ';
const AI_ANALYSIS_MARKER_PREFIX = 'SPECIAL_AI_ANALYSIS_FOR_';

jest.mock('../index.js', () => {
  const originalModule = jest.requireActual('../index.js'); // This is likely an object

  // Attempt to find the actual Probot app function. Common patterns:
  // 1. Default export (ES6 module transpiled)
  // 2. A property named 'app' or 'probotApp'
  // 3. The module itself if it was `module.exports = (app) => {}` and also had properties.
  let actualAppFunction = null;
  if (typeof originalModule === 'function') {
    actualAppFunction = originalModule;
  } else if (originalModule && typeof originalModule.default === 'function') {
    actualAppFunction = originalModule.default;
  } else if (originalModule && typeof originalModule.app === 'function') { // A guess
    actualAppFunction = originalModule.app;
  } else {
    // If still not found, the test will fail later, but this mock needs to return something.
    // The error seen previously indicates originalModule itself wasn't a function.
    console.error('[TEST_DEBUG] Could not identify the actual Probot app function in originalModule.');
  }

  const appFnWithMocks = (app) => {
    if (actualAppFunction) {
      actualAppFunction(app);
    } else {
      // This was the error path hit before if originalModule was not a function.
      // Now, if actualAppFunction is not found, Probot loading will fail.
      // This is better than the mock itself throwing.
    }
  };

  // Copy all properties from originalModule to appFnWithMocks
  // This ensures that helper functions like processReviewCommand are on appFnWithMocks
  // if they were exported alongside the main app function (e.g. module.exports.helper = helper)
  // or if originalModule was an object with all exports.
  for (const key in originalModule) {
    if (Object.prototype.hasOwnProperty.call(originalModule, key)) {
      if (key !== 'default') { // Avoid double-copying if default was the app function
         appFnWithMocks[key] = originalModule[key];
      }
    }
  }
   // If actualAppFunction was originalModule.default, ensure other named exports from originalModule are also on appFnWithMocks
  if (originalModule && originalModule.default && actualAppFunction === originalModule.default) {
    for (const key in originalModule) {
        if (key !== 'default' && Object.prototype.hasOwnProperty.call(originalModule, key)) {
            appFnWithMocks[key] = originalModule[key];
        }
    }
  }


  // Now, override specific functions with mocks ON appFnWithMocks
  appFnWithMocks.processFileDiff = jest.fn(async (octokit, owner, repo, file, pr) => {
    return {
      filename: file.filename,
      status: file.status,
      changes: file.changes,
      additions: file.additions,
      deletions: file.deletions,
      diff: MOCKED_DIFF_CONTENT_PREFIX + '_' + file.filename,
      context: MOCKED_CONTEXT_CONTENT_PREFIX + '_' + file.filename,
      error: null,
      processingTime: 10,
    };
  });

  appFnWithMocks.analyzeWithAI = jest.fn(async (prompt, codeSnippet, filePath, context) => {
    if (codeSnippet === (MOCKED_DIFF_CONTENT_PREFIX + '_' + filePath) &&
        context === (MOCKED_CONTEXT_CONTENT_PREFIX + '_' + filePath)) {
      return AI_ANALYSIS_MARKER_PREFIX + filePath;
    }
    return 'Generic AI analysis for ' + filePath;
  });

  // If originalModule was an object and app function was originalModule.default,
  // the factory should return an object that has 'default' as the appFnWithMocks
  // and other exports correctly structured.
  // Given the previous error, it's safer to assume originalModule is an object.
  // The Probot class expects appFn to be a function.
  // So, the mock must return the app function primarily.
  // If index.js uses `export default appFunction; export const util1 = ...;`, then `originalModule` is `{ default: appFunction, util1: ...}`.
  // `probot.load(app)` expects `app` to be `appFunction`.
  // `const { util1 } = require('./index.js')` expects `util1` to be on the module.

  if (originalModule && originalModule.default && actualAppFunction === originalModule.default) {
    return {
      ...originalModule, // Spread original named exports
      default: appFnWithMocks, // Probot will load this
      processFileDiff: appFnWithMocks.processFileDiff, // Ensure these are explicitly on the returned object
      analyzeWithAI: appFnWithMocks.analyzeWithAI,
      // processReviewCommand etc. will be from originalModule spread
       __esModule: true,
    };
  }

  // If originalModule was `module.exports = appFn` and `appFn.helper = ...`
  // then appFnWithMocks should be returned directly.
  return appFnWithMocks;
});

// Import after jest.mock.
// If index.js has a default export for the app function:
// import appForProbotLoad from '../index.js'; // This would be appFnWithMocks
// import { processReviewCommand, processWhatCommand, processFileDiff as mockedProcessFileDiff, analyzeWithAI as mockedAnalyzeWithAI } from '../index.js';

// If index.js is module.exports = appFn; appFn.processReviewCommand = ...
const appModule = require('../index.js'); // This should be appFnWithMocks
const appForProbotLoad = (typeof appModule.default === 'function') ? appModule.default : appModule; // Handle both cases

const {
  processReviewCommand,
  processWhatCommand,
  processFileDiff: mockedProcessFileDiff,
  analyzeWithAI: mockedAnalyzeWithAI
} = appModule; // These should be the correct versions (original or mocked)


describe('Command Handlers', () => {
  let probot;
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
    probot = new Probot({
      appId: 123, privateKey,
      Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
    });
    probot.load(appForProbotLoad);

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
      apps: {
        createInstallationAccessToken: jest.fn().mockResolvedValue({ data: { token: 'test-installation-token' } })
      }
    };
    jest.clearAllMocks();
    mockOctokit.issues.createComment.mockResolvedValue({ data: { id: 12345 } });
    mockOctokit.issues.updateComment.mockResolvedValue({ data: {} });
    mockOctokit.pulls.get.mockResolvedValue({
        data: { ...mockPr, diff: 'mock pr diff content', head: mockPr.head, base: mockPr.base, user: mockPr.head.user },
        headers: { 'content-type': 'application/vnd.github.v3.diff' }
    });
    mockOctokit.pulls.listFiles.mockResolvedValue({ data: [] });
    mockOctokit.apps.createInstallationAccessToken.mockResolvedValue({ data: { token: 'test-installation-token' } });

    if (mockedProcessFileDiff && typeof mockedProcessFileDiff.mockClear === 'function') {
      mockedProcessFileDiff.mockClear();
    }
    if (mockedAnalyzeWithAI && typeof mockedAnalyzeWithAI.mockClear === 'function') {
      mockedAnalyzeWithAI.mockClear();
    }
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('/review command (direct call)', () => {
    it('should process /review command successfully, using mocked processFileDiff and analyzeWithAI', async () => {
      const filesPayload = [
        { filename: 'file1.js', status: 'modified', changes: 10, additions: 5, deletions: 5, patch: 'diff for file1...' },
        { filename: 'file2.txt', status: 'added', changes: 5, additions: 5, deletions: 0, patch: 'diff for file2...' },
        { filename: 'image.png', status: 'added', changes: 1, additions: 1, deletions: 0, patch: '...' },
        { filename: 'file3.js', status: 'removed', changes: 1, additions: 0, deletions: 1, patch: '...' }
      ];
      await processReviewCommand(mockOctokit, mockOwner, mockRepo, mockPr, filesPayload);
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining('Starting AI code review...'),
      }));
      expect(mockOctokit.issues.updateComment).toHaveBeenCalledTimes(1);
      const updatedCommentBody = mockOctokit.issues.updateComment.mock.calls[0][0].body;
      const processableFiles = filesPayload.filter(file => {
        const isBinary = file.filename.match(/\.(png|jpg|jpeg|gif|ico|svg|pdf|zip|tar\.gz|tgz|gz|7z|rar|exe|dll|so|a|o|pyc|pyo|pyd|class|jar|war|ear|bin|dat|db|sqlite|sqlite3)$/i);
        return file.status !== 'removed' && !isBinary;
      });
      expect(mockedProcessFileDiff).toHaveBeenCalledTimes(processableFiles.length);
      expect(mockedAnalyzeWithAI).toHaveBeenCalledTimes(processableFiles.length);
      for (const file of processableFiles) {
        expect(updatedCommentBody).toContain(AI_ANALYSIS_MARKER_PREFIX + file.filename);
        expect(mockedAnalyzeWithAI).toHaveBeenCalledWith(
          expect.anything(),
          MOCKED_DIFF_CONTENT_PREFIX + '_' + file.filename,
          file.filename,
          MOCKED_CONTEXT_CONTENT_PREFIX + '_' + file.filename
        );
      }
      expect(updatedCommentBody).not.toContain(AI_ANALYSIS_MARKER_PREFIX + 'image.png');
      expect(updatedCommentBody).not.toContain(AI_ANALYSIS_MARKER_PREFIX + 'file3.js');
      if (processableFiles.length > 0) {
        expect(updatedCommentBody).toContain('Files with Potential Issues');
      } else {
        expect(updatedCommentBody).toContain('No potential issues found');
      }
    });
  });

  describe('/what command (direct call)', () => {
    it('should process /what command successfully', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { ...mockPr, diff: 'diff --git a/file.js b/file.js\nindex 0000000..1111111 100644\n--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,1 @@\n-old line\n+new line'},
        headers: { 'content-type': 'application/vnd.github.v3.diff' }
      });
      mockedAnalyzeWithAI.mockResolvedValue('Mocked PR summary from AI.');
      await processWhatCommand(mockOctokit, mockOwner, mockRepo, mockPr, globalMockFiles);
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
        body: '🤖 Analyzing changes...',
      }));
      expect(mockOctokit.issues.updateComment).toHaveBeenCalledTimes(1);
      const updatedCommentBody = mockOctokit.issues.updateComment.mock.calls[0][0].body;
      expect(updatedCommentBody).toContain('Mocked PR summary from AI.');
      expect(mockedAnalyzeWithAI).toHaveBeenCalledWith(
        expect.stringContaining('# PR Summary Request'),
        expect.any(String),
        'PR Summary'
      );
    });
  });

  describe('Issue Comment Event via Probot', () => {
    it('should trigger review for /review comment', async () => {
      const eventPayload = JSON.parse(JSON.stringify(issueCommentPayload));
      eventPayload.comment.body = '/review';
      eventPayload.issue.pull_request = { url: 'http://example.com/pr/1' };
      eventPayload.repository.owner.login = mockOwner;
      eventPayload.repository.name = mockRepo;
      eventPayload.issue.number = mockPr.number;

      nock('https://api.github.com')
        .post('/app/installations/2/access_tokens')
        .reply(200, { token: 'test-installation-token', permissions: { issues: 'write', metadata: 'read', contents: 'read', pull_requests: 'read' } });
      nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/' + mockPr.number)
        .reply(200, { ...mockPr, number: mockPr.number, head: { sha: 'headsha' }, base: { sha: 'basesha' }, body: 'PR body text' });
      const filesPayload = [
        { filename: 'event_file1.js', status: 'modified', changes: 10, additions: 5, deletions: 5, patch: 'diff for event_file1...' },
      ];
      nock('https://api.github.com')
        .get('/repos/' + mockOwner + '/' + mockRepo + '/pulls/' + mockPr.number + '/files')
        .reply(200, filesPayload);
      const initialCommentNock = nock('https://api.github.com')
        .post('/repos/' + mockOwner + '/' + mockRepo + '/issues/' + mockPr.number + '/comments', (body) => {
          return body.body.includes('Starting AI code review...');
        })
        .reply(200, { id: 54321 });
      const updateCommentNock = nock('https://api.github.com')
        .patch('/repos/' + mockOwner + '/' + mockRepo + '/issues/comments/54321', (body) => {
          return body.body.includes(AI_ANALYSIS_MARKER_PREFIX + 'event_file1.js');
        })
        .reply(200);

      await probot.receive({ name: 'issue_comment', id: 'test-event-id', payload: eventPayload });

      expect(initialCommentNock.isDone()).toBe(true);
      expect(updateCommentNock.isDone()).toBe(true);
      expect(mockedProcessFileDiff).toHaveBeenCalled(); // Check the mock from appModule
      expect(mockedAnalyzeWithAI).toHaveBeenCalled();   // Check the mock from appModule
    });
  });
});
