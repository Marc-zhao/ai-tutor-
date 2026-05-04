const QWEN_API_KEY = 'sk-a6b97989f69a4495b463a87b13282cdf';
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 30,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, webSearch, image } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages' });

  const model = image ? 'qwen-vl-max' : 'qwen-turbo';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (typeof m.content === 'string' ? m.content : '')
      .replace(/\[Image attached:[^\]]*\]\n?/g, '').trim();

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

  if (webSearch) {
    const si = flatMsgs.findIndex(m => m.role === 'system');
    if (si >= 0) flatMsgs[si].content += '\n\n[WEB SEARCH MODE: Provide real statistics with source names and years.]';
  }

  console.log(`[chat] model:${model} msgs:${flatMsgs.length} image:${!!image} payload:${Math.round(JSON.stringify(flatMsgs).length/1024)}kB`);

  try {
    // Use streaming to avoid 30s timeout
    const upstream = await fetch(QWEN_URL, {
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
        stream: true,  // ← streaming keeps connection alive
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      console.error(`[chat] Qwen error ${upstream.status}:`, txt.slice(0, 200));
      return res.status(upstream.status).json({ error: txt.slice(0, 200) });
    }

    // Collect all SSE chunks and return complete response
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content || '';
          fullContent += delta;
        } catch(e) {}
      }
    }

    console.log(`[chat] complete reply:${fullContent.length}chars`);
    return res.status(200).json({ content: fullContent, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
