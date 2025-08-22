let GoogleGenAI, OpenAI, Anthropic;
try { GoogleGenAI = require('@google/genai').GoogleGenAI; } catch (e) { GoogleGenAI = null; }
try { OpenAI = require('openai').OpenAI; } catch (e) { OpenAI = null; }
try { Anthropic = require('@anthropic-ai/sdk').Anthropic; } catch (e) { Anthropic = null; }
const { structuredLog } = require('./logger');

function createClient() {
  const provider = (process.env.LLM_PROVIDER || 'google').toLowerCase();
  if (provider === 'openai') {
    if (!OpenAI) throw new Error('OpenAI library not installed');
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Missing OPENAI_API_KEY environment variable');
    }
    const apiKey = process.env.OPENAI_API_KEY;
    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
    return {
      provider: 'openai',
      model,
      async generate(prompt, options = {}) {
        const modelName = options.model || model;
        const maxTokens = parseInt(options.maxTokens || process.env.LLM_MAX_TOKENS || '1024', 10);
        const temperature = parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '1');
        const topP = parseFloat(options.topP || process.env.LLM_TOP_P || '1');
        const res = await client.chat.completions.create({
          model: modelName,
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
    const model = process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229';
    return {
      provider: 'anthropic',
      model,
      async generate(prompt, options = {}) {
        const modelName = options.model || model;
        const maxTokens = parseInt(options.maxTokens || process.env.LLM_MAX_TOKENS || '1024', 10);
        const temperature = parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '1');
        const topP = parseFloat(options.topP || process.env.LLM_TOP_P || '1');
        const resp = await client.messages.create({
          model: modelName,
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
  const model = process.env.GENAI_MODEL || 'gemini-2.5-flash-preview-05-20';
  return {
    provider: 'google',
    model,
    async generate(prompt, options = {}) {
      const modelName = options.model || model;
      const generationConfig = {
        maxOutputTokens: parseInt(options.maxOutputTokens || process.env.LLM_MAX_TOKENS || '4096', 10),
        temperature: parseFloat(options.temperature || process.env.LLM_TEMPERATURE || '0.2'),
        topP: parseFloat(options.topP || process.env.LLM_TOP_P || '0.8'),
        topK: parseInt(options.topK || process.env.LLM_TOP_K || '40', 10)
      };
      const result = await genAI.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: generationConfig
      });

      const response = result.response ?? result;

      if (response.promptFeedback?.blockReason) {
        structuredLog('WARN', 'Prompt blocked', { reason: response.promptFeedback.blockReason });
        throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
      }

      const candidates = response.candidates || [];
      for (const [index, cand] of candidates.entries()) {
        if (cand.safetyRatings) {
          structuredLog('INFO', 'Candidate safety ratings', { index, safetyRatings: cand.safetyRatings });
        }
        if (cand.content?.parts) {
          structuredLog('INFO', 'Candidate parts', { index, parts: cand.content.parts });
        }
        if (cand.finishReason === 'SAFETY') {
          structuredLog('WARN', 'Text was filtered due to safety settings. Consider adjusting safety thresholds responsibly.');
        }
        if (cand.finishReason === 'MAX_TOKENS') {
          structuredLog('WARN', 'Response stopped early because max_output_tokens was too low. Consider increasing max_output_tokens.');
        }
        if (!cand.text && cand.content?.parts?.length) {
          structuredLog('WARN', 'Candidate text is empty but parts exist. SDK shortcut missed non-text parts. Read raw candidate parts and handle tool calls or metadata explicitly.');
        }
      }

      let text = response.text;
      if (!text && candidates.length) {
        text = candidates
          .map((c) => c.text || (c.content?.parts || []).map((p) => p.text || '').join(''))
          .join('');
      }

      if (!text) {
        structuredLog('WARN', 'LLM returned empty response. If streaming, ensure you iterate over all events and concatenate text deltas.');
        throw new Error('LLM returned empty response');
      }

      return text.trim();
    }
  };
}

module.exports = { createClient };
