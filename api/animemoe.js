const axios = require('axios');

module.exports = async (req, res) => {
    try {
        let text = req.query.text || req.query.q || "Konnichiwa! Selamat datang.";
        
        // Google TTS Japanese Female Engine
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.substring(0, 200))}&tl=ja&client=tw-ob`;

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 5000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(Buffer.from(response.data));

    } catch (err) {
        return res.status(500).json({
            status: false,
            message: "Gagal memproses audio TTS.",
            error: err.message
        });
    }
};
