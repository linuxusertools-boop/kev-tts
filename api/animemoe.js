const axios = require('axios');

/**
 * Direct TikTok Voice Generator (Voice: jp_001 - Anime / Cute Japanese Girl)
 * Mencoba beberapa endpoint global TikTok jika salah satu IP di-block Vercel.
 */
async function fetchTikTokAnimeVoice(text) {
    const cleanedText = text.substring(0, 300);
    const voice = "jp_001"; // Voice ID Anime Moe TikTok

    // Daftar endpoint official TikTok di berbagai wilayah
    const endpoints = [
        "https://api16-normal-c-useast1a.tiktokv.com/media/api/text/speech/invoke/",
        "https://api16-core-useast5.us.tiktokv.com/media/api/text/speech/invoke/",
        "https://api16-normal-v4.tiktokv.com/media/api/text/speech/invoke/"
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            const url = `${endpoint}?text_speaker=${voice}&req_text=${encodeURIComponent(cleanedText)}&speaker_map_type=0&aid=1233`;
            
            const response = await axios.post(url, null, {
                headers: {
                    "User-Agent": "com.zhiliaoapp.musically/2022600030 (Linux; U; Android 7.1.2; es_ES; SM-G988N; Build/NRD90M; tt-ok/3.12.13.1)",
                    "Accept-Encoding": "gzip,deflate",
                    "Cookie": "sessionid=b9d7990c0174092b236e788399e846ef"
                },
                timeout: 8000
            });

            if (response.data && response.data.data && response.data.data.v_str) {
                const base64Data = response.data.data.v_str;
                return Buffer.from(base64Data, 'base64');
            }
        } catch (err) {
            lastError = err;
        }
    }

    throw new Error(lastError ? lastError.message : "TikTok API blocked");
}

/**
 * Secondary Engine: VoiceVox Engine Endpoint khusus Anime Loli/Moe Voice
 */
async function fetchVoiceVoxMoe(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 200));
    // Speaker ID 14 / 2 / 8 = Suara Anime Girl / Moe Jepang
    const url = `https://voicevox.proxy.app/synth?text=${cleanedText}&speaker=14`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        timeout: 9000
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    // 1. Ambil Query Parameter 'text' atau 'q'
    let text = req.query.text || req.query.q;

    if (!text || !text.trim()) {
        text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
    }

    // 2. Coba Engine 1 (TikTok Anime Girl - jp_001)
    try {
        const audioBuffer = await fetchTikTokAnimeVoice(text);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(audioBuffer);
    } catch (e1) {
        console.warn("TikTok Anime Engine Failed:", e1.message);
        
        // 3. Coba Engine 2 (VoiceVox Moe) jika TikTok sibuk
        try {
            const audioBuffer = await fetchVoiceVoxMoe(text);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.status(200).send(audioBuffer);
        } catch (e2) {
            console.error("All Anime Engines Failed:", e2.message);
            
            // JIKA SEMUA SERVER MEMBLOKIR, KITA RETURN RESPONSE JSON BERSIH (TANPA GOOGLE TTS)
            return res.status(503).json({
                status: false,
                message: "Server voice anime sedang sibuk, silakan coba beberapa saat lagi."
            });
        }
    }
};
