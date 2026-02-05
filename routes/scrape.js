const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

router.get('/', async (req, res) => {
    const { bib, urlTemplate } = req.query;

    if (!bib || !urlTemplate) {
        return res.status(400).json({ error: 'Bib and urlTemplate required' });
    }

    console.log(`[Scrape] Start: Bib ${bib}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: '/usr/bin/google-chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-features=site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        
        // 1. 유저 에이전트 설정
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 2. [핵심] 네트워크 스니핑 (데이터 가로채기)
        let interceptedData = null;

        page.on('response', async (response) => {
            const url = response.url();
            // JSON 데이터이면서 API 호출인 경우만 낚아챔
            if ((url.includes('api') || url.includes('json') || url.includes('IndividualEntry')) && !interceptedData) {
                try {
                    const contentType = response.headers()['content-type'];
                    if (contentType && contentType.includes('application/json')) {
                        const json = await response.json();
                        // 수영(Swim)이나 런(Run) 데이터가 들어있으면 "이거다!" 하고 저장
                        if (JSON.stringify(json).includes('Swim') || JSON.stringify(json).includes('Run')) {
                            console.log(`[Network] 🎣 Caught data from: ${url}`);
                            interceptedData = json; 
                        }
                    }
                } catch (e) { /* 무시 */ }
            }
        });

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        // 3. [핵심 수정] 타임아웃 방어 로직 (좀비 모드)
        // 페이지 로딩이 60초가 걸리더라도, 에러로 죽지 않고 "일단 진행시켜" 합니다.
        try {
            // waitUntil을 'domcontentloaded'로 완화 (이미지 로딩 안 기다림)
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // 페이지 접속 후 데이터가 올 때까지 5초 정도만 더 기다려줌 (여유)
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (e) {
            console.log(`[Scrape] ⚠️ Navigation Timeout! But checking if we caught data...`);
            // 여기서 에러를 throw 하지 않고 밑으로 흘려보냅니다.
        }

        // 4. 쿠키 배너 삭제 시도 (선택 사항)
        try {
            const cookieBtns = await page.$x("//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'okay')]");
            if (cookieBtns.length > 0) await cookieBtns[0].click();
        } catch (e) {}


        // 5. 결과 정리
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF',
            source: 'HTML'
        };

        if (interceptedData) {
            // [성공 케이스] 네트워크에서 데이터를 건졌을 때
            console.log('[Scrape] ✅ Using Intercepted Data!');
            result.source = 'Network_API';
            
            // 데이터 파싱 (Athlinks 구조 대응)
            let intervals = [];
            if (interceptedData.courses && interceptedData.courses[0]) {
                intervals = interceptedData.courses[0].intervals || [];
            } else if (interceptedData.intervals) {
                intervals = interceptedData.intervals;
            } else if (interceptedData.result && interceptedData.result.intervals) {
                intervals = interceptedData.result.intervals;
            }

            // 이름
            if (interceptedData.displayName) result.name = interceptedData.displayName;
            else if (interceptedData.entry && interceptedData.entry.displayName) result.name = interceptedData.entry.displayName;

            // 기록
            if (intervals) {
                intervals.forEach(inv => {
                    const name = (inv.intervalName || inv.IntervalName || "").toLowerCase();
                    const time = (inv.timeString || inv.TimeString || inv.time || inv.Time || "-");
                    
                    if (name.includes('swim')) result.swim = time;
                    else if (name.includes('bike') || name.includes('cycle')) result.bike = time;
                    else if (name.includes('run')) result.run = time;
                    else if (name.includes('t1')) result.t1 = time;
                    else if (name.includes('t2')) result.t2 = time;
                });
            }

            // 총 기록
            if (interceptedData.timeString) result.total = interceptedData.timeString;
            else if (interceptedData.result) result.total = interceptedData.result.timeString;

        } else {
            // [실패 케이스] 네트워크 데이터도 못 건졌을 때 -> HTML 텍스트 긁기 시도
            console.log('[Scrape] ⚠️ Intercept failed. Trying raw text fallback...');
            
            result = await page.evaluate(() => {
                let res = { name: 'Unknown', swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' };
                
                // 이름 추출 시도
                if (document.title && document.title.includes("'s")) {
                    res.name = document.title.split("'s")[0];
                }

                const bodyText = document.body.innerText;
                const lines = bodyText.split('\n');
                const timeRegex = /(\d{1,2}:\d{2}:\d{2})/;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    if (line.includes('Swim')) res.swim = (line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex)) || ['-'])[0];
                    if (line.includes('Bike')) res.bike = (line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex)) || ['-'])[0];
                    if (line.includes('Run')) res.run = (line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex)) || ['-'])[0];
                    if (line.includes('Finish') || line.includes('Total')) res.total = (line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex)) || ['-'])[0];
                }
                return res;
            });
        }

        console.log(`[Scrape] Final: ${result.name} / ${result.total}`);
        res.json({ bib, ...result });

    } catch (error) {
        console.error('[Scrape] Fatal Error:', error);
        res.status(500).json({ error: 'Scraping failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;