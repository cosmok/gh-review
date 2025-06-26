describe('LLM provider selection', () => {
  let analyzeWithAI;
  beforeAll(() => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    jest.resetModules();
    ({ analyzeWithAI } = require('../index'));
  });

  afterAll(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  it('uses OpenAI when configured', async () => {
    const result = await analyzeWithAI('test prompt', 'code', 'file.js');
    expect(result).toBe('Mock OpenAI response');
  });
});
