const { chromium } = require('playwright');
const readline = require('readline');

(async () => {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 1000,
        args: [
            '--start-maximized',
            '--disable-infobars',
        ],
    });

    const page = await browser.newPage();
    await page.goto('https://example.com');

    console.log('Can you see Chromium? Press Enter to close...');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question('', resolve));
    rl.close();

    await browser.close();
})();