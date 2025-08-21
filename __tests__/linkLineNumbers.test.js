const { linkLineNumbers } = require('../index');

describe('linkLineNumbers', () => {
  it('creates links using md5 diff anchors', () => {
    const text = 'Check line 10';
    const refs = [{ file: 'README.md', lines: [10] }];
    const result = linkLineNumbers(text, refs, 'owner', 'repo', 1);
    expect(result).toBe('Check [line 10](https://github.com/owner/repo/pull/1/files#diff-04c6e90faac2675aa89e2176d2eec7d8R10)');
  });
});
