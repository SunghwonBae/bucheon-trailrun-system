const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

// [핵심 1] 브라우저 인스턴스를 전역변수로 관리 (매번 켜지 않음)
let globalBrowser = null;

async function getBrowser() {
    // 이미 켜져 있고 연결되어 있으면 그대로 반환 (재사용)
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }

    // 없으면 새로 실행 (최초 1회만 실행됨)
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
        // [핵심 2] 켜져 있는 브라우저 가져오기 (속도 대폭 향상)
        const browser = await getBrowser();
        
        // 새 탭만 열기 (가벼움)
        page = await browser.newPage();

        // 리소스 차단
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
        
        // [핵심 3] 타임아웃 단축 (안 되면 빨리 포기하고 다음 단계로)
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch(e) { console.log("Nav timeout, continuing..."); }

        // 방해꾼 제거 (빠르게 시도)
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

        // [핵심 4] 스크롤 속도 향상 (대기 시간 줄임)
        // 0.5초 대기 -> 0.1초 대기로 변경 (데이터는 생각보다 빨리 뜸)
        await page.evaluate(async () => {
            for (let i = 0; i < 5; i++) { // 횟수 6->5로 줄임
                const bodyText = document.body.innerText;
                // 필수 데이터 3종 세트가 보이면 즉시 중단
                if (bodyText.includes('Swim') && bodyText.includes('Run') && bodyText.includes('Bike')) {
                    break;
                }
                window.scrollBy(0, 600); // 스크롤 보폭 늘림 (400 -> 600)
                await new Promise(resolve => setTimeout(resolve, 100)); // 대기 시간 대폭 단축 (500ms -> 100ms)
            }
        });
        
        // 렌더링 안정화 (0.5초만 대기)
        await new Promise(r => setTimeout(r, 500));

        // 데이터 파싱
        const parsedData = await page.evaluate(() => {
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

        console.log(`[Scrape] Done: ${bib}`);
        res.json({ bib, ...parsedData });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Failed' });
    } finally {
        if (page) await page.close(); 
        // [중요] browser.close()는 하지 않습니다! (계속 켜둠)
    }
});

module.exports = router;