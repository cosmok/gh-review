const { createClient } = require('../llm');

describe('LLM wrapper', () => {
  afterEach(() => {
    delete process.env.LLM_PROVIDER;
  });

  it('defaults to google provider', async () => {
    const client = createClient();
    const res = await client.generate('test');
    expect(res).toBe('Mock AI response');
  });

  it('supports OpenAI provider', async () => {
    process.env.LLM_PROVIDER = 'openai';
    const client = createClient();
    const res = await client.generate('test');
    expect(res).toBe('OpenAI response');
  });

  it('supports Anthropic provider', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    const client = createClient();
    const res = await client.generate('test');
    expect(res).toBe('Claude response');
  });
});
