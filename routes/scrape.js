const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

// 실제 주소: /api/scrape (server.js에서 설정함)
router.get('/', async (req, res) => {
    const { bib, urlTemplate } = req.query;

    if (!bib || !urlTemplate) {
        return res.status(400).json({ error: 'Bib and urlTemplate required' });
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

    try {
        const page = await browser.newPage();
        const targetUrl = urlTemplate.replace('{bib}', bib);

        // 리소스 차단 (속도 최적화)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 페이지 접속 (30초)
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 데이터 대기
        try {
            await page.waitForSelector('h3', { timeout: 5000 });
        } catch (e) {}

        // 데이터 추출
        const data = await page.evaluate(() => {
            let result = { name: 'Unknown', swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' };
            
            const nameEl = document.querySelector('h1');
            if (nameEl) result.name = nameEl.innerText.trim();
            
            const headings = Array.from(document.querySelectorAll('h3'));
            const splitHeader = headings.find(h => h.innerText.includes('Race Splits'));
            
            if (splitHeader) {
                const rows = Array.from(document.querySelectorAll('.row.mx-0'));
                let transitionCount = 0;
                rows.forEach(row => {
                    const text = row.innerText;
                    const cols = row.querySelectorAll('.col');
                    if (cols.length === 0) return;
                    
                    const timeVal = cols[cols.length - 1].innerText.replace(/\n/g, '').trim();
                    if (!timeVal || timeVal === '--') return;

                    if (text.includes('Swim')) result.swim = timeVal;
                    else if (text.includes('Bike') || text.includes('Cycle')) result.bike = timeVal;
                    else if (text.includes('Run')) result.run = timeVal;
                    else if (text.includes('Transition')) {
                        transitionCount++;
                        if (transitionCount === 1) result.t1 = timeVal;
                        else if (transitionCount === 2) result.t2 = timeVal;
                    } else if (text.includes('Full Course') || text.includes('Finish')) {
                        result.total = timeVal;
                    }
                });
            }
            return result;
        });

        res.json({ bib, ...data });

    } catch (error) {
        console.error('Scraping Error:', error);
        res.status(500).json({ error: 'Scraping failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;