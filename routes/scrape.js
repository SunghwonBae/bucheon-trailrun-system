const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

// [브라우저 재사용] 전역 변수
let globalBrowser = null;

async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }
    console.log('[System] Launching new Chrome instance...');
    globalBrowser = await puppeteer.launch({
        headless: 'new',
        executablePath: '/usr/bin/google-chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--window-size=1366,768',
            '--disable-features=site-per-process'
        ]
    });
    return globalBrowser;
}

router.get('/', async (req, res) => {
    const { bib, urlTemplate } = req.query;

    if (!bib || !urlTemplate) {
        return res.status(400).json({ error: 'Bib and urlTemplate required' });
    }

    console.log(`[Scrape] Start: Bib ${bib}`);
    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        // 리소스 차단 (속도 향상)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const targetUrl = urlTemplate.replace('{bib}', bib);
        
        // 1. 페이지 접속 (타임아웃 30초로 넉넉하게)
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch(e) { console.log("Nav timeout, continuing..."); }

        // 2. 팝업 닫기 시도
        const buttonTexts = ["continue", "accept", "okay", "got it", "close"];
        for (const btnText of buttonTexts) {
            try {
                const selector = `xpath/// *[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${btnText}')]`;
                const buttons = await page.$$(selector);
                for (const button of buttons) {
                    try { if (await button.boundingBox()) await button.click(); } catch (err) {}
                }
            } catch (e) {}
        }

        // 3. [수정됨] 스크롤 로직 안정화 (너무 빠르면 안 됨)
        await page.evaluate(async () => {
            // 총 5번 내림 (약 2000px)
            for (let i = 0; i < 5; i++) {
                const bodyText = document.body.innerText;
                // 핵심 데이터 보이면 즉시 중단
                if (bodyText.includes('Swim') && bodyText.includes('Run') && bodyText.includes('Bike')) {
                    break;
                }
                window.scrollBy(0, 500); 
                // [중요] 대기 시간을 100ms -> 400ms로 늘림 (데이터 로딩 시간 확보)
                await new Promise(resolve => setTimeout(resolve, 400)); 
            }
        });
        
        // 렌더링 안정화 (0.5초 대기)
        await new Promise(r => setTimeout(r, 500));

        // ============================================================
        // 4. 데이터 파싱 함수 (재사용을 위해 분리)
        // ============================================================
        const parseData = async () => {
            return await page.evaluate(() => {
                let res = { name: null, ageGender: null, swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' };
                
                const nameEl = document.querySelector('#athlete-profile-link');
                if (nameEl) res.name = nameEl.innerText.trim();

                const ageEl = document.querySelector('#ageGender');
                if (ageEl) res.ageGender = ageEl.innerText.trim();

                const text = document.body.innerText;
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                
                const raceTimeRegex = /^\d{1,2}:\d{2}:\d{2}$/; 
                const transTimeRegex = /^\d{1,2}:\d{2}$/;       

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];

                    if (line.includes('Swim')) {
                        for (let j = 1; j <= 10; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) { res.swim = lines[i+j]; break; }
                        }
                    }
                    if (line.includes('Bike') || line.includes('Cycle')) {
                        for (let j = 1; j <= 10; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) { res.bike = lines[i+j]; break; }
                        }
                    }
                    if (line.includes('Run')) {
                        for (let j = 1; j <= 10; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) { res.run = lines[i+j]; break; }
                        }
                    }
                    if (line.includes('Transition') || line.includes('Trans') || line === 'T1' || line === 'T2') {
                        for (let j = 1; j <= 10; j++) {
                            if (lines[i+j] && lines[i+j].match(transTimeRegex)) {
                                if (!res.t1 || res.t1 === '-') res.t1 = lines[i+j];
                                else res.t2 = lines[i+j];
                                break;
                            }
                        }
                    }
                    if (line.includes('Full Course') || line.includes('Finish') || line.includes('Total')) {
                        for (let j = 1; j <= 10; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) { res.total = lines[i+j]; break; }
                        }
                    }
                }
                return res;
            });
        };

        // 1차 파싱 시도
        let parsedData = await parseData();

        // 5. [안전장치] 만약 데이터가 없으면(Unknown), 조금 더 기다렸다가 재시도 (Retry)
        if (!parsedData.name || parsedData.swim === '-') {
            console.log(`[Scrape] Data incomplete (${bib}), retrying in 2s...`);
            
            // 2초 대기 (네트워크 지연 대응)
            await new Promise(r => setTimeout(r, 2000));
            
            // 혹시 모르니 스크롤 한 번 더 내림
            await page.evaluate(() => window.scrollBy(0, 300));
            await new Promise(r => setTimeout(r, 500));

            // 2차 파싱 시도
            parsedData = await parseData();
        }

        console.log(`[Scrape] Done: ${bib} / ${parsedData.name}`);
        res.json({ bib, ...parsedData });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Failed' });
    } finally {
        if (page) {
            try { await page.close(); } catch(e) {}
        }
    }
});

module.exports = router;