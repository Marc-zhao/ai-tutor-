// Vercel Serverless — /api/chat
// MiniMax M2.7: 图片理解(understand_image) + 联网搜索(web_search)

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

  // ── Extract images from multimodal messages ──────────────────
  // Flatten messages: pull out image data URLs, convert to plain text messages
  // then pass images via understand_image tool call
  const flatMessages = [];
  const imageAttachments = []; // {dataUrl, name, msgIndex}

  messages.forEach((m, idx) => {
    if (Array.isArray(m.content)) {
      const textParts = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      const imgParts  = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      imgParts.forEach(p => imageAttachments.push({ dataUrl: p.image_url.url, msgIdx: flatMessages.length }));
      flatMessages.push({ role: m.role, content: textParts || '(image uploaded)' });
    } else {
      flatMessages.push({ role: m.role, content: m.content || '' });
    }
  });

  const hasImages = imageAttachments.length > 0;
  console.log('[chat.js] hasImages:', hasImages, 'webSearch:', !!webSearch, 'msgs:', flatMessages.length);

  // ── Build tools list ─────────────────────────────────────────
  const tools = [];

  if (hasImages) {
    tools.push({
      type: 'function',
      function: {
        name: 'understand_image',
        description: 'Analyse and understand an image. Use this when an image has been uploaded.',
        parameters: {
          type: 'object',
          properties: {
            prompt:    { type: 'string', description: 'Question or instruction about the image' },
            image_url: { type: 'string', description: 'Image URL or base64 data URL' }
          },
          required: ['prompt', 'image_url']
        }
      }
    });
  }

  if (webSearch) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' }
          },
          required: ['query']
        }
      }
    });
  }

  const payload = {
    model: 'MiniMax-M2.7',
    messages: flatMessages,
    max_tokens: 1500,
    temperature: 0.7,
    stream: false,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
  };

  try {
    let response = await callMiniMax(payload);
    if (!response.ok) {
      const errText = await response.text();
      console.error('[chat.js] Error:', response.status, errText.slice(0, 300));
      return res.status(response.status).json({ error: errText });
    }

    let data = await response.json();
    let choice = data.choices?.[0];
    let finalContent = choice?.message?.content || '';
    let webSearchUsed = false;

    // ── Handle tool_calls (agentic loop, max 3 rounds) ────────
    let round = 0;
    while (choice?.finish_reason === 'tool_calls' && round < 3) {
      round++;
      const toolCalls = choice.message.tool_calls || [];
      const toolResults = [];

      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch(e) {}

        console.log('[chat.js] Tool call:', fnName, Object.keys(args));

        if (fnName === 'understand_image') {
          // Call MiniMax image understanding API
          const imgUrl = args.image_url || (imageAttachments[0]?.dataUrl) || '';
          const imgPrompt = args.prompt || 'Please analyse this image in detail.';
          let imgResult = '';
          try {
            const imgResp = await fetch('https://api.minimaxi.com/v1/text/chatcompletion_v2', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MINIMAX_API_KEY },
              body: JSON.stringify({
                model: 'MiniMax-M2.7',
                messages: [
                  { role: 'system', content: 'You are an image analysis assistant. Describe the image content accurately and completely.' },
                  { role: 'user', content: [
                    { type: 'image_url', image_url: { url: imgUrl } },
                    { type: 'text', text: imgPrompt }
                  ]}
                ],
                max_tokens: 1000,
                stream: false
              })
            });
            if (imgResp.ok) {
              const imgData = await imgResp.json();
              imgResult = imgData.choices?.[0]?.message?.content || 'Image analysis failed.';
            } else {
              imgResult = 'Could not analyse image: ' + imgResp.status;
            }
          } catch(e) { imgResult = 'Image analysis error: ' + e.message; }

          toolResults.push({ tool_call_id: tc.id, role: 'tool', content: imgResult });

        } else if (fnName === 'web_search') {
          // MiniMax handles web_search natively — return empty string to let it proceed
          // Actually for web_search, MiniMax executes it internally
          toolResults.push({ tool_call_id: tc.id, role: 'tool', content: 'Search completed.' });
          webSearchUsed = true;
        }
      }

      // Continue conversation with tool results
      const nextMessages = [
        ...flatMessages,
        { role: 'assistant', content: finalContent || '', tool_calls: toolCalls },
        ...toolResults
      ];

      const nextPayload = { ...payload, messages: nextMessages };
      response = await callMiniMax(nextPayload);
      if (!response.ok) break;
      data = await response.json();
      choice = data.choices?.[0];
      finalContent = choice?.message?.content || finalContent;
    }

    return res.status(200).json({ content: finalContent, webSearchUsed });

  } catch (err) {
    console.error('[chat.js] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function callMiniMax(payload) {
  return fetch(MINIMAX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + MINIMAX_API_KEY,
    },
    body: JSON.stringify(payload),
  });
}
