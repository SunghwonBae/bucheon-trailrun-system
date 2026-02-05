const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

router.get('/', async (req, res) => {
    const { bib, urlTemplate } = req.query;

    if (!bib || !urlTemplate) {
        return res.status(400).json({ error: 'Bib and urlTemplate required' });
    }

    console.log(`[Debug] Start Scraping Bib: ${bib}`);

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
        
        // 유저 에이전트 설정
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const targetUrl = urlTemplate.replace('{bib}', bib);
        console.log(`[Debug] Navigating to: ${targetUrl}`);

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        // 페이지 타이틀 확인
        const pageTitle = await page.title();
        console.log(`[Debug] Page Title: ${pageTitle}`);

        // ============================================================
        // [🔍 초강력 구조 진단 로직]
        // 페이지의 핵심 구조를 분석해서 로그에 찍습니다.
        // ============================================================
        const debugInfo = await page.evaluate(() => {
            const info = {};

            // 1. 모든 헤더 태그 (h1 ~ h3) 텍스트 수집
            info.h1_texts = Array.from(document.querySelectorAll('h1')).map(el => ({ text: el.innerText, class: el.className }));
            info.h2_texts = Array.from(document.querySelectorAll('h2')).map(el => ({ text: el.innerText, class: el.className }));
            info.h3_texts = Array.from(document.querySelectorAll('h3')).map(el => ({ text: el.innerText, class: el.className }));

            // 2. 'Swim'이라는 단어가 포함된 모든 요소 찾기 (데이터가 어디 숨었나 추적)
            // 너무 많을 수 있으니 상위 5개만
            const swimElements = [];
            const allDivs = document.querySelectorAll('div, span, p, td');
            for (let el of allDivs) {
                if (el.innerText && el.innerText.includes('Swim') && el.children.length === 0) {
                    swimElements.push({
                        tag: el.tagName,
                        class: el.className,
                        parentClass: el.parentElement ? el.parentElement.className : 'none',
                        text: el.innerText
                    });
                    if (swimElements.length >= 5) break;
                }
            }
            info.swim_locations = swimElements;

            // 3. 기록 테이블로 추정되는 클래스들 확인
            // Athlinks는 보통 'row', 'col', 'MuiGrid' 같은 클래스를 씀
            info.has_row_class = document.querySelectorAll('.row').length;
            info.has_MuiGrid = document.querySelectorAll('[class*="MuiGrid"]').length; // Material UI 사용 여부 확인

            return info;
        });

        console.log('[Debug] Analysis Result:', JSON.stringify(debugInfo, null, 2));


        // ============================================================
        // [임시 데이터 추출 시도] 
        // 기존 로직을 유지하되, 약간 더 유연하게 찾아봅니다.
        // ============================================================
        const data = await page.evaluate(() => {
            let result = { 
                name: 'Unknown', 
                swim: '-', t1: '-', bike: '-', t2: '-', run: '-', total: 'DNS/DNF' 
            };
            
            // 이름: h1이 대회명이면, h2나 h3, 혹은 타이틀에서 가져오기
            // "O Jin Kim's Race Results" -> "O Jin Kim" 추출 시도
            const title = document.title;
            if (title.includes("'s Race Results")) {
                result.name = title.split("'s Race Results")[0];
            } else {
                // h1 텍스트
                const h1 = document.querySelector('h1');
                if (h1) result.name_from_h1 = h1.innerText;
            }

            // 텍스트 기반으로 시간 찾기 (가장 무식하지만 확실한 방법)
            // 페이지 전체 텍스트를 가져와서 정규식이나 위치로 찾기 시도
            const bodyText = document.body.innerText;
            
            // 단순 줄바꿈 기준 파싱 시도 (로그 확인용)
            result.debug_body_start = bodyText.substring(0, 500).replace(/\n/g, ' | ');

            return result;
        });

        console.log(`[Debug] Temporary Data: ${JSON.stringify(data)}`);
        res.json({ bib, debugInfo, data });

    } catch (error) {
        console.error('[Debug] Error:', error);
        res.status(500).json({ error: 'Debug failed', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;