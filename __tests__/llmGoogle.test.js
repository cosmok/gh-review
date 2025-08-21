// Override Google GenAI mock to simulate missing text field
jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: undefined,
          candidates: [
            { content: { parts: [{ text: 'Fallback ' }, { text: 'response' }] } }
          ]
        })
      }
    }))
  };
});

const { createClient } = require('../llm');

describe('Google client generate fallback', () => {
  it('returns concatenated text when top-level text is missing', async () => {
    process.env.LLM_PROVIDER = 'google';
    const client = createClient();
    const result = await client.generate('prompt');
    expect(result).toBe('Fallback response');
  });
});
