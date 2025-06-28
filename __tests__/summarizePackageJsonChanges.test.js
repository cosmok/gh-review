const { summarizePackageJsonChanges } = require('../index');

describe('summarizePackageJsonChanges', () => {
  it('reports added, removed and updated packages', () => {
    const base = JSON.stringify({
      dependencies: { a: '1.0.0', b: '1.0.0' },
      devDependencies: { jest: '1.0.0' }
    });
    const head = JSON.stringify({
      dependencies: { b: '1.1.0', c: '1.0.0' },
      devDependencies: { jest: '1.0.0', eslint: '2.0.0' }
    });

    const summary = summarizePackageJsonChanges(base, head);
    expect(summary).toContain('Added dependencies: c@1.0.0');
    expect(summary).toContain('Removed dependencies: a@1.0.0');
    expect(summary).toContain('Updated dependencies: b (1.0.0 -> 1.1.0)');
    expect(summary).toContain('Added devDependencies: eslint@2.0.0');
  });
});
