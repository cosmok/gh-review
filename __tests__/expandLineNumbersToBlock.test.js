const { expandLineNumbersToBlock } = require('../index');

describe('expandLineNumbersToBlock', () => {
  it('should include the full switch statement when a case line changes', () => {
    const snippet = `switch (severity.toLowerCase()) {
  case 'error':
    console.error(logData);
    break;
  case 'warn':
    console.warn(logData);
    break;
  case 'info':
    console.info(logData);
    break;
  case 'debug':
    console.debug(logData);
    break;
  default:
    console.log(logData);
}`;
    const expanded = expandLineNumbersToBlock(snippet, [2]);
    const expectedLines = Array.from({ length: snippet.split('\n').length }, (_, i) => i + 1);
    expect(expanded).toEqual(expectedLines);
  });

  it('should expand multiple changed regions separately', () => {
    const snippet = `function first() {\n  return 1;\n}\n\nfunction second(x) {\n  switch (x) {\n    case 1:\n      return 'one';\n    default:\n      return 'other';\n  }\n}`;
    const expanded = expandLineNumbersToBlock(snippet, [2, 8]);
    const expected = [1, 2, 3, 6, 7, 8, 9, 10, 11];
    expect(expanded).toEqual(expected);
  });
});
