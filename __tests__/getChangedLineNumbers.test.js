const { getChangedLineNumbers } = require('../index');

describe('getChangedLineNumbers', () => {
  it('returns head and base line numbers for moved lines', () => {
    const patch = "@@ -1,5 +1,5 @@\n A1\n+A5\n A2\n A3\n A4\n-A5\n";
    const result = getChangedLineNumbers(patch);
    expect(result).toEqual({ headLines: [2], baseLines: [5] });
  });
});
