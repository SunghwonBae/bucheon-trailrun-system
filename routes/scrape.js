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
        // Render Docker 환경 크롬 경로
        executablePath: '/usr/bin/google-chrome', 
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080', // 화면 크기를 키워서 모바일 뷰 방지
            '--disable-features=site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        
        // -------------------------------------------------------------
        // [핵심 수정 1] 봇 탐지 우회: 일반 사용자(Windows Chrome)인 척 위장
        // -------------------------------------------------------------
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

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

        console.log(`[Scrape] Navigating to: ${targetUrl}`);

        // -------------------------------------------------------------
        // [핵심 수정 2] 로딩 대기 전략 강화
        // -------------------------------------------------------------
        // 'networkidle2': 네트워크 활동이 거의 멈출 때까지 대기 (데이터 로딩 완료 대기)
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 40000 });

        // 확실하게 'Race Splits' 텍스트나 선수 이름이 뜰 때까지 기다림
        try {
            // 이름이 뜨는 h1 태그 기다림
            await page.waitForSelector('h1', { timeout: 10000 });
            // 혹은 Race Splits 섹션이 뜰 때까지 잠시 대기
            await new Promise(r => setTimeout(r, 2000)); 
        } catch (e) {
            console.log('[Scrape] Warning: Selector timeout, continuing anyway...');
        }

        // [디버깅] 현재 페이지 제목과 내용을 살짝 찍어봄 (Render 로그에서 확인용)
        const pageTitle = await page.title();
        console.log(`[Scrape] Page Title: ${pageTitle}`);

        // 데이터 추출
        const data = await page.evaluate(() => {
            let result = { 
                name: 'Unknown', 
                swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
            };
            
            // 1. 이름 추출 (h1 태그 확인)
            const nameEl = document.querySelector('h1');
            if (nameEl) {
                result.name = nameEl.innerText.trim();
            } else {
                // h1이 없으면 다른 구조일 수 있으니 page text 전체에서 디버깅 필요할 수 있음
                return { ...result, name: 'Name Not Found' };
            }
            
            // 2. Race Splits 테이블 찾기 (h3 태그 기준)
            const headings = Array.from(document.querySelectorAll('h3'));
            const splitHeader = headings.find(h => h.innerText.includes('Race Splits'));
            
            if (splitHeader) {
                // h3 태그의 부모나 형제 요소에서 rows 찾기 (구조 탐색)
                // 보통 Race Splits 헤더 아래에 .row.mx-0 들이 위치함
                
                // 전체 문서에서 row들을 찾되, 내용으로 필터링
                const rows = Array.from(document.querySelectorAll('.row.mx-0'));
                
                let transitionCount = 0;
                rows.forEach(row => {
                    const text = row.innerText;
                    const cols = row.querySelectorAll('.col');
                    if (cols.length === 0) return;
                    
                    // 시간 값은 보통 마지막 컬럼
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

        console.log(`[Scrape] Found: ${JSON.stringify(data)}`);
        res.json({ bib, ...data });

    } catch (error) {
        console.error('[Scrape] Critical Error:', error);
        res.status(500).json({ error: 'Scraping failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;