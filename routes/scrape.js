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
            '--disable-dev-shm-usage', // 메모리 부족 방지 필수
            '--disable-gpu',
            '--no-zygote',             // 프로세스 포크 방지 (메모리 절약)
            '--single-process',        // 단일 프로세스로 실행 (메모리 절약)
            '--disable-extensions',
            '--window-size=1366,768',  // 해상도를 조금 낮춤 (메모리 절약)
            '--disable-features=site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();

        // 1. [메모리 핵심] 이미지, 폰트, 미디어 차단 (리소스 요청 가로채기)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            // 이미지, 미디어, 폰트, 스타일시트(선택적) 차단
            // 주의: 스타일시트를 막으면 레이아웃 파악이 안 될 수 있어 이미지만 막습니다.
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // [API 낚시] 데이터 패킷 가로채기
        // let interceptedData = null;
        // page.on('response', async (response) => {
        //     const url = response.url();
        //     if (url.includes('api') || url.includes('IndividualEntry')) {
        //         try {
        //             const contentType = response.headers()['content-type'];
        //             if (contentType && contentType.includes('application/json')) {
        //                 const json = await response.json();
        //                 const str = JSON.stringify(json);
        //                 if (str.includes('Swim') || str.includes('Run') || str.includes('Intervals')) {
        //                     console.log(`[Network] 🎣 Data found in API!`);
        //                     interceptedData = json;
        //                 }
        //             }
        //         } catch (e) {}
        //     }
        // });

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch(e) { console.log("Timeout, continuing..."); }

        // ============================================================
        // 🔨 [수정됨] 장애물 파괴 (page.$x 대신 page.$$ 사용)
        // ============================================================
        console.log('[Scrape] Hunting for buttons...');
        
        const buttonTexts = ["continue", "accept",  "okay", "got it"];
        
        for (const btnText of buttonTexts) {
            try {
                // [수정 포인트] v23 이상에서는 xpath/ 접두어 사용해야 함
                // //* -> xpath///*
                const selector = `xpath/// *[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${btnText}')]`;
                const buttons = await page.$$(selector);
                
                for (const button of buttons) {
                    const isVisible = await button.boundingBox();
                    if (isVisible) {
                        console.log(`[Scrape] 🖱️ Clicking button: "${btnText}"`);
                        await button.click();
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } catch (e) { 
                // 무시 (버튼 없으면 패스) 
            }
        }



        console.log('[Scrape] Smart Scrolling...');
        
        await page.evaluate(async () => {
            // 최대 5번만(약 1500px) 내립니다. 무한 스크롤 방지.
            for (let i = 0; i < 6; i++) {
                // 화면에 'Swim'이나 'Race Splits'라는 글자가 보이는지 체크
                const bodyText = document.body.innerText;
                if (bodyText.includes('Swim') && bodyText.includes('Run')) {
                    // 데이터 찾았으면 스크롤 멈춤!
                    console.log('Data detected on screen, stopping scroll.');
                    break;
                }
                
                // 못 찾았으면 300px만 살짝 내림
                window.scrollBy(0, 300);
                // 데이터 로딩 대기 (0.8초)
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        });
        
        await new Promise(r => setTimeout(r, 2000));

        // ============================================================
        // 📊 [핵심 수정] 다중 라인 탐색 파서 (Multi-line Lookahead)
        // ============================================================
        console.log('[Scrape] Parsing text with lookahead...');
        
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
        };

        // (A) 네트워크 데이터 우선 확인
        // if (interceptedData) {
        //     console.log('[Scrape] Using Network Data');
        //     const intervals = interceptedData.intervals || (interceptedData.courses ? interceptedData.courses[0].intervals : []);
        //     if (interceptedData.displayName) result.name = interceptedData.displayName;
        //     else if (interceptedData.entry) result.name = interceptedData.entry.displayName;

        //     intervals.forEach(inv => {
        //         const name = (inv.intervalName || inv.IntervalName || "").toLowerCase();
        //         const time = (inv.timeString || inv.TimeString || "-");
        //         if (name.includes('swim')) result.swim = time;
        //         else if (name.includes('bike')) result.bike = time;
        //         else if (name.includes('run')) result.run = time;
        //         else if (name.includes('t1')) result.t1 = time;
        //         else if (name.includes('t2')) result.t2 = time;
        //     });
        //     if (interceptedData.result) result.total = interceptedData.result.timeString;
        // } 
        
        // (B) 텍스트 파싱 (이게 진짜입니다)
        if (result.name === 'Unknown' || result.swim === '-') {
            const htmlData = await page.evaluate(() => {
                let res = { name: null, ageGender: null };
                
                // [1] ID로 이름/나이 추출
                const nameEl = document.querySelector('#athlete-profile-link');
                if (nameEl) res.name = nameEl.innerText.trim();

                const ageEl = document.querySelector('#ageGender');
                if (ageEl) res.ageGender = ageEl.innerText.trim();

                // [2] 텍스트 라인 분석
                const text = document.body.innerText;
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                
                // 🔥 [수정] 정규식 분리 운용
                // raceTimeRegex: 시:분:초 (예: 1:15:39) -> 주요 종목용
                const raceTimeRegex = /^\d{1,2}:\d{2}:\d{2}$/; 
                
                // transTimeRegex: 분:초 (예: 4:55, 05:12) -> 바꿈터용
                const transTimeRegex = /^\d{1,2}:\d{2}$/;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];

                    // 종목명을 찾으면 -> 그 뒤 10줄을 뒤져서 시간을 찾는다.
                    if (line === 'Swim' || line.includes('Swim')) {
                        for (let j = 1; j <= 8; j++) { // 뒤로 8칸까지 확인
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                                res.swim = lines[i+j];
                                break; // 찾았으면 루프 탈출
                            }
                        }
                    }
                    if (line === 'Bike' || line === 'Cycle' || line.includes('Bike/Cycle')) {
                        for (let j = 1; j <= 8; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                                res.bike = lines[i+j];
                                break;
                            }
                        }
                    }
                    if (line === 'Run' || line.includes('Run')) {
                        for (let j = 1; j <= 8; j++) {
                            if (lines[i+j] && lines[i+j].match(raceTimeRegex)) {
                                res.run = lines[i+j];
                                break;
                            }
                        }
                    }
                    if (line === 'Transition' || line === 'T1') {
                         for (let j = 1; j <= 8; j++) {
                            if (lines[i+j] && lines[i+j].match(transTimeRegex)) {
                                if(!res.t1) res.t1 = lines[i+j]; // 첫번째는 T1
                                else res.t2 = lines[i+j];        // 두번째는 T2
                                break;
                            }
                        }
                    }
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

            // 덮어쓰기
            if (htmlData.name) result.name = htmlData.name;
            if (htmlData.swim) result.swim = htmlData.swim;
            if (htmlData.bike) result.bike = htmlData.bike;
            if (htmlData.run) result.run = htmlData.run;
            if (htmlData.t1) result.t1 = htmlData.t1;
            if (htmlData.t2) result.t2 = htmlData.t2;
            if (htmlData.total) result.total = htmlData.total;
        }


        // 스크린샷 (디버깅용)
        let screenshot = null;
        if (result.name === 'Unknown' || result.swim === '-') {
            console.log('[Debug] Data missing, taking FULL PAGE screenshot...');
            // [중요] fullPage: true 옵션 사용
            //const rawScreenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40, fullPage: true });
            //screenshot = `data:image/jpeg;base64,${rawScreenshot}`;
        }

        console.log(`[Scrape] Final: ${JSON.stringify(result)}`);
        res.json({ bib, ...result, screenshot });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;