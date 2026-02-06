const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

router.get('/', async (req, res) => {
    const { bib, urlTemplate } = req.query;

    if (!bib || !urlTemplate) {
        return res.status(400).json({ error: 'Bib and urlTemplate required' });
    }

    console.log(`[Scrape] Start: Bib ${bib}`);

    // 1. 브라우저 실행 옵션 (메모리 최적화 유지)
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: '/usr/bin/google-chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // 메모리 부족 방지 (필수)
            '--disable-gpu',
            '--no-zygote',             // 프로세스 포크 방지
            '--single-process',        // 단일 프로세스 (메모리 절약 핵심)
            '--disable-extensions',
            '--window-size=1366,768',  // 해상도 최소화
            '--disable-features=site-per-process'
        ]
    });

    let page = null;

    try {
        page = await browser.newPage();

        // 2. 리소스 차단 (이미지, 폰트, CSS 차단하여 메모리 확보)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        // 3. [개선] 로딩 전략 변경: networkidle2 -> domcontentloaded (훨씬 빠르고 가벼움)
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch(e) { console.log("Navigation timeout, continuing..."); }

        // 4. 팝업/버튼 닫기
        const buttonTexts = ["continue", "accept", "okay", "got it", "close"];
        console.log('[Scrape] Clearing popups...');
        
        for (const btnText of buttonTexts) {
            try {
                // XPath로 버튼 찾기
                const selector = `xpath/// *[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${btnText}')]`;
                const buttons = await page.$$(selector);
                
                for (const button of buttons) {
                    // CSS가 없어서 boundingBox 계산이 안될 수 있으므로 에러 무시하고 클릭 시도
                    try {
                        if (await button.boundingBox()) {
                            await button.click();
                            await new Promise(r => setTimeout(r, 300));
                        }
                    } catch (err) {}
                }
            } catch (e) {}
        }

        // 5. 스마트 스크롤 (데이터 발견 시 중단)
        console.log('[Scrape] Smart Scrolling...');
        await page.evaluate(async () => {
            // 최대 6번(약 2400px)까지만 스크롤
            for (let i = 0; i < 6; i++) {
                const bodyText = document.body.innerText;
                // 핵심 키워드가 보이면 즉시 중단
                if (bodyText.includes('Swim') && bodyText.includes('Run') && bodyText.includes('Bike')) {
                    console.log('Data detected, stopping scroll.');
                    break;
                }
                window.scrollBy(0, 400);
                await new Promise(resolve => setTimeout(resolve, 500)); // 대기 시간 단축
            }
        });
        
        // 렌더링 안정화 대기
        await new Promise(r => setTimeout(r, 1000));

        // 6. 데이터 파싱 (Lookahead + Dual Regex)
        console.log('[Scrape] Parsing text...');
        
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
        };

        const parsedData = await page.evaluate(() => {
            let res = { name: null, ageGender: null };
            
            // [A] ID 기반 추출 (가장 정확)
            const nameEl = document.querySelector('#athlete-profile-link');
            if (nameEl) res.name = nameEl.innerText.trim();

            const ageEl = document.querySelector('#ageGender');
            if (ageEl) res.ageGender = ageEl.innerText.trim();

            // [B] 텍스트 라인 분석
            const text = document.body.innerText;
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            
            // 정규식 분리 (기록 vs 바꿈터)
            const raceTimeRegex = /^\d{1,2}:\d{2}:\d{2}$/; // 예: 1:15:39
            const transTimeRegex = /^\d{1,2}:\d{2}$/;       // 예: 4:55

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Swim (raceTimeRegex)
                if (line === 'Swim' || line.includes('Swim')) {
                    for (let j = 1; j <= 8; j++) {
                        if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                            res.swim = lines[i+j];
                            break;
                        }
                    }
                }
                // Bike (raceTimeRegex)
                if (line === 'Bike' || line === 'Cycle' || line.includes('Bike/Cycle')) {
                    for (let j = 1; j <= 8; j++) {
                        if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                            res.bike = lines[i+j];
                            break;
                        }
                    }
                }
                // Run (raceTimeRegex)
                if (line === 'Run' || line.includes('Run')) {
                    for (let j = 1; j <= 8; j++) {
                        if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                            res.run = lines[i+j];
                            break;
                        }
                    }
                }
                if (line === 'Transition'|| line.includes('Transition')) {
                        for (let j = 1; j <= 8; j++) {
                        if (lines[i+j] && lines[i+j].match(transTimeRegex)) {
                            if(!res.t1) res.t1 = lines[i+j]; // 첫번째는 T1
                            else res.t2 = lines[i+j];        // 두번째는 T2
                            break;
                        }
                    }
                }
                // Total (raceTimeRegex)
                if (line.includes('Full Course') || line.includes('Finish') || line.includes('Total')) {
                    for (let j = 1; j <= 8; j++) {
                        if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                            res.total = lines[i+j];
                            break;
                        }
                    }
                }
            }
            return res;
        });

        // 결과 병합
        if (parsedData.name) result.name = parsedData.name;
        if (parsedData.swim) result.swim = parsedData.swim;
        if (parsedData.bike) result.bike = parsedData.bike;
        if (parsedData.run) result.run = parsedData.run;
        if (parsedData.t1) result.t1 = parsedData.t1;
        if (parsedData.t2) result.t2 = parsedData.t2;
        if (parsedData.total) result.total = parsedData.total;

        console.log(`[Scrape] Final: ${JSON.stringify(result)}`);
        
        // 스크린샷 제거 (메모리 절약)
        res.json({ bib, ...result });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Failed', details: error.message });
    } finally {
        // [중요] 페이지와 브라우저 명시적 닫기
        if (page) await page.close();
        if (browser) await browser.close();
    }
});

module.exports = router;