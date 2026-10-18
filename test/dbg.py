import asyncio,glob
from playwright.async_api import async_playwright
async def m():
  async with async_playwright() as p:
    b=await p.webkit.launch(); pg=await b.new_page()
    pg.on('console',lambda x:print('C',x.type,x.text)); pg.on('pageerror',lambda e:print('E',e))
    await pg.goto('http://localhost:8931/'); await pg.wait_for_timeout(1000)
    await pg.set_input_files('#fileIn',sorted(glob.glob('samples/s*'))); await pg.wait_for_timeout(4000)
    print(await pg.evaluate('[__sf.S.shots.length, document.querySelector("#status").textContent, document.querySelector("#toast").textContent]'))
asyncio.run(m())
