// Vercel Serverless Function — /api/chat
// 代理 MiniMax API，解决浏览器 CORS 限制
// 所有 AI 对话经由此函数转发，对话内容由前端存入 Supabase

const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL    = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing or invalid messages array' });
  }

  try {
    const upstream = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + MINIMAX_API_KEY,
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages,
        max_tokens: 1000,
        temperature: 0.7,
        stream: false,
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('MiniMax error:', upstream.status, text);
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ content });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
