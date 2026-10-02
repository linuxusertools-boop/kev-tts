// api/tts.js
import axios from 'axios';

export default async function handler(req, res) {
  // Hanya menerima HTTP POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Parameter "text" wajib diisi.' });
  }

  try {
    // 1. Kirim request ke endpoint generator AnyToSpeech
    const response = await axios.post(
      'https://anytospeech.com/api/generate', // Adjust sesuai endpoint API asli situs saat direverse-engineer
      {
        text: text,
        voice_id: 'anime-girl-shy', // ID voice target
        language: 'en'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://anytospeech.com/ai-voice-generator/anime-girl-shy',
          'Origin': 'https://anytospeech.com'
        }
      }
    );

    const audioUrl = response.data?.audio_url || response.data?.url;

    if (!audioUrl) {
      return res.status(500).json({ error: 'Gagal mendapatkan URL audio dari server target.', raw: response.data });
    }

    return res.status(200).json({
      success: true,
      voice: 'Anime Girl Shy',
      text: text,
      audio_url: audioUrl
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Gagal melakukan scraping / fetch TTS.',
      details: error.response ? error.response.data : error.message
    });
  }
}
