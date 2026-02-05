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
            '--window-size=1920,1080', // 일반 PC 해상도로 시작
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
        // 🔨 [장애물 파괴] Continue / Accept / Close 버튼 강제 클릭
        // ============================================================
        console.log('[Scrape] Hunting for buttons...');
        
        // 1. "Continue", "Accept", "View", "Close" 텍스트를 가진 버튼 찾기
        const buttonTexts = ["continue", "accept", "agree", "view result", "close", "okay", "got it", "i understand"];
        
        for (const btnText of buttonTexts) {
            try {
                // XPath로 텍스트가 포함된 버튼이나 a 태그, div(버튼 역할) 찾기
                const buttons = await page.$x(`//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${btnText}')]`);
                
                for (const button of buttons) {
                    // 화면에 보이는지 확인 후 클릭
                    const isVisible = await button.boundingBox();
                    if (isVisible) {
                        console.log(`[Scrape] 🖱️ Clicking button: "${btnText}"`);
                        await button.click();
                        await new Promise(r => setTimeout(r, 1000)); // 클릭 후 잠시 대기
                    }
                }
            } catch (e) { console.log(`Error clicking ${btnText}: ${e.message}`); }
        }

        // 2. 화면 가리는 레이어(Overlay/Modal) 강제 삭제 (CSS로 날려버리기)
        await page.evaluate(() => {
            // z-index가 높은(화면을 덮는) div들을 찾아서 투명하게 만들거나 삭제
            const divs = document.querySelectorAll('div, section, aside');
            divs.forEach(div => {
                const style = window.getComputedStyle(div);
                // 화면을 꽉 채우고(fixed/absolute) 투명도가 있는 배경(modal backdrop)이면 삭제
                if ((style.position === 'fixed' || style.position === 'absolute') && style.zIndex > 100) {
                    // 내용물(텍스트)이 없는 껍데기 레이어만 삭제 (안전장치)
                    if(div.innerText.trim().length < 50) {
                        div.remove(); 
                    }
                }
            });
        });
        
        console.log('[Scrape] Overlays removed. Scrolling...');

        // 3. 스크롤 내려서 데이터 로딩 유발
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
                const text = document.body.innerText; // 이제 가리는 게 없어서 잘 읽힐 겁니다
                const lines = text.split('\n');
                let res = {};
                
                // 이름: "Name: O Jin Kim" 또는 "O Jin Kim" 형식 찾기
                if (document.title.includes("'s")) res.name = document.title.split("'s")[0];

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

        // 그래도 실패하면 스크린샷 (이번엔 버튼이 눌렸는지 확인용)
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