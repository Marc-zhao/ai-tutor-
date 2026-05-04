// 文字: Token Plan Key | 图片+联网: 接口密钥
const TOKEN_KEY = 'sk-cp-4HqqfXmiPJ4VkN2K645mENVnjLVE96EM-qQN-soNwi2lR-Bl3BMEf7AKd-yIgSuSzSJ3z2vspKLW08qo-Lt8Tr3-4huwexpQ0NV-PkVZykf5oBWzrrF3XCY';
const API_KEY   = 'sk-api-KuXfI7vlPEXjN99Ij8w8q4cdwgUDGvW1lVDSh2ERm7AkYr1IHiKv9Tc2pVwz3yp1RbxDQfKWGkEoBnI1kkoOlCQhza7E7q4hlraCkR4jtdRDejoNxUjBrtI';
const URL = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, webSearch, image } = req.body || {};
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages' });

  // Use API key when image or webSearch is needed, else Token Plan key
  const needsApiKey = !!(image || webSearch);
  const authKey = needsApiKey ? API_KEY : TOKEN_KEY;
  console.log(`[chat] msgs:${messages.length} image:${!!image} webSearch:${!!webSearch} key:${needsApiKey?'API':'TOKEN'}`);

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
          { type: 'text', text: text || '请仔细分析这张图片，读取并转录所有文字内容。' }
        ]
      };
    }
    return { role, content: text || '...' };
  });

  // Web search: inject into system prompt (MiniMax uses its own knowledge with citation guidance)
  if (webSearch) {
    const si = flatMsgs.findIndex(m => m.role === 'system');
    if (si >= 0) {
      flatMsgs[si].content += '\n\n[WEB SEARCH MODE: You have access to current information. Provide real, specific statistics and data with source names and years. If you cite data, always mention the source organization and year.]';
    }
  }

  const payloadKB = Math.round(JSON.stringify(flatMsgs).length / 1024);
  console.log(`[chat] sending ${payloadKB}kB to MiniMax`);

  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authKey },
      body: JSON.stringify({ model: 'MiniMax-M2.7', messages: flatMsgs, max_tokens: 1200, temperature: 0.7, stream: false }),
    });

    const respText = await resp.text();
    console.log(`[chat] status:${resp.status} resp:${respText.slice(0,150)}`);

    if (!resp.ok) return res.status(resp.status).json({ error: respText.slice(0,200) });

    let data;
    try { data = JSON.parse(respText); } catch(e) { return res.status(500).json({ error: 'Invalid JSON' }); }

    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();

    console.log(`[chat] reply:${content.length}chars`);
    return res.status(200).json({ content, webSearchUsed: !!webSearch });

  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
