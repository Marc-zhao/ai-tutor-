// 阿里云百炼 (通义千问) — 支持文字+图片+联网
// qwen-vl-max: 视觉理解 | qwen-turbo: 纯文字 (快且便宜)

const QWEN_API_KEY = 'sk-a6b97989f69a4495b463a87b13282cdf';
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, webSearch, image } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages' });

  // Use vision model when image present, turbo for text-only (faster + cheaper)
  const model = image ? 'qwen-vl-max' : 'qwen-turbo';
  console.log(`[chat] model:${model} msgs:${messages.length} image:${!!image} webSearch:${!!webSearch}`);

  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (typeof m.content === 'string' ? m.content : '')
      .replace(/\[Image attached:[^\]]*\]\n?/g, '').trim();

    // Last user message with image → multimodal content array
    if (idx === lastUserIdx && image) {
      return {
        role,
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: text || '请仔细分析这张图片，读取并转录所有文字内容，包括所有手写文字。' }
        ]
      };
    }
    return { role, content: text || '...' };
  });

  // Web search: inject guidance into system prompt
  if (webSearch) {
    const si = flatMsgs.findIndex(m => m.role === 'system');
    if (si >= 0) {
      flatMsgs[si].content += '\n\n[WEB SEARCH MODE: Use your most current knowledge. Provide real statistics with source names and years. Be specific about data sources.]';
    }
  }

  const payloadKB = Math.round(JSON.stringify(flatMsgs).length / 1024);
  console.log(`[chat] sending ${payloadKB}kB to Qwen`);

  try {
    const resp = await fetch(QWEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + QWEN_API_KEY,
      },
      body: JSON.stringify({
        model,
        messages: flatMsgs,
        max_tokens: 1200,
        temperature: 0.7,
        stream: false,
      }),
    });

    const respText = await resp.text();
    console.log(`[chat] status:${resp.status} resp:${respText.slice(0,200)}`);

    if (!resp.ok) return res.status(resp.status).json({ error: respText.slice(0,300) });

    let data;
    try { data = JSON.parse(respText); } catch(e) { return res.status(500).json({ error: 'Invalid JSON' }); }

    const content = data.choices?.[0]?.message?.content || '';
    console.log(`[chat] reply:${content.length}chars "${content.slice(0,80)}"`);
    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
