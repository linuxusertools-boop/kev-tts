const axios = require('axios');

/**
 * Primary Engine: TikTok TTS - Japanese/Anime Voice (jp_001)
 */
async function fetchTikTokAnimeTTS(text) {
    const cleanedText = text.substring(0, 300);
    
    // Voice code 'jp_001' = Cute Japanese Female / Anime Voice
    const response = await axios.post("https://tiktok-tts.com/api/tts", {
        text: cleanedText,
        voice: "jp_001"
    }, {
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 10000
    });

    if (!response.data || !response.data.audio) {
        throw new Error("TikTok TTS returned empty response");
    }

    // TikTok API mengembalikan audio dalam format Base64
    const base64Data = response.data.audio;
    return Buffer.from(base64Data, 'base64');
}

/**
 * Secondary Engine: StreamElements Cute Voice (Salli / Mizuki)
 */
async function fetchStreamElementsTTS(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    // Voice 'Mizuki' (Japanese) atau 'Salli'
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=Mizuki&text=${cleanedText}`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        timeout: 10000
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        // 1. Ambil query 'text' atau 'q'
        let text = req.query.text || req.query.q;

        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
        }

        let audioBuffer = null;

        // 2. Coba Engine 1 (TikTok Anime Voice)
        try {
            audioBuffer = await fetchTikTokAnimeTTS(text);
        } catch (e1) {
            console.warn("Primary TikTok Anime TTS failed, trying Secondary Engine...", e1.message);
            // 3. Coba Engine 2 (StreamElements Mizuki Voice)
            try {
                audioBuffer = await fetchStreamElementsTTS(text);
            } catch (e2) {
                console.error("Secondary TTS failed:", e2.message);
                throw new Error("Seluruh server voice anime sedang tidak merespon.");
            }
        }

        // 4. Return Direct Audio Stream MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        
        return res.status(200).send(audioBuffer);

    } catch (fatalError) {
        console.error('Fatal TTS Error:', fatalError.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses suara anime.",
            error: fatalError.message
        });
    }
};
