const { GoogleGenAI } = require('@google/genai');
let OpenAI, Anthropic;
try { OpenAI = require('openai').OpenAI; } catch (e) { OpenAI = null; }
try { Anthropic = require('@anthropic-ai/sdk').Anthropic; } catch (e) { Anthropic = null; }

function createClient() {
  const provider = (process.env.LLM_PROVIDER || 'google').toLowerCase();
  if (provider === 'openai') {
    if (!OpenAI) throw new Error('OpenAI library not installed');
    const apiKey = process.env.OPENAI_API_KEY || 'test-key';
    const client = new OpenAI({ apiKey });
    return {
      provider: 'openai',
      async generate(prompt, options = {}) {
        const model = options.model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
        const res = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }] });
        return res.choices[0].message.content.trim();
      }
    };
  }
  if (provider === 'anthropic') {
    if (!Anthropic) throw new Error('Anthropic library not installed');
    const apiKey = process.env.ANTHROPIC_API_KEY || 'test-key';
    const client = new Anthropic({ apiKey });
    return {
      provider: 'anthropic',
      async generate(prompt, options = {}) {
        const model = options.model || process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';
        const resp = await client.messages.create({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
        return resp.content[0].text.trim();
      }
    };
  }
  // default google
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  const genAI = new GoogleGenAI({ vertexai: true, project, location });
  return {
    provider: 'google',
    async generate(prompt, options = {}) {
      const model = options.model || process.env.GENAI_MODEL || 'gemini-2.5-flash-preview-05-20';
      const generationConfig = { maxOutputTokens: 4096, temperature: 0.2, topP: 0.8, topK: 40 };
      const result = await genAI.models.generateContent({ model, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: generationConfig });
      return result.text;
    }
  };
}

module.exports = { createClient };
