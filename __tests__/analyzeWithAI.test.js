jest.mock('../llm', () => ({
  createClient: () => ({
    generate: jest.fn().mockRejectedValue(new Error('maximum token limit exceeded'))
  })
}));

const { analyzeWithAI } = require('../index');

test('reports token limit errors clearly', async () => {
  await expect(analyzeWithAI('prompt', 'code', 'file.js')).rejects.toThrow('LLM token limit exceeded');
});
