const { addSuggestionFormatting } = require('../utils');

describe('addSuggestionFormatting', () => {
  it('converts diff blocks to suggestion blocks', () => {
    const input = 'Issue\n```diff\n- old\n+ new\n```';
    const expected = 'Issue\n```suggestion\n- old\n+ new\n```';
    expect(addSuggestionFormatting(input)).toBe(expected);
  });

  it('leaves text without diff blocks unchanged', () => {
    const input = 'No diff here';
    expect(addSuggestionFormatting(input)).toBe(input);
  });
});
