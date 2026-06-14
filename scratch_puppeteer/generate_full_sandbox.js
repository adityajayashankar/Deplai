const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Set viewport to a large height to render more
  await page.setViewport({ width: 1920, height: 1080 });
  
  await page.goto('https://pvl.ifcaindia.com/', {waitUntil: 'networkidle0', timeout: 60000});
  
  // Auto-scroll to the bottom to trigger lazy loading and animations
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0;
      let distance = 100;
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50); // scroll every 50ms
    });
  });
  
  // Wait a bit more for animations to settle
  await new Promise(r => setTimeout(r, 2000));
  
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  fs.writeFileSync('c:/Users/adity/Deplai_AJ/Connector/tmp/repos/adityajayashankar/ifca-/sandbox-index-raw.html', html);
  
  await browser.close();
  console.log('Saved rendered HTML after scrolling');
})();
