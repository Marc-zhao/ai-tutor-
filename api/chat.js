const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // image is sent separately, not inside messages
  const { messages, webSearch, image } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages' });
  }

  const bodySize = Math.round(JSON.stringify(req.body).length / 1024);
  console.log(`[chat] body:${bodySize}kB msgs:${messages.length} image:${image?Math.round(image.length*0.75/1024)+'kB':'none'} webSearch:${!!webSearch}`);

  // Find last user message index
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  // Build flat messages - inject image into last user message
  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (typeof m.content === 'string' ? m.content : '')
      .replace(/\[Image attached:[^\]]+\]\n?/g, '')
      .trim();

    // Last user message + image available → multimodal
    if (idx === lastUserIdx && image) {
      console.log(`[chat] injecting image into msg[${idx}]`);
      return {
        role,
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: text || '请仔细分析这张图片，读取并转录所有文字内容。' }
        ]
      };
    }
    return { role, content: text || (role === 'user' ? '...' : '...') };
  });

  // Web search mode
  if (webSearch) {
    const sysIdx = flatMsgs.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      flatMsgs[sysIdx].content += '\n\n[WEB SEARCH MODE: Provide real data with source names and years.]';
    }
  }

  const payloadSize = Math.round(JSON.stringify(flatMsgs).length / 1024);
  console.log(`[chat] sending ${payloadSize}kB to MiniMax`);

  try {
    const resp = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + MINIMAX_API_KEY,
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: flatMsgs,
        max_tokens: 1200,
        temperature: 0.7,
        stream: false,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[chat] MiniMax ${resp.status}:`, txt.slice(0, 300));
      return res.status(resp.status).json({ error: txt.slice(0, 200) });
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();

    console.log(`[chat] reply:${content.length}chars`);
    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
