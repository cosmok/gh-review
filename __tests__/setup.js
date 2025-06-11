// Mock environment variables
process.env.APP_ID = '123456';
process.env.PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\n' +
'MIIBOQIBAAJBALDRNoA7w6Nv6RjpN28rVfS+kI/nS3v1HNHjPERxdodCrnBQTMhV\n' +
'//ENZq7ksSjhc4L2PZFYhZpBEHkLqXgIs9MCAwEAAQJBALDRNoA7w6Nv6RjpN28r\n' +
'VfS+kI/nS3v1HNHjPERxdodCrnBQTMhV//ENZq7ksSjhc4L2PZFYhZpBEHkLqXgI\n' +
's9MCAwEAAQKBgQC6fA1Xg5cGF+v2t8519jpxfLzoYVdI9SCHuBAdz4p89kYOjQ2C\n' +
'Z+5v7zH8PzW3s1fQZ8Y3f4NnL9Y8h5Vj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1X\n' +
'j7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7\n' +
'sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5e\n' +
'X6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9\n' +
'oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5\n' +
'VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1\n' +
'XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+h\n' +
'XyXo1XnJ5VzK9oA5eX6gS7sT1Xj7kFb+hXyXo1XnJ5VzK9oA5eX6gS7sT1Xj7k\n' +
'-----END RSA PRIVATE KEY-----';
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
process.env.GOOGLE_APPLICATION_CREDENTIALS = 'test-credentials.json';

// Mock console methods to keep test output clean
console.log = jest.fn();
console.error = jest.fn();
console.warn = jest.fn();

// Mock the Google Cloud VertexAI
jest.mock('@google-cloud/vertexai', () => {
  return {
    VertexAI: jest.fn().mockImplementation(() => ({
      preview: {
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: jest.fn().mockResolvedValue({
            response: {
              text: jest.fn().mockResolvedValue('Mock AI response')
            }
          })
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
