export const config = {
  runtime: 'edge',  // Edge runtime: no timeout limit
};

const QWEN_API_KEY = 'sk-a6b97989f69a4495b463a87b13282cdf';
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { messages, webSearch, image } = body;
  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'Missing messages' }), { status: 400 });
  }

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

  // Call Qwen with streaming
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
      stream: true,
    }),
  });

  if (!upstream.ok) {
    const txt = await upstream.text();
    return new Response(JSON.stringify({ error: txt.slice(0, 200) }), {
      status: upstream.status,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }

  // Collect stream and return complete JSON response
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
        fullContent += chunk.choices?.[0]?.delta?.content || '';
      } catch(e) {}
    }
  }

  return new Response(
    JSON.stringify({ content: fullContent, webSearchUsed: !!webSearch }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    }
  );
}
