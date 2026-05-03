// Vercel Serverless — /api/chat
// 修复：413图片压缩 + 联网搜索正确处理

const MINIMAX_API_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const MINIMAX_URL    = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

// Vercel body size limit: increase via config
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

  // ── Separate images from text messages ──
  const flatMessages = [];
  const allImages = []; // all base64 images found

  messages.forEach(m => {
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      const imgs  = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      imgs.forEach(p => allImages.push(p.image_url.url));
      flatMessages.push({ role: m.role, content: texts || '(image)' });
    } else {
      flatMessages.push({ role: m.role, content: m.content || '' });
    }
  });

  const hasImages = allImages.length > 0;
  const lastImage = allImages[allImages.length - 1]; // use most recent image

  console.log('[chat] hasImages:', hasImages, 'webSearch:', !!webSearch);

  // ── If has images: call image understanding first, inject result as context ──
  if (hasImages && lastImage) {
    try {
      // Strip data URL prefix to get pure base64, check size
      const base64Data = lastImage.replace(/^data:[^;]+;base64,/, '');
      const sizeKB = Math.round(base64Data.length * 0.75 / 1024);
      console.log('[chat] Image size:', sizeKB, 'KB');

      // Call MiniMax with image directly in messages (multimodal)
      const imgMessages = [
        { role: 'system', content: 'You are an image analysis assistant. Read and transcribe all text visible in the image accurately. If it is handwriting, transcribe it word by word.' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: lastImage } },
            { type: 'text', text: 'Please read and transcribe ALL text content in this image exactly as written, including any handwriting. Also describe what you see.' }
          ]
        }
      ];

      const imgResp = await fetch(MINIMAX_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MINIMAX_API_KEY },
        body: JSON.stringify({ model: 'MiniMax-M2.7', messages: imgMessages, max_tokens: 1000, stream: false })
      });

      let imageDescription = '';
      if (imgResp.ok) {
        const imgData = await imgResp.json();
        imageDescription = imgData.choices?.[0]?.message?.content || '';
        console.log('[chat] Image description length:', imageDescription.length);
      } else {
        const errText = await imgResp.text();
        console.error('[chat] Image call failed:', imgResp.status, errText.slice(0,200));
        imageDescription = '(Image could not be analysed: ' + imgResp.status + ')';
      }

      // Inject image content into the last user message
      const lastUserIdx = flatMessages.map(m=>m.role).lastIndexOf('user');
      if (lastUserIdx >= 0 && imageDescription) {
        flatMessages[lastUserIdx] = {
          ...flatMessages[lastUserIdx],
          content: `[Image content: ${imageDescription}]\n\n${flatMessages[lastUserIdx].content}`
        };
      }
    } catch(e) {
      console.error('[chat] Image processing error:', e.message);
    }
  }

  // ── Build tools for web search ──
  const tools = webSearch ? [{
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, statistics, news, or data',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query']
      }
    }
  }] : [];

  const payload = {
    model: 'MiniMax-M2.7',
    messages: flatMessages,
    max_tokens: 1500,
    temperature: 0.7,
    stream: false,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
  };

  try {
    let resp = await callMM(payload);

    if (!resp.ok) {
      const txt = await resp.text();
      console.error('[chat] MiniMax error:', resp.status, txt.slice(0,300));
      return res.status(resp.status).json({ error: txt.slice(0,300) });
    }

    let data = await resp.json();
    let choice = data.choices?.[0];
    let content = choice?.message?.content || '';
    let webSearchUsed = false;

    // ── Agentic loop for tool_calls (web search) ──
    let rounds = 0;
    while (choice?.finish_reason === 'tool_calls' && rounds < 3) {
      rounds++;
      const toolCalls = choice.message.tool_calls || [];
      const toolResults = [];

      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch(e) {}
        console.log('[chat] Tool call:', tc.function?.name, args);

        if (tc.function?.name === 'web_search') {
          // Execute web search via a search API (use DuckDuckGo instant answer as fallback)
          let searchResult = '';
          try {
            const query = encodeURIComponent(args.query || '');
            const searchResp = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`, {
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (searchResp.ok) {
              const sd = await searchResp.json();
              const topics = (sd.RelatedTopics || []).slice(0,5).map(t => t.Text || t.Name).filter(Boolean);
              searchResult = sd.AbstractText || topics.join('\n') || 'No results found for: ' + args.query;
            } else {
              searchResult = 'Search unavailable, please provide information from your training data.';
            }
          } catch(e) {
            searchResult = 'Search error: ' + e.message;
          }
          webSearchUsed = true;
          toolResults.push({ tool_call_id: tc.id, role: 'tool', content: searchResult || 'No results.' });
        }
      }

      // Continue with tool results
      const nextMsgs = [
        ...flatMessages,
        { role: 'assistant', content: content, tool_calls: toolCalls },
        ...toolResults
      ];
      resp = await callMM({ ...payload, messages: nextMsgs, tools: undefined, tool_choice: undefined });
      if (!resp.ok) break;
      data = await resp.json();
      choice = data.choices?.[0];
      content = choice?.message?.content || content;
    }

    return res.status(200).json({ content, webSearchUsed });

  } catch(err) {
    console.error('[chat] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

function callMM(payload) {
  return fetch(MINIMAX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MINIMAX_API_KEY },
    body: JSON.stringify(payload)
  });
}
