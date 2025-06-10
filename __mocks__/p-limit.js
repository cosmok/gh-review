// Mock implementation of p-limit
const pLimit = (concurrency) => {
  return (fn) => {
    return async (...args) => {
      return fn(...args);
    };
  };
};

module.exports = pLimit;
