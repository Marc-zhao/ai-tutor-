// Vercel Serverless Function — /api/chat
// 支持文字、图片多模态、联网搜索

const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL    = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

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

  // Normalize messages
  const normalizedMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      const parts = m.content.filter(p => {
        if (p.type === 'text') return p.text && p.text.trim();
        if (p.type === 'image_url') return p.image_url && p.image_url.url;
        return false;
      });
      if (parts.length === 0) return { ...m, content: '' };
      return { ...m, content: parts };
    }
    return m;
  });

  const hasImages = normalizedMessages.some(m =>
    Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')
  );

  // Build payload
  const payload = {
    model: 'MiniMax-M2.7',
    messages: normalizedMessages,
    max_tokens: 1500,
    temperature: 0.7,
    stream: false,
  };

  // Add web search tool if requested
  if (webSearch) {
    payload.tools = [
      {
        type: 'web_search',
        web_search: {
          enable: true,
          search_mode: 'auto'   // MiniMax decides when to search
        }
      }
    ];
    payload.tool_choice = 'auto';
    console.log('[chat.js] Web search enabled');
  }

  console.log('[chat.js] hasImages:', hasImages, 'webSearch:', !!webSearch, 'messages:', normalizedMessages.length);

  try {
    const upstream = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + MINIMAX_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[chat.js] MiniMax error:', upstream.status, text.slice(0, 300));

      // If multimodal fails, retry with text only
      if (hasImages && upstream.status >= 400) {
        console.log('[chat.js] Retrying without images...');
        const textOnlyMessages = normalizedMessages.map(m => {
          if (Array.isArray(m.content)) {
            const textPart = m.content.find(p => p.type === 'text');
            return { ...m, content: textPart ? textPart.text : '(image uploaded)' };
          }
          return m;
        });
        const retryPayload = { ...payload, messages: textOnlyMessages };
        delete retryPayload.tools; // Remove tools for retry
        const retry = await fetch(MINIMAX_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MINIMAX_API_KEY },
          body: JSON.stringify(retryPayload),
        });
        if (retry.ok) {
          const rd = await retry.json();
          const content = rd.choices?.[0]?.message?.content || '';
          return res.status(200).json({ content, note: 'image_not_supported' });
        }
      }
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();

    // Handle tool_calls response (web search results)
    const choice = data.choices?.[0];
    let content = choice?.message?.content || '';

    // If model used web search tool, the content already includes search results
    // MiniMax returns the final answer after searching automatically
    if (!content && choice?.message?.tool_calls) {
      // This shouldn't happen with stream:false + auto, but handle it
      content = lang === 'zh' ? '正在搜索...' : 'Searching...';
    }

    return res.status(200).json({
      content,
      webSearchUsed: !!(choice?.message?.tool_calls?.length || data.usage?.web_search_count)
    });

  } catch (err) {
    console.error('[chat.js] Proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
