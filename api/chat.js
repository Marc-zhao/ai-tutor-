// Vercel Serverless — /api/chat
// Fix: parse MiniMax XML tool_call format + image handling

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

  // ── Separate images from text ──────────────────────────────
  const flatMessages = [];
  let lastImageDataUrl = null;

  messages.forEach(m => {
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
      const imgs  = m.content.filter(p => p.type === 'image_url' && p.image_url?.url);
      if (imgs.length > 0) lastImageDataUrl = imgs[imgs.length - 1].image_url.url;
      flatMessages.push({ role: m.role, content: texts || '(image)' });
    } else {
      flatMessages.push({ role: m.role, content: m.content || '' });
    }
  });

  const hasImage = !!lastImageDataUrl;
  console.log('[chat] hasImage:', hasImage, 'webSearch:', !!webSearch, 'msgs:', flatMessages.length);

  // ── Step 1: If image, analyse it first then inject as context ──
  if (hasImage) {
    try {
      const imgAnalysis = await analyseImage(lastImageDataUrl);
      // Prepend image description to last user message
      const lastUserIdx = flatMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0 && imgAnalysis) {
        const orig = flatMessages[lastUserIdx].content;
        flatMessages[lastUserIdx] = {
          ...flatMessages[lastUserIdx],
          content: `[图片内容/Image content:\n${imgAnalysis}\n]\n\n${orig}`
        };
        console.log('[chat] Image injected, desc length:', imgAnalysis.length);
      }
    } catch(e) {
      console.error('[chat] Image analysis error:', e.message);
    }
  }

  // ── Step 2: Main chat call ──────────────────────────────────
  // For web search, use a simpler approach:
  // Instead of tool_calls (which returns XML), use system prompt injection
  let finalMessages = [...flatMessages];

  if (webSearch) {
    // Perform search before the main call
    const lastUserMsg = flatMessages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      const searchResult = await doSearch(lastUserMsg.content);
      if (searchResult) {
        // Inject search results into system or as context
        const sysIdx = finalMessages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
          finalMessages[sysIdx] = {
            ...finalMessages[sysIdx],
            content: finalMessages[sysIdx].content + `\n\n[WEB SEARCH RESULTS for "${lastUserMsg.content.slice(0,100)}":\n${searchResult}\nUse this data to help the student, but still ask Socratic questions rather than giving direct answers.]`
          };
        }
        console.log('[chat] Search results injected, length:', searchResult.length);
      }
    }
  }

  try {
    const payload = {
      model: 'MiniMax-M2.7',
      messages: finalMessages,
      max_tokens: 1500,
      temperature: 0.7,
      stream: false,
    };

    const resp = await callMM(payload);
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('[chat] MiniMax error:', resp.status, txt.slice(0, 300));
      return res.status(resp.status).json({ error: txt.slice(0, 200) });
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';

    // ── Clean up any XML tool_call tags that leaked into response ──
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    content = content.replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim();

    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch(err) {
    console.error('[chat] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Image analysis via MiniMax multimodal ──────────────────────
async function analyseImage(dataUrl) {
  const resp = await callMM({
    model: 'MiniMax-M2.7',
    messages: [
      {
        role: 'system',
        content: 'You are an OCR and image analysis assistant. Read ALL text in the image carefully and transcribe it exactly, including any handwriting.'
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Please transcribe ALL text visible in this image word for word, preserving the original text exactly. Also briefly describe what type of document/image this is.' }
        ]
      }
    ],
    max_tokens: 1500,
    stream: false
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('[analyseImage] failed:', resp.status, err.slice(0,200));
    return null;
  }
  const d = await resp.json();
  return d.choices?.[0]?.message?.content || null;
}

// ── Web search via DuckDuckGo ──────────────────────────────────
async function doSearch(query) {
  try {
    // Extract key terms for search
    const cleanQuery = query.replace(/[<>]/g, '').slice(0, 200);
    const encoded = encodeURIComponent(cleanQuery);
    const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const data = await resp.json();

    const results = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.Answer) results.push('Answer: ' + data.Answer);
    const topics = (data.RelatedTopics || []).slice(0, 5)
      .map(t => t.Text || (t.Topics ? t.Topics[0]?.Text : null))
      .filter(Boolean);
    results.push(...topics);

    return results.length > 0 ? results.join('\n\n') : null;
  } catch(e) {
    console.error('[doSearch] error:', e.message);
    return null;
  }
}

function callMM(payload) {
  return fetch(MINIMAX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MINIMAX_API_KEY },
    body: JSON.stringify(payload)
  });
}
