// Vercel Serverless — /api/chat
// Single call: image in messages + web search via system prompt

const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

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

  // ── Process messages: find last image, flatten to text ──────
  let lastImage = null;
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';

    if (Array.isArray(m.content)) {
      const imgs = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      if (imgs.length) lastImage = imgs[imgs.length - 1].image_url.url;

      // Only attach image in last user message
      if (idx === lastUserIdx && imgs.length) {
        const parts = [{ type: 'image_url', image_url: { url: imgs[imgs.length-1].image_url.url } }];
        if (text) parts.push({ type: 'text', text });
        else parts.push({ type: 'text', text: '请仔细分析这张图片的全部内容，包括所有文字。' });
        return { role, content: parts };
      }
      return { role, content: text || '(image)' };
    }

    return { role, content: m.content || '' };
  });

  const hasImage = !!lastImage;
  const payloadSize = Math.round(JSON.stringify(flatMsgs).length / 1024);
  console.log(`[chat] msgs:${flatMsgs.length} image:${hasImage} webSearch:${!!webSearch} ~${payloadSize}kB`);

  // ── Web search: inject instruction into system prompt ───────
  // Instead of external API (which may be blocked), tell MiniMax to use
  // its own knowledge + indicate search is requested
  if (webSearch) {
    const sysIdx = flatMsgs.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      flatMsgs[sysIdx] = {
        ...flatMsgs[sysIdx],
        content: flatMsgs[sysIdx].content
          + '\n\n[WEB SEARCH MODE: The user has enabled web search. '
          + 'Use your most up-to-date knowledge to provide real statistics, data, and sources. '
          + 'Always cite the source name, organization, and approximate year for any data you provide. '
          + 'If you are uncertain about recency, say so clearly.]'
      };
    }
  }

  // ── Single API call ─────────────────────────────────────────
  try {
    const payload = {
      model: 'MiniMax-M2.7',
      messages: flatMsgs,
      max_tokens: 1200,
      temperature: 0.7,
      stream: false,
    };

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
      console.error('[chat] error:', resp.status, txt.slice(0, 300));
      return res.status(resp.status).json({ error: txt.slice(0, 200) });
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';

    // Clean any leaked XML tool tags
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    content = content.replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim();

    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
