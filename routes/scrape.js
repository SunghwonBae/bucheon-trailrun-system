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
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // [API 낚시] 데이터 패킷 가로채기
        let interceptedData = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('api') || url.includes('IndividualEntry')) {
                try {
                    const contentType = response.headers()['content-type'];
                    if (contentType && contentType.includes('application/json')) {
                        const json = await response.json();
                        const str = JSON.stringify(json);
                        if (str.includes('Swim') || str.includes('Run') || str.includes('Intervals')) {
                            console.log(`[Network] 🎣 Data found in API!`);
                            interceptedData = json;
                        }
                    }
                } catch (e) {}
            }
        });

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        } catch(e) { console.log("Timeout, continuing..."); }

        // ============================================================
        // 🔨 [수정됨] 장애물 파괴 (page.$x 대신 page.$$ 사용)
        // ============================================================
        console.log('[Scrape] Hunting for buttons...');
        
        const buttonTexts = ["continue", "accept", "agree", "view result", "close", "okay", "got it", "i understand"];
        
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

        // 레이어 강제 삭제
        await page.evaluate(() => {
            const divs = document.querySelectorAll('div, section, aside');
            divs.forEach(div => {
                const style = window.getComputedStyle(div);
                if ((style.position === 'fixed' || style.position === 'absolute') && style.zIndex > 100) {
                    if(div.innerText.trim().length < 50) div.remove(); 
                }
            });
        });
        
        console.log('[Scrape] Overlays removed. Scrolling...');

        // 스크롤
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight || totalHeight > 5000){
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        
        await new Promise(r => setTimeout(r, 2000));

        // ============================================================
        // 📊 데이터 추출
        // ============================================================
        let result = { 
            name: 'Unknown', 
            swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
        };

        if (interceptedData) {
            console.log('[Scrape] Using Network Data');
            const intervals = interceptedData.intervals || (interceptedData.courses ? interceptedData.courses[0].intervals : []);
            
            if (interceptedData.displayName) result.name = interceptedData.displayName;
            else if (interceptedData.entry) result.name = interceptedData.entry.displayName;

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

        } else {
            console.log('[Scrape] Fallback to HTML text parsing...');
            const htmlData = await page.evaluate(() => {
                const text = document.body.innerText;
                const lines = text.split('\n');
                let res = {};
                
                // [이름 추출 강화] 타이틀 뿐만 아니라 h1 태그도 확인
                if (document.title.includes("'s")) res.name = document.title.split("'s")[0];
                if (!res.name) {
                    const h1 = document.querySelector('h1');
                    if (h1) res.name = h1.innerText.trim();
                }

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
            if (htmlData.name) result.name = htmlData.name;
            if (htmlData.swim) result.swim = htmlData.swim;
            if (htmlData.bike) result.bike = htmlData.bike;
            if (htmlData.run) result.run = htmlData.run;
            if (htmlData.total) result.total = htmlData.total;
        }

        // 스크린샷 (디버깅용)
        let screenshot = null;
        if (result.name === 'Unknown' || result.swim === '-') {
            const rawScreenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 50 });
            screenshot = `data:image/jpeg;base64,${rawScreenshot}`;
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