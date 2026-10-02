const axios = require('axios');

/**
 * ENGINE 1: StreamElements Native Anime/Japanese Voice (Mizuki - Cute Japanese Girl)
 * Endpoint ini 100% diizinkan untuk Serverless Vercel & Unlimited.
 */
async function fetchStreamElementsMoe(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 400));
    // Voice 'Mizuki' = Japanese Female Voice (Anime/Moe Accent)
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Mizuki&text=${cleanedText}`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8"
        },
        timeout: 10000
    });

    return Buffer.from(response.data);
}

/**
 * ENGINE 2: VoiceVox Official Public Relay (Speaker 14: Kurita / Moe Girl)
 */
async function fetchVoiceVoxRelay(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    // Speaker 14 = Anime Moe Girl
    const url = `https://voicevox-engine.onrender.com/synth?text=${cleanedText}&speaker=14`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        timeout: 12000
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        // 1. Tangkap input query parameter 'text' atau 'q'
        let text = req.query.text || req.query.q;

        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
        }

        let audioBuffer = null;

        // 2. Eksekusi Engine 1 (StreamElements Mizuki Anime Voice)
        try {
            audioBuffer = await fetchStreamElementsMoe(text);
        } catch (e1) {
            console.warn("Engine 1 failed, switching to Engine 2 (VoiceVox Relay)...", e1.message);
            // 3. Eksekusi Engine 2 jika Engine 1 sibuk
            audioBuffer = await fetchVoiceVoxRelay(text);
        }

        // 4. Return Direct Audio MP3 Stream
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
