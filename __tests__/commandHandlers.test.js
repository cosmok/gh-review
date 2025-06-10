const nock = require('nock');
const { Octokit } = require('@octokit/rest');
// Import the functions we want to test
const { processWhatCommand, processReviewCommand, processFileDiff } = require('../index');

// Mock the analyzeWithAI function
jest.mock('../index', () => {
  const originalModule = jest.requireActual('../index');
  return {
    ...originalModule,
    analyzeWithAI: jest.fn(),
    processFileDiff: jest.fn()
  };
});

// Get reference to the mocked processFileDiff
const mockedProcessFileDiff = require('../index').processFileDiff;

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
    ref: 'main',
    user: { login: 'test-user' }
  },
  head: {
    sha: 'head-sha',
    ref: 'feature-branch',
    user: { login: 'test-user' }
  }
};

const mockFiles = [
  {
    filename: 'test.js',
    status: 'modified',
    changes: 3,
    additions: 2,
    deletions: 1,
    patch: '@@ -1,5 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n-  console.log(\'Old line\');\n   return true;\n }'
  }
];

describe('Command Handlers', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    nock.cleanAll();
  });

  describe('processWhatCommand', () => {
    it('should process /what command successfully', async () => {
      // Mock the PR diff response
      const mockDiff = 'diff --git a/test.js b/test.js\nindex 1234567..89abcde 100644\n--- a/test.js\n+++ b/test.js\n@@ -1,5 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n   console.log(\'Test\');\n   return true;\n }';
      
      // Mock the GitHub API responses
      octokit.pulls = {
        get: jest.fn().mockResolvedValue({
          data: { diff: mockDiff }
        })
      };

      // Mock the AI response
      const mockAIResponse = 'Mock AI response';
      jest.spyOn(require('../index'), 'analyzeWithAI').mockResolvedValue(mockAIResponse);

      // Mock the comment creation
      const mockComment = { id: 123 };
      const createCommentMock = jest.fn().mockResolvedValue({ data: mockComment });
      const updateCommentMock = jest.fn().mockResolvedValue({});
      
      octokit.issues = {
        createComment: createCommentMock,
        updateComment: updateCommentMock
      };

      // Mock the listFiles response
      octokit.pulls.listFiles = jest.fn().mockResolvedValue({
        data: [{
          filename: 'test.js',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1,6 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n-  console.log(\'Old line\');\n   return true;\n }',
          blob_url: 'https://github.com/test-owner/test-repo/blob/head-sha/test.js',
          raw_url: 'https://github.com/test-owner/test-repo/raw/head-sha/test.js',
          contents_url: 'https://api.github.com/repos/test-owner/test-repo/contents/test.js?ref=head-sha'
        }]
      });

      await processWhatCommand(octokit, mockOwner, mockRepo, mockPr, mockFiles);

      // Verify that the PR diff was requested with the correct parameters
      const expectedCall = {
        owner: mockOwner,
        repo: mockRepo,
        pull_number: mockPr.number,
        mediaType: {
          format: 'diff'
        },
        headers: {
          accept: 'application/vnd.github.v3.diff'
        }
      };
      
      // Check if the call was made with the expected parameters
      expect(octokit.pulls.get).toHaveBeenCalledWith(expect.objectContaining({
        owner: expectedCall.owner,
        repo: expectedCall.repo,
        pull_number: expectedCall.pull_number,
        mediaType: expectedCall.mediaType
      }));

      // Verify that a comment was created or updated
      expect(createCommentMock).toHaveBeenCalled();
    });
  });

  describe('processReviewCommand', () => {
    let listFilesMock;
    let createCommentMock;
    let updateCommentMock;

    // Helper function to create a mock file
    const createMockFile = (filename) => ({
      filename,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1,5 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n   console.log(\'Test\');\n   return true;\n }',
      blob_url: `https://github.com/${mockOwner}/${mockRepo}/blob/head-sha/${filename}`,
      raw_url: `https://github.com/${mockOwner}/${mockRepo}/raw/head-sha/${filename}`,
      contents_url: `https://api.github.com/repos/${mockOwner}/${mockRepo}/contents/${filename}?ref=head-sha`
    });

    beforeEach(() => {
      // Reset all mocks before each test
      jest.clearAllMocks();
      
      // Create fresh mocks for each test
      const mockFile = createMockFile(mockFiles[0].filename);
      
      // Set up the mocks for octokit methods
      listFilesMock = jest.fn().mockResolvedValue({
        data: [mockFile]
      });

      createCommentMock = jest.fn().mockResolvedValue({ data: { id: 123 } });
      updateCommentMock = jest.fn().mockResolvedValue({});

      // Set up the mocks for octokit
      octokit.pulls = {
        listFiles: listFilesMock,
        get: jest.fn().mockResolvedValue({
          data: { 
            diff: 'diff --git a/test.js b/test.js\nindex 1234567..89abcde 100644\n--- a/test.js\n+++ b/test.js\n@@ -1,5 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n   console.log(\'Test\');\n   return true;\n }',
            files: [mockFile]  // Add files array to match actual API response
          }
        })
      };

      // Mock the processFileDiff function to return a resolved promise with mock data
      mockedProcessFileDiff.mockImplementation(async () => ({
        diff: 'diff --git a/test.js b/test.js\nindex 1234567..89abcde 100644\n--- a/test.js\n+++ b/test.js\n@@ -1,5 +1,6 @@\n // Example file\n function test() {\n+  console.log(\'New line\');\n   console.log(\'Test\');\n   return true;\n }',
        context: 'Mock context for the file',
        error: null,
        content: '// Example file\nfunction test() {\n  console.log(\'Test\');\n  return true;\n}'
      }));

      // Mock the getContent function to return file content
      octokit.repos = {
        getContent: jest.fn().mockResolvedValue({
          data: {
            content: Buffer.from('// Example file\nfunction test() {\n  console.log(\'Test\');\n  return true;\n}').toString('base64'),
            encoding: 'base64',
            size: 100
          }
        })
      };

      octokit.issues = {
        createComment: createCommentMock,
        updateComment: updateCommentMock
      };

      // Mock the AI response
      jest.spyOn(require('../index'), 'analyzeWithAI').mockResolvedValue('Mock AI review');
    });

    it('should process /review command successfully', async () => {
      // Call the function under test with mock files
      await processReviewCommand(octokit, mockOwner, mockRepo, mockPr, mockFiles);
      
      // Verify that processFileDiff was called with the correct parameters
      expect(require('../index').processFileDiff).toHaveBeenCalledWith(
        octokit,
        mockOwner,
        mockRepo,
        expect.objectContaining({
          filename: mockFiles[0].filename,
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2
        }),
        mockPr
      );

      // Verify that a comment was created
      expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
        owner: mockOwner,
        repo: mockRepo,
        issue_number: mockPr.number,
        body: expect.stringContaining('🔍 Starting AI code review')
      }));
      
      // Verify that the comment was updated with the review
      expect(updateCommentMock).toHaveBeenCalledWith(expect.objectContaining({
        owner: mockOwner,
        repo: mockRepo,
        comment_id: 123,
        body: expect.stringContaining('AI Code Review Summary')
      }));
    });

    it('should handle errors during review processing', async () => {
      // Mock the PR diff response
      octokit.pulls = {
        get: jest.fn().mockRejectedValue(new Error('Failed to get PR diff'))
      };

      // Mock the comment creation
      const mockComment = { id: 123 };
      const updateCommentMock = jest.fn().mockResolvedValue({});
      
      octokit.issues = {
        createComment: jest.fn().mockResolvedValue({ data: mockComment }),
        updateComment: updateCommentMock
      };

      await processReviewCommand(octokit, mockOwner, mockRepo, mockPr, mockFiles);

      // Verify that updateComment was called with the review summary
      expect(updateCommentMock).toHaveBeenCalledWith({
        owner: mockOwner,
        repo: mockRepo,
        comment_id: mockComment.id,
        body: expect.stringContaining('AI Code Review Summary')
      });
    });
  });
});
