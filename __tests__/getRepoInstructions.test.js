const nock = require('nock');
const { Octokit } = require('@octokit/rest');
let getRepoInstructions;

describe('getRepoInstructions', () => {
  const mockOwner = 'test-owner';
  const mockRepo = 'test-repo';
  const ref = 'head-sha';
  const octokit = new Octokit();

  beforeEach(() => {
    nock.disableNetConnect();
    process.env.ENABLE_REPO_INSTRUCTIONS = 'true';
    jest.resetModules();
    ({ getRepoInstructions } = require('../index'));
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('combines repo and folder instructions', async () => {
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('root instructions').toString('base64'), size: 17 });

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('folder/AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('folder instructions').toString('base64'), size: 19 });

    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, 'folder/file.js', ref);
    expect(result).toMatch(/folder instructions[\s\S]*root instructions/);
  });

  it('returns repo instructions when only repo level exists', async () => {
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('root only').toString('base64'), size: 9 });

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('folder/AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(404);

    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, 'folder/file.js', ref);
    expect(result).toBe('root only');
  });

  it('returns folder instructions when only folder level exists', async () => {
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(404);

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('folder/AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('folder only').toString('base64'), size: 11 });

    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, 'folder/file.js', ref);
    expect(result).toBe('folder only');
  });

  it('returns empty string when no instructions found', async () => {
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(404);

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('folder/AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(404);

    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, 'folder/file.js', ref);
    expect(result).toBe('');
  });

  it('handles nested folder paths', async () => {
    const nestedPath = 'deeply/nested/folder/file.js';
    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('root instructions').toString('base64'), size: 17 });

    nock('https://api.github.com')
      .get(`/repos/${mockOwner}/${mockRepo}/contents/${encodeURIComponent('deeply/nested/folder/AI_REVIEW_INSTRUCTIONS.md')}`)
      .query(q => q.ref === ref)
      .reply(200, { content: Buffer.from('folder instructions').toString('base64'), size: 19 });

    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, nestedPath, ref);
    expect(result).toMatch(/folder instructions[\s\S]*root instructions/);
  });

  it('returns empty when ENABLE_REPO_INSTRUCTIONS is disabled', async () => {
    process.env.ENABLE_REPO_INSTRUCTIONS = 'false';
    jest.resetModules();
    ({ getRepoInstructions } = require('../index'));
    const result = await getRepoInstructions(octokit, mockOwner, mockRepo, 'folder/file.js', ref);
    expect(result).toBe('');
  });
});
