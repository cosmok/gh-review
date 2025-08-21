let GoogleGenAI, OpenAI, Anthropic;
try { GoogleGenAI = require('@google/genai').GoogleGenAI; } catch (e) { GoogleGenAI = null; }
try { OpenAI = require('openai').OpenAI; } catch (e) { OpenAI = null; }
try { Anthropic = require('@anthropic-ai/sdk').Anthropic; } catch (e) { Anthropic = null; }

function createClient() {
  const provider = (process.env.LLM_PROVIDER || 'google').toLowerCase();
  if (provider === 'openai') {
    if (!OpenAI) throw new Error('OpenAI library not installed');
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Missing OPENAI_API_KEY environment variable');
    }
    const apiKey = process.env.OPENAI_API_KEY;
    const client = new OpenAI({ apiKey });
    return {
      provider: 'openai',
      async generate(prompt, options = {}) {
        const model = options.model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
        const maxTokens = parseInt(options.maxTokens || process.env.LLM_MAX_TOKENS || '1024', 10);
        const temperature = parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '1');
        const topP = parseFloat(options.topP || process.env.LLM_TOP_P || '1');
        const res = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
          top_p: topP
        });
        return res.choices[0].message.content.trim();
      }
    };
  }
  if (provider === 'anthropic') {
    if (!Anthropic) throw new Error('Anthropic library not installed');
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Missing ANTHROPIC_API_KEY environment variable');
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const client = new Anthropic({ apiKey });
    return {
      provider: 'anthropic',
      async generate(prompt, options = {}) {
        const model = options.model || process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';
        const maxTokens = parseInt(options.maxTokens || process.env.LLM_MAX_TOKENS || '1024', 10);
        const temperature = parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '1');
        const topP = parseFloat(options.topP || process.env.LLM_TOP_P || '1');
        const resp = await client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          top_p: topP,
          messages: [{ role: 'user', content: prompt }]
        });
        return resp.content[0].text.trim();
      }
    };
  }
  // default google
  if (!GoogleGenAI) throw new Error('GoogleGenAI library not installed');
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  if (!project || !location) {
    throw new Error('Missing GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION');
  }
  const genAI = new GoogleGenAI({ vertexai: true, project, location });
  return {
    provider: 'google',
    async generate(prompt, options = {}) {
      const model = options.model || process.env.GENAI_MODEL || 'gemini-2.5-flash-preview-05-20';
      const generationConfig = {
        maxOutputTokens: parseInt(options.maxOutputTokens || process.env.LLM_MAX_TOKENS || '4096', 10),
        temperature: parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '0.2'),
        topP: parseFloat(options.topP || process.env.LLM_TOP_P || '0.8'),
        topK: parseInt(options.topK || process.env.LLM_TOP_K || '40', 10)
      };
      const result = await genAI.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: generationConfig
      });
      const text =
        result.text ||
        result.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('');
      if (!text) {
        throw new Error('LLM returned empty response');
      }
      return text.trim();
    }
  };
}

module.exports = { createClient };
