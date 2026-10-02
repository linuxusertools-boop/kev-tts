const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

/**
 * Helper: Upload file audio lokal ke Gradio Server (/upload)
 * Mengembalikan metadata file objek yang valid untuk Gradio v4
 */
async function uploadSampleToGradio(filePath, spaceUrl) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File sample audio tidak ditemukan di: ${filePath}`);
    }

    const form = new FormData();
    form.append('files', fs.createReadStream(filePath));

    const uploadRes = await axios.post(`${spaceUrl}/upload`, form, {
        headers: {
            ...form.getHeaders()
        },
        timeout: 15000
    });

    if (!uploadRes.data || !uploadRes.data[0]) {
        throw new Error("Gagal mengunggah file sample ke Hugging Face Space");
    }

    // Mengembalikan objek file Gradio resmi
    const uploadedFile = uploadRes.data[0];
    return {
        path: uploadedFile,
        url: `${spaceUrl}/file=${uploadedFile}`,
        orig_name: path.basename(filePath),
        size: fs.statSync(filePath).size,
        mime_type: "audio/mpeg",
        is_stream: false
    };
}

/**
 * ENGINE 1: VoxCPM Hugging Face Space (Voice Cloning Mode)
 */
async function fetchVoxCPM(text, samplePath = '/storage/sample.mp3') {
    const spaceUrl = "https://openbmb-voxcpm-demo.hf.space";
    const cleanedText = text.substring(0, 300);

    // 1. Upload file sample.mp3 ke Gradio /upload terlebih dahulu
    const gradioFileObj = await uploadSampleToGradio(samplePath, spaceUrl);

    // 2. Submit job ke /call/predict menggunakan metadata file hasil upload
    const initRes = await axios.post(`${spaceUrl}/call/predict`, {
        data: [
            cleanedText,    // [0] Text input
            gradioFileObj,  // [1] Prompt Audio File Object dari /upload
            ""              // [2] Prompt Text
        ]
    }, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
    });

    const eventId = initRes.data?.event_id;
    if (!eventId) throw new Error("Gagal mendapatkan Event ID dari VoxCPM");

    // 3. Stream SSE Listener untuk mengambil URL Audio
    const streamRes = await axios.get(`${spaceUrl}/call/predict/${eventId}`, {
        responseType: 'text',
        timeout: 25000
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
                // Ignore non-JSON lines
            }
        }
    }

    if (!audioUrl) throw new Error("URL audio tidak ditemukan dalam response VoxCPM");

    // 4. Download Binary Audio Buffer
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

        // Jalur file sample lokal
        const SAMPLE_AUDIO_PATH = path.join(process.cwd(), 'storage', 'sample.mp3');

        let audioBuffer = null;

        // Executing Multi-level Fallback
        try {
            audioBuffer = await fetchVoxCPM(text, SAMPLE_AUDIO_PATH);
        } catch (e1) {
            console.warn("Engine 1 (VoxCPM Cloning) failed, falling back to Engine 2...", e1.message);
            try {
                audioBuffer = await fetchTikTokAnimeProxy(text);
            } catch (e2) {
                console.warn("Engine 2 (TikTok) failed, falling back to Engine 3...", e2.message);
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
