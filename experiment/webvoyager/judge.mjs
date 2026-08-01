/**
 * The competitor's judge, unchanged in contract: same system prompt, same YES/NO JSON
 * schema, same evidence (task text + the agent's reasoning/actions + the final
 * screenshot). Using their judge is the point — a home-made judge would make the numbers
 * incomparable and would let us grade our own homework.
 *
 * Backend: GEMINI_API_KEY → gemini-2.5-flash (exactly what lumen used). Otherwise an
 * Anthropic judge, which is recorded in every report as `judgeModel` because a judge
 * from the same family as the actor is a weaker (more permissive) control.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 * @module agent/experiment/webvoyager/judge
 */
import { withRetry } from './retry.mjs'

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const GEMINI_MODEL = process.env.JUDGE_MODEL || 'gemini-2.5-flash'
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
const CLAUDE_JUDGE = process.env.JUDGE_MODEL_ANTHROPIC || 'claude-opus-5'

export const JUDGE_MODEL = () => (GEMINI_KEY ? GEMINI_MODEL : `${CLAUDE_JUDGE} (no GEMINI_API_KEY — judge is same-family as the actor)`)

const systemPrompt = (withShot) =>
  (withShot
    ? 'You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to a screenshot that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.'
    : 'You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to the agents reasoning and actions throughout the task that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.') +
  `\nToday's date is ${new Date().toLocaleDateString()}`

const userText = (question, agentResult) =>
  `Question: Did the agent successfully complete this task: "${question}"?\n\nAgent's reasoning and actions taken:\n${agentResult}`

async function judgeGemini(question, agentResult, screenshot) {
  const parts = [{ text: userText(question, agentResult) }]
  if (screenshot) parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshot.toString('base64') } })
  const res = await withRetry(() => fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: systemPrompt(!!screenshot) }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { evaluation: { type: 'string', enum: ['YES', 'NO'] }, reasoning: { type: 'string' } },
          required: ['evaluation', 'reasoning'],
        },
      },
    }),
  }), 'judge')
  const json = await res.json()
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
  return JSON.parse(text)
}

async function judgeAnthropic(question, agentResult, screenshot) {
  const content = []
  if (screenshot) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot.toString('base64') } })
  content.push({ type: 'text', text: userText(question, agentResult) })
  const res = await withRetry(() => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_JUDGE, max_tokens: 1000, system: systemPrompt(!!screenshot),
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { evaluation: { type: 'string', enum: ['YES', 'NO'] }, reasoning: { type: 'string' } },
            required: ['evaluation', 'reasoning'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content }],
    }),
  }), 'judge')
  const json = await res.json()
  return JSON.parse((json.content || []).map((c) => c.text || '').join(''))
}

/** @returns {Promise<{pass:boolean, reason:string}>} */
export async function judge(question, agentResult, screenshot) {
  try {
    const parsed = GEMINI_KEY
      ? await judgeGemini(question, agentResult, screenshot)
      : await judgeAnthropic(question, agentResult, screenshot)
    return { pass: parsed.evaluation === 'YES', reason: (parsed.reasoning || 'No reasoning provided').slice(0, 300) }
  } catch (err) {
    return { pass: false, reason: `Judge error: ${String(err).slice(0, 200)}` }
  }
}
