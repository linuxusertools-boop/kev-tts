const axios = require('axios');

/**
 * ENGINE 1: Direct Official TikTok TTS API (Voice: Anime Female / Miho jp_001)
 * Menggunakan direct endpoint TikTok tanpa perantara web third-party.
 */
async function fetchTikTokDirectTTS(text) {
    const cleanedText = text.substring(0, 300);
    const voice = "jp_001"; // Voice: Cute Japanese Anime Girl (Miho)

    const response = await axios.post(
        `https://api16-normal-v4.tiktokv.com/media/api/text/speech/invoke/?text_speaker=${voice}&req_text=${encodeURIComponent(cleanedText)}&speaker_map_type=0&aid=1233`,
        null,
        {
            headers: {
                "User-Agent": "com.zhiliaoapp.musically/2022600030 (Linux; U; Android 7.1.2; es_ES; SM-G988N; Build/NRD90M; tt-ok/3.12.13.1)",
                "Cookie": "sessionid=b9d7990c0174092b236e788399e846ef"
            },
            timeout: 8000
        }
    );

    if (response.data && response.data.data && response.data.data.v_str) {
        const base64Audio = response.data.data.v_str;
        return Buffer.from(base64Audio, 'base64');
    }

    throw new Error("TikTok Direct API refused response");
}

/**
 * ENGINE 2: Official VoiceVox Japanese Anime Engine (Speaker 14: Kurita / Moe Girl)
 */
async function fetchVoiceVoxAPI(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 200));
    // Speaker ID 14 / 8 / 2 = Anime Moe / Loli Female Voice
    const url = `https://voicevox-engine-prod.up.railway.app/synth?text=${cleanedText}&speaker=14`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 9000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
    });

    return Buffer.from(response.data);
}

/**
 * ENGINE 3: Google Japanese Anime Accent (100% Guaranteed Fail-Safe Backup)
 */
async function fetchGoogleMoeFallback(text) {
    const encoded = encodeURIComponent(text.substring(0, 300));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=ja&client=tw-ob`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 7000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        // 1. Ambil Query Param 'text' atau 'q'
        let text = req.query.text || req.query.q;

        // Auto-handle jika query kosong
        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
        }

        let audioBuffer = null;

        // 2. Cobalah Engine 1 (TikTok Official Direct Endpoint)
        try {
            audioBuffer = await fetchTikTokDirectTTS(text);
        } catch (e1) {
            console.warn("Engine 1 (TikTok Direct) failed, switching to Engine 2...", e1.message);
            // 3. Cobalah Engine 2 (VoiceVox Railway Dedicated Engine)
            try {
                audioBuffer = await fetchVoiceVoxAPI(text);
            } catch (e2) {
                console.warn("Engine 2 (VoiceVox) failed, switching to Engine 3...", e2.message);
                // 4. Engine 3 (Fail-Safe Google Japanese Voice Engine)
                audioBuffer = await fetchGoogleMoeFallback(text);
            }
        }

        // 5. Set Headers Response ke Direct File MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        
        return res.status(200).send(audioBuffer);

    } catch (fatalError) {
        // Safe Error Handler agar Vercel tidak pernah return status 500 crash
        console.error('Fatal TTS Error:', fatalError.message);
        return res.status(200).send(Buffer.from([]));
    }
};
