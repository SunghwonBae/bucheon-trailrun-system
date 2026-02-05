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
        
        // 유저 에이전트 (일반 윈도우 PC인 척 위장)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // ============================================================
        // 📡 [핵심 기술] 네트워크 패킷 가로채기 (Network Sniffing)
        // 화면에 뜨기 전에, 서버에서 오는 JSON 데이터를 직접 낚아챕니다.
        // ============================================================
        let interceptedData = null;

        page.on('response', async (response) => {
            const url = response.url();
            // Athlinks API URL 패턴 (IndividualEntry 1902 등)이 포함된 요청을 찾음
            // 보통 /api/Event/.. 또는 /IndividualEntry/.. 같은 패턴을 씀
            if (url.includes('api') || url.includes('json') || url.includes('IndividualEntry')) {
                try {
                    // 응답이 JSON인 경우만 확인
                    const contentType = response.headers()['content-type'];
                    if (contentType && contentType.includes('application/json')) {
                        const json = await response.json();
                        
                        // 우리가 찾는 데이터인지 확인 (intervals나 split 데이터가 있는지)
                        // Athlinks 데이터 구조: result.intervals 또는 courses[0].intervals
                        if (JSON.stringify(json).includes('Swim') || JSON.stringify(json).includes('Run')) {
                            console.log(`[Network] Found likely race data in: ${url}`);
                            // 가장 데이터가 풍부한 놈을 저장 (덮어쓰기)
                            interceptedData = json; 
                        }
                    }
                } catch (e) {
                    // JSON 파싱 에러는 무시 (이미지나 기타 리소스일 수 있음)
                }
            }
        });

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        // 🍪 쿠키 배너 클릭 (화면 가림 방지)
        try {
            // "OKAY, GOT IT" 버튼을 찾아서 클릭 (대소문자 무시 XPath)
            const cookieBtns = await page.$x("//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'okay')]");
            if (cookieBtns.length > 0) {
                await cookieBtns[0].click();
                console.log('[Scrape] Clicked Cookie Banner');
                await new Promise(r => setTimeout(r, 2000)); // 클릭 후 잠시 대기
            }
        } catch (e) { console.log('No cookie banner found'); }


        // ============================================================
        // 📊 데이터 정리 (API로 잡은 데이터 우선 사용)
        // ============================================================
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF',
            source: 'HTML' // 출처 표기
        };

        if (interceptedData) {
            // 1. 네트워크 스니핑 데이터가 있으면 그걸 파싱 (훨씬 정확함)
            console.log('[Scrape] Using Network Intercepted Data!');
            result.source = 'Network_API';
            
            // 데이터 구조가 복잡하므로 안전하게 탐색
            // (Athlinks API 구조에 따라 유동적으로 찾음)
            const rawString = JSON.stringify(interceptedData);
            
            // 정규식이나 객체 탐색으로 값 추출 (구조가 매번 다를 수 있어 안전하게 텍스트 검색 사용)
            // 예: "IntervalName": "Swim", ... "Time": "1:00:00"
            // 하지만 JSON 객체 탐색이 베스트. 여기서는 일반적인 Athlinks 구조를 가정해봄.
            
            // 만약 API 구조가 { courses: [{ intervals: [...] }] } 형태라면:
            let intervals = [];
            if (interceptedData.courses && interceptedData.courses[0] && interceptedData.courses[0].intervals) {
                intervals = interceptedData.courses[0].intervals;
            } else if (interceptedData.intervals) {
                intervals = interceptedData.intervals;
            } else if (interceptedData.result && interceptedData.result.intervals) {
                intervals = interceptedData.result.intervals;
            }

            // 이름 찾기
            if (interceptedData.displayName) result.name = interceptedData.displayName;
            else if (interceptedData.entry && interceptedData.entry.displayName) result.name = interceptedData.entry.displayName;

            // 기록 찾기
            intervals.forEach(inv => {
                const name = (inv.intervalName || inv.IntervalName || "").toLowerCase();
                const time = (inv.timeString || inv.TimeString || inv.time || inv.Time || "-");
                
                if (name.includes('swim')) result.swim = time;
                else if (name.includes('bike') || name.includes('cycle')) result.bike = time;
                else if (name.includes('run')) result.run = time;
                else if (name.includes('t1')) result.t1 = time;
                else if (name.includes('t2')) result.t2 = time;
            });

            // 총 기록
            if (interceptedData.timeString) result.total = interceptedData.timeString;
            else if (interceptedData.result && interceptedData.result.timeString) result.total = interceptedData.result.timeString;

        } else {
            // 2. API를 못 잡았으면 기존 HTML 방식 시도 (Fallback)
            // 하지만 이번엔 클래스 이름 대신 "텍스트 위치"로 찾습니다.
            console.log('[Scrape] Network capture failed, trying fallback HTML parsing...');
            
            result = await page.evaluate(() => {
                let res = { name: 'Unknown', swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' };
                
                // 이름: 타이틀에서 추출 시도 ("O Jin Kim's Race Results")
                if (document.title && document.title.includes("'s")) {
                    res.name = document.title.split("'s")[0];
                }

                // 화면에 보이는 모든 텍스트 덩어리를 가져옴
                const bodyText = document.body.innerText;
                const lines = bodyText.split('\n');

                // 텍스트 라인을 순회하며 "Swim", "Bike" 바로 옆이나 다음 줄에 있는 시간 패턴(00:00:00)을 찾음
                const timeRegex = /(\d{1,2}:\d{2}:\d{2})/; // 1:02:33 같은 패턴

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // 현재 줄이 종목명이면, 그 줄이나 다음 줄에서 시간을 찾음
                    if (line.includes('Swim')) {
                        const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                        if (match) res.swim = match[0];
                    }
                    if (line.includes('Bike')) {
                        const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                        if (match) res.bike = match[0];
                    }
                    if (line.includes('Run')) {
                        const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                        if (match) res.run = match[0];
                    }
                    if (line.includes('T1')) {
                         const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                         if (match) res.t1 = match[0];
                    }
                    if (line.includes('T2')) {
                         const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                         if (match) res.t2 = match[0];
                    }
                    if (line.includes('Total') || line.includes('Finish')) {
                        const match = line.match(timeRegex) || (lines[i+1] && lines[i+1].match(timeRegex));
                        if (match) res.total = match[0];
                    }
                }
                return res;
            });
        }

        console.log(`[Scrape] Final Result: ${JSON.stringify(result)}`);
        res.json({ bib, ...result });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Scraping failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;