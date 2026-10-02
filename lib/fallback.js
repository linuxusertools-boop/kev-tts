'use strict';
/**
 * Fallback terakhir bila VoxCPM benar-benar tidak bisa dipakai (Space down / kuota habis).
 * Suara BUKAN hasil clone — respons selalu diberi header X-TTS-Engine: youdao-fallback.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function detectLang(text, hint) {
  const h = String(hint || '').toLowerCase();
  const map = { ja: 'jap', jp: 'jap', jap: 'jap', en: 'eng', eng: 'eng', ko: 'ko', fr: 'fr', zh: 'zh' };
  if (map[h]) return map[h];
  if (/[\u3040-\u30ff]/.test(text)) return 'jap';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return 'eng';
}

async function youdao(text, lang, engine = 'youdao-fallback') {
  const clipped = [...text].slice(0, 200).join('');
  const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(clipped)}&le=${detectLang(clipped, lang)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`Youdao HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 512) throw new Error('Youdao mengembalikan audio kosong');
  return { buffer, mime: 'audio/mpeg', ext: 'mp3', engine, cloned: false };
}

module.exports = { youdao };
