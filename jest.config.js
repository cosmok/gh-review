module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  collectCoverageFrom: [
    'index.js',
    '!**/node_modules/**',
    '!**/__tests__/**',
    '!**/coverage/**',
    '!**/__mocks__/**',
  ],
  setupFilesAfterEnv: ['./__tests__/setup.js'],
  transform: {},
  moduleNameMapper: {
    '^p-limit$': '<rootDir>/__mocks__/p-limit.js',
  },
};
