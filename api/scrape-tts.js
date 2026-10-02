// api/scrape-tts.js
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export default async function handler(req, res) {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto('https://anytospeech.com/ai-voice-generator/anime-girl-shy', {
      waitUntil: 'networkidle2',
    });

    // Ketik teks ke dalam textarea
    await page.type('textarea', text);

    // Klik tombol generate / submit
    await page.click('button[type="submit"]');

    // Tunggu tag <audio> muncul
    await page.waitForSelector('audio source, audio', { timeout: 15000 });

    const audioSrc = await page.evaluate(() => {
      const audioEl = document.querySelector('audio source') || document.querySelector('audio');
      return audioEl ? audioEl.src : null;
    });

    await browser.close();

    return res.status(200).json({ success: true, audio_url: audioSrc });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
}
