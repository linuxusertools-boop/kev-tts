const axios = require('axios');

/**
 * Primary Engine: VITS Anime Moe Speech Synthesizer
 * Menggunakan Voice Model: 'Sayako' / 'Tsukuyomi' / 'Moe Anime Girl'
 */
async function fetchMoeVitsTTS(text) {
    const cleanedText = text.substring(0, 300);
    
    // API Engine khusus Anime Voice Generation
    const url = `https://api.lolicon.app/v1/tts`;
    const response = await axios.get(url, {
        params: {
            text: cleanedText,
            speaker: 'anime_girl',
            format: 'mp3'
        },
        responseType: 'arraybuffer',
        timeout: 12000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    return Buffer.from(response.data);
}

/**
 * Secondary Engine: VoiceVox / Kuroshiro Anime Engine
 */
async function fetchVoiceVoxMoe(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    // Endpoint VoiceVox Speaker #14 (Moe Anime Voice)
    const url = `https://voicevox-engine.vercel.app/synth?text=${cleanedText}&speaker=14`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 12000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    });

    return Buffer.from(response.data);
}

/**
 * Tertiary Engine: Auto-translated Japanese Anime Voice
 */
async function fetchTranslateMoe(text) {
    const encoded = encodeURIComponent(text.substring(0, 300));
    const url = `https://dict.youdao.com/dictvoice?audio=${encoded}&le=jap`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        // 1. Ambil input teks dari query parameter ?text=
        let text = req.query.text || req.query.q;

        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara anime.";
        }

        let audioBuffer = null;

        // 2. Eksekusi Engine 1 (Anime VITS)
        try {
            audioBuffer = await fetchMoeVitsTTS(text);
        } catch (e1) {
            // 3. Eksekusi Engine 2 (VoiceVox Moe) jika Engine 1 sibuk
            try {
                audioBuffer = await fetchVoiceVoxMoe(text);
            } catch (e2) {
                // 4. Eksekusi Engine 3 jika Engine 2 gagal
                audioBuffer = await fetchTranslateMoe(text);
            }
        }

        // 5. Kirim Audio Stream MP3 langsung
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'inline; filename="animemoe.mp3"');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        return res.status(200).send(audioBuffer);

    } catch (fatalError) {
        // 100% Anti Crash Response
        console.error('Fatal TTS Error:', fatalError.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses suara anime.",
            error: fatalError.message
        });
    }
};
