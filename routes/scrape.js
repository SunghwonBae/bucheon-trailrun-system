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
            '--window-size=1920,1080', // PC 화면 크기
            '--disable-features=site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // [API 낚시] 모든 JSON 응답을 감시합니다.
        let interceptedData = null;
        page.on('response', async (response) => {
            const url = response.url();
            // API 관련 URL이고 JSON이면 일단 찔러봅니다.
            if (url.includes('api') && response.request().resourceType() === 'xhr') {
                try {
                    const json = await response.json();
                    const str = JSON.stringify(json);
                    // "EventCourseId"나 "BibNum" 같은 키워드가 있으면 결과 데이터일 확률이 높음
                    if (str.includes('BibNum') || str.includes('Intervals') || str.includes('SplitName')) {
                        console.log(`[Network] 🎣 Caught Potentially Valid Data: ${url}`);
                        interceptedData = json;
                    }
                } catch (e) {}
            }
        });

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        // 타임아웃 넉넉하게 60초
        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch(e) { console.log("Navigation Timeout (Continuing...)"); }

        // [중요] 강제로 5초 더 대기 (React 렌더링 시간 확보)
        await new Promise(r => setTimeout(r, 5000));

        // 데이터 추출 시도
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
        };

        // 1순위: 네트워크 패킷 사용
        if (interceptedData) {
            console.log('[Scrape] Parsing Intercepted Data...');
            // 데이터 구조 파싱 로직 (Athlinks 일반적인 구조)
            const intervals = interceptedData.intervals || (interceptedData.courses ? interceptedData.courses[0].intervals : []);
            
            if (interceptedData.displayName) result.name = interceptedData.displayName;
            else if (interceptedData.entry) result.name = interceptedData.entry.displayName;

            if (intervals.length > 0) {
                intervals.forEach(inv => {
                    const name = (inv.intervalName || inv.IntervalName || "").toLowerCase();
                    const time = (inv.timeString || inv.TimeString || "-");
                    
                    if (name.includes('swim')) result.swim = time;
                    else if (name.includes('bike')) result.bike = time;
                    else if (name.includes('run')) result.run = time;
                    else if (name.includes('t1')) result.t1 = time;
                    else if (name.includes('t2')) result.t2 = time;
                });
                if (interceptedData.result) result.total = interceptedData.result.timeString;
            }
        } 
        
        // 2순위: HTML 텍스트 파싱
        if (result.name === 'Unknown') {
            console.log('[Scrape] Trying HTML fallback...');
            const htmlData = await page.evaluate(() => {
                const text = document.body.innerText;
                const lines = text.split('\n');
                let res = {};
                // 간단한 텍스트 매칭
                if (document.title) res.name = document.title.split("'s")[0];
                return { name: res.name, textSample: text.substring(0, 200) }; // 디버깅용 텍스트 샘플
            });
            if (htmlData.name) result.name = htmlData.name;
        }

        // =========================================================
        // 📸 [필살기] 스크린샷 찍기
        // 데이터가 없으면 화면을 찍어서 보내줍니다. (디버깅용)
        // =========================================================
        let screenshot = null;
        if (result.name === 'Unknown' || result.swim === '-') {
            console.log('[Debug] Data missing, taking screenshot...');
            // 스크린샷을 Base64 문자열로 변환 (화질 낮춰서 용량 줄임)
            screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50, fullPage: false });
            screenshot = `data:image/jpeg;base64,${screenshot}`;
        }

        console.log(`[Scrape] Final Name: ${result.name}`);
        
        // 결과 반환 (screenshot 필드 포함)
        res.json({ bib, ...result, screenshot });

    } catch (error) {
        console.error('[Scrape] Error:', error);
        res.status(500).json({ error: 'Failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;