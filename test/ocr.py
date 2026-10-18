import asyncio
from playwright.async_api import async_playwright
async def m():
  async with async_playwright() as p:
    b=await p.webkit.launch(); pg=await b.new_page(viewport={'width':1366,'height':1024})
    pg.on('pageerror',lambda e:print('E',e))
    await pg.goto('https://anthonyjonesdavid-cmyk.github.io/sf-9c2af1d5f5f9/'); await pg.wait_for_selector('.empty')
    await pg.set_input_files('#fileIn',['samples/s02.png','samples/s09.jpg']); await pg.wait_for_function('__sf.S.shots.length==2')
    await pg.click('#settingsBtn'); await pg.click('[data-act=scan]')
    await pg.wait_for_selector('#scanTxt:has-text("Done"), #scanTxt:has-text("stopped")',timeout=180000)
    print(await pg.text_content('#scanTxt')); print(await pg.evaluate('__sf.S.shots.map(s=>s.ocr.slice(0,80))'))
    await pg.click('#sheetBox [data-act=close]'); await pg.fill('#search','1Z999AA'); await pg.wait_for_timeout(400); print('hits',await pg.locator('#feed .card').count())
asyncio.run(m())
