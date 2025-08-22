const nock = require('nock');
const { Octokit } = require('@octokit/rest');
let getFileContent;

describe('getFileContent', () => {
  const owner = 'test-owner';
  const repo = 'test-repo';
  const path = 'dir';
  const ref = 'main';
  const octokit = new Octokit();

  beforeEach(() => {
    nock.disableNetConnect();
    jest.resetModules();
    ({ getFileContent } = require('../index'));
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('returns placeholder for directory paths', async () => {
    nock('https://api.github.com')
      .get(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`)
      .query(q => q.ref === ref)
      .reply(200, [{ path: 'dir/file1.js' }]);

    const result = await getFileContent(octokit, owner, repo, path, ref);
    expect(result).toBe('[Directory content not supported]');
  });
});
