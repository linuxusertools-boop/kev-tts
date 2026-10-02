const axios = require('axios');

/**
 * ENGINE 1: Youdao Japanese Anime Synthesizer (Fastest < 300ms)
 * Suara Jepang Moe / Japanese Anime Female Accent
 */
async function fetchYoudaoAnimeTTS(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    const url = `https://dict.youdao.com/dictvoice?audio=${cleanedText}&le=jap`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://dict.youdao.com/"
        }
    });

    return Buffer.from(response.data);
}

/**
 * ENGINE 2: TikTok Cute Anime Voice (jp_001 - Cute Japanese Female)
 * Menggunakan TikTok Endpoint Proxy Resmi dengan Timeout Ringan
 */
async function fetchTikTokAnimeProxy(text) {
    const cleanedText = text.substring(0, 300);
    
    const response = await axios.post("https://tiktok-tts.com/api/tts", {
        text: cleanedText,
        voice: "jp_001"
    }, {
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        timeout: 6000
    });

    if (response.data && response.data.audio) {
        return Buffer.from(response.data.audio, 'base64');
    }
    throw new Error("TikTok API response invalid");
}

/**
 * ENGINE 3: VoiceRSS Japanese Female Synthesizer
 */
async function fetchVoiceRSSMoe(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    const url = `https://api.voicerss.org/?key=e71df974f19b49b28b7e28328c8942df&hl=ja-jp&v=Hina&src=${cleanedText}&f=44khz_16bit_mono`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 6000
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        // 1. Ambil Query Parameter 'text' atau 'q'
        let text = req.query.text || req.query.q;

        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
        }

        let audioBuffer = null;

        // 2. Eksekusi Engine 1 (Youdao Jap Anime - Super Fast < 300ms)
        try {
            audioBuffer = await fetchYoudaoAnimeTTS(text);
        } catch (e1) {
            console.warn("Engine 1 failed, trying Engine 2...", e1.message);
            // 3. Eksekusi Engine 2 (TikTok jp_001 Anime Voice)
            try {
                audioBuffer = await fetchTikTokAnimeProxy(text);
            } catch (e2) {
                console.warn("Engine 2 failed, trying Engine 3...", e2.message);
                // 4. Eksekusi Engine 3 (VoiceRSS Japanese Hina)
                audioBuffer = await fetchVoiceRSSMoe(text);
            }
        }

        // 5. Kirim Direct Audio Stream MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        return res.status(200).send(audioBuffer);

    } catch (fatalError) {
        console.error('Fatal TTS Error:', fatalError.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses audio TTS.",
            error: fatalError.message
        });
    }
};
