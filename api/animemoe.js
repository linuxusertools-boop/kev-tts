const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Helper: Mengubah file lokal menjadi Data URI (Base64) untuk Gradio
 */
function fileToDataURI(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File sample audio tidak ditemukan di: ${filePath}`);
    }
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    
    // Deteksi mime-type sederhana
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = 'audio/mpeg';
    if (ext === '.wav') mimeType = 'audio/wav';
    if (ext === '.ogg') mimeType = 'audio/ogg';

    return {
        data: `data:${mimeType};base64,${base64Data}`,
        name: path.basename(filePath)
    };
}

/**
 * ENGINE 1: VoxCPM Hugging Face Space (Voice Cloning Mode)
 */
async function fetchVoxCPM(text, samplePath = '/storage/sample.mp3') {
    const spaceUrl = "https://openbmb-voxcpm-demo.hf.space";
    const cleanedText = text.substring(0, 300);

    // 1. Ambil file audio sample dan ubah ke format Data URI / Gradio File Object
    const sampleAudio = fileToDataURI(samplePath);

    // 2. Submit job ke /call/predict dengan membawa sample audio di parameter index 1
    const initRes = await axios.post(`${spaceUrl}/call/predict`, {
        data: [
            cleanedText,                   // [0] Text input
            {                              // [1] Prompt Audio File (Sample Voice)
                data: sampleAudio.data,
                name: sampleAudio.name,
                is_file: true
            },
            ""                             // [2] Prompt Text (opsional, kosongkan jika tidak ada transcript sample)
        ]
    }, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
    });

    const eventId = initRes.data?.event_id;
    if (!eventId) throw new Error("Gagal mendapatkan Event ID dari VoxCPM");

    // 3. Stream SSE Listener untuk mengambil URL Audio Hasil Synthesize
    const streamRes = await axios.get(`${spaceUrl}/call/predict/${eventId}`, {
        responseType: 'text',
        timeout: 20000
    });

    let audioUrl = null;
    const lines = streamRes.data.split('\n');

    for (const line of lines) {
        if (line.startsWith('data:')) {
            try {
                const parsed = JSON.parse(line.replace('data:', '').trim());
                if (Array.isArray(parsed) && parsed[0]?.url) {
                    audioUrl = parsed[0].url;
                    break;
                }
            } catch (e) {
                // Ignore non-JSON lines inside SSE stream
            }
        }
    }

    if (!audioUrl) throw new Error("URL audio tidak ditemukan dalam SSE response VoxCPM");

    // 4. Download WAV/MP3 Binary Buffer Hasil Cloning
    const audioStream = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 10000
    });

    return Buffer.from(audioStream.data);
}

/**
 * ENGINE 2: TikTok Cute Anime Voice (jp_001) - Fallback 1
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
 * ENGINE 3: Youdao Japanese Synthesizer - Fallback 2
 */
async function fetchYoudaoAnimeTTS(text) {
    const cleanedText = encodeURIComponent(text.substring(0, 300));
    const url = `https://dict.youdao.com/dictvoice?audio=${cleanedText}&le=jap`;

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
    });

    return Buffer.from(response.data);
}

module.exports = async (req, res) => {
    try {
        let text = req.query.text || req.query.q;

        if (!text || !text.trim()) {
            text = "Konnichiwa! Silakan masukkan teks yang ingin diubah menjadi suara.";
        }

        // Lokasi file sample audio referensi yang akan ditiru
        const SAMPLE_AUDIO_PATH = '/storage/sample.mp3';

        let audioBuffer = null;

        // Multilevel Fallback Execution
        try {
            audioBuffer = await fetchVoxCPM(text, SAMPLE_AUDIO_PATH);
        } catch (e1) {
            console.warn("Engine 1 (VoxCPM Cloning) failed, fallback to Engine 2...", e1.message);
            try {
                audioBuffer = await fetchTikTokAnimeProxy(text);
            } catch (e2) {
                console.warn("Engine 2 (TikTok) failed, fallback to Engine 3...", e2.message);
                audioBuffer = await fetchYoudaoAnimeTTS(text);
            }
        }

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Disposition', 'inline; filename="voxcpm_clone.wav"');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        return res.status(200).send(audioBuffer);

    } catch (fatalError) {
        console.error('Fatal TTS Error:', fatalError.message);
        return res.status(500).json({
            status: false,
            message: "Gagal memproses seluruh engine audio TTS.",
            error: fatalError.message
        });
    }
};
