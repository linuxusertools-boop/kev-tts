const axios = require('axios');

/**
 * Helper untuk mengambil audio buffer dari AnyToSpeech API
 */
async function fetchAnyToSpeech(text) {
    // Trim teks maks 500 karakter sesuai limit provider
    const cleanedText = text.substring(0, 500);

    const payload = {
        voice_id: "anime-girl-shy",
        voice: "anime-girl-shy",
        text: cleanedText,
        speed: 1.0
    };

    const response = await axios.post("https://anytospeech.com/api/tts/generate", payload, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            "Content-Type": "application/json",
            "Referer": "https://anytospeech.com/ai-voice-generator/anime-girl-shy",
            "Origin": "https://anytospeech.com",
            "Accept": "application/json, text/plain, */*"
        },
        timeout: 9000
    });

    const audioUrl = response.data?.audio_url || response.data?.url || response.data?.audio;
    if (!audioUrl) throw new Error("No audio URL returned from primary provider");

    // Re-fetch MP3 Buffer
    const audioStream = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 9000
    });

    return Buffer.from(audioStream.data);
}

/**
 * Fallback Provider: High Quality Japanese Voice Engine (Moe/Anime Style)
 */
async function fetchFallbackTTS(text) {
    const encodedText = encodeURIComponent(text.substring(0, 300));
    // Provider Google TTS aksen Jepang (Ja-JP)
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=ja&client=tw-ob`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        timeout: 8000
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    // 1. Tangkap Query 'text' atau 'q'
    let text = req.query.text || req.query.q;

    // Jika parameter tidak diisi, berikan pesan/default text agar tidak error
    if (!text || !text.trim()) {
        text = "Konnichiwa, silakan masukkan teks yang ingin diubah menjadi suara.";
    }

    let audioBuffer = null;

    // 2. Coba ambil dari Provider utama (AnyToSpeech)
    try {
        audioBuffer = await fetchAnyToSpeech(text);
    } catch (primaryError) {
        console.warn("Primary TTS Provider failed, switching to Fallback:", primaryError.message);
        
        // 3. Jika provider utama gagal/error/limit, otomatis ke Fallback
        try {
            audioBuffer = await fetchFallbackTTS(text);
        } catch (fallbackError) {
            console.error("All TTS Providers failed:", fallbackError.message);
            return res.status(500).json({
                status: false,
                message: "Gagal memproses audio TTS dari semua provider.",
                error: fallbackError.message
            });
        }
    }

    // 4. Kirim Response dalam Bentuk Buffer File Audio MP3
    try {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 1 hari
        return res.status(200).send(audioBuffer);
    } catch (sendError) {
        return res.status(500).json({
            status: false,
            message: "Gagal mengirimkan stream audio."
        });
    }
};
