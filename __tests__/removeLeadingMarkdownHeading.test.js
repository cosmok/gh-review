const { removeLeadingMarkdownHeading } = require('..');

describe('removeLeadingMarkdownHeading', () => {
  it('removes leading heading and trims indentation', () => {
    const input = '### Summary\n    - first item\n    - second item';
    const expected = '- first item\n- second item';
    expect(removeLeadingMarkdownHeading(input)).toBe(expected);
  });
});
