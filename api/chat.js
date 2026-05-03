// Vercel Serverless — /api/chat
// 单次调用：图片直接放 messages，联网搜索注入 system prompt

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

  // ── Find last image (only send most recent to save payload) ──
  let lastImage = null;
  messages.forEach(m => {
    if (Array.isArray(m.content)) {
      const imgs = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      if (imgs.length) lastImage = imgs[imgs.length - 1].image_url.url;
    }
  });

  // ── Flatten messages: text only in history, image only in last user msg ──
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    // For multimodal messages
    if (Array.isArray(m.content)) {
      const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      // Only include image in the last user message
      if (idx === lastUserIdx && lastImage) {
        const parts = [
          { type: 'image_url', image_url: { url: lastImage } }
        ];
        if (text) parts.push({ type: 'text', text });
        else parts.push({ type: 'text', text: '请分析这张图片' });
        return { role, content: parts };
      }
      return { role, content: text || '(image)' };
    }
    return { role, content: m.content || '' };
  });

  // ── If web search enabled, do a quick search and inject results ──
  if (webSearch) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    const query = Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
      : (lastUserMsg?.content || '');

    if (query.trim()) {
      const results = await quickSearch(query.slice(0, 150));
      if (results) {
        // Inject into system message
        const sysIdx = flatMsgs.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
          flatMsgs[sysIdx] = {
            ...flatMsgs[sysIdx],
            content: flatMsgs[sysIdx].content
              + `\n\n[CURRENT WEB DATA (use as reference if relevant):\n${results}]`
          };
        }
      }
    }
  }

  // ── Single API call ──────────────────────────────────────────
  try {
    const payload = {
      model: 'MiniMax-M2.7',
      messages: flatMsgs,
      max_tokens: 1200,
      temperature: 0.7,
      stream: false,
    };

    console.log('[chat] image:', !!lastImage, 'webSearch:', !!webSearch,
      'msgs:', flatMsgs.length, 'payload ~KB:', Math.round(JSON.stringify(payload).length/1024));

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
      console.error('[chat] error:', resp.status, txt.slice(0, 200));
      return res.status(resp.status).json({ error: txt.slice(0, 200) });
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';

    // Clean any leaked XML tags
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();

    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Quick search using DuckDuckGo (fast, no auth needed)
async function quickSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(3000) // 3s timeout
    });
    if (!r.ok) return null;
    const d = await r.json();
    const parts = [];
    if (d.AbstractText) parts.push(d.AbstractText);
    if (d.Answer) parts.push(d.Answer);
    (d.RelatedTopics || []).slice(0, 4).forEach(t => { if (t.Text) parts.push(t.Text); });
    return parts.length ? parts.join('\n') : null;
  } catch {
    return null; // silently fail, don't block main call
  }
}
