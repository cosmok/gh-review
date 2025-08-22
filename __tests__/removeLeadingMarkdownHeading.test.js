const { removeLeadingMarkdownHeading } = require('..');

describe('removeLeadingMarkdownHeading', () => {
  it('removes leading heading and trims indentation', () => {
    const input = '### Summary\n    - first item\n    - second item';
    const expected = '- first item\n- second item';
    expect(removeLeadingMarkdownHeading(input)).toBe(expected);
  });

  it('preserves relative indentation', () => {
    const input = '### Summary\n    - first item\n      - nested item\n        code block';
    const expected = '- first item\n  - nested item\n    code block';
    expect(removeLeadingMarkdownHeading(input)).toBe(expected);
  });
});
