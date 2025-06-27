// Mock environment variables
process.env.APP_ID = '123456';
const { generateKeyPairSync } = require('crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
process.env.GOOGLE_APPLICATION_CREDENTIALS = 'test-credentials.json';
process.env.ENABLE_REPO_INSTRUCTIONS = 'false';

// Mock console methods to keep test output clean
console.log = jest.fn();
console.error = jest.fn();
console.warn = jest.fn();

// Mock Google GenAI library
jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: 'Mock AI response'
        })
      }
    }))
  };
});

// Mock OpenAI library
jest.mock('openai', () => {
  return {
    OpenAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: 'OpenAI response' } }]
          })
        }
      }
    }))
  };
});

// Mock Anthropic library
jest.mock('@anthropic-ai/sdk', () => {
  return {
    Anthropic: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ text: 'Claude response' }]
        })
      }
    }))
  };
});

// Mock p-limit to execute functions immediately
jest.mock('p-limit', () => {
  return jest.fn(() => {
    return async (fn) => {
      return Promise.resolve(fn());
    };
  });
});
