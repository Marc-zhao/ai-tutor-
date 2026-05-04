const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, webSearch } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages' });
  }

  const bodySize = Math.round(JSON.stringify(req.body).length / 1024);
  console.log(`[chat] received body: ${bodySize}kB, msgs: ${messages.length}, webSearch: ${!!webSearch}`);

  // Find last image in messages
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  let hasImage = false;

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';

    if (Array.isArray(m.content)) {
      const imgs = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();

      if (idx === lastUserIdx && imgs.length) {
        hasImage = true;
        const imgSize = Math.round(imgs[0].image_url.url.length * 0.75 / 1024);
        console.log(`[chat] image found in last user msg: ~${imgSize}kB`);
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: imgs[0].image_url.url } },
            { type: 'text', text: text || '请仔细分析这张图片的全部内容，读取所有文字。' }
          ]
        };
      }
      return { role, content: text || '(image)' };
    }

    return { role, content: m.content || '' };
  });

  // Web search mode: inject into system prompt
  if (webSearch) {
    const sysIdx = flatMsgs.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      flatMsgs[sysIdx].content += '\n\n[WEB SEARCH MODE: Provide real statistics with source names, organizations and years. If uncertain about recency, say so.]';
    }
  }

  const payload = {
    model: 'MiniMax-M2.7',
    messages: flatMsgs,
    max_tokens: 1200,
    temperature: 0.7,
    stream: false,
  };

  const payloadSize = Math.round(JSON.stringify(payload).length / 1024);
  console.log(`[chat] sending to MiniMax: ${payloadSize}kB, hasImage: ${hasImage}`);

  try {
    const resp = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + MINIMAX_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[chat] MiniMax ${resp.status}: ${txt.slice(0, 300)}`);
      return res.status(resp.status).json({ error: txt.slice(0, 200) });
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();

    console.log(`[chat] reply: ${content.length} chars`);
    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
