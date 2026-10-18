import asyncio, glob, os, sys, json
from playwright.async_api import async_playwright
BASE='http://localhost:8931/'
OCR={f's{i:02d}':t for i,t in enumerate(["Boarding pass DL 1482 MSP AUS","Chili recipe beef beans cumin","UPS tracking 1Z999AA10123456784","Home Depot receipt total 84.17","Be the change quote","Chicago weather rain","Comic Shelf spinner","Zilker Park directions","Dinner at Joe's","Guest wifi sunflower42","Twins Royals final","Call dentist Tuesday"])}
INIT="window.__noShare=1;window.__OCR=%s;window.__mockOCR=async(b,s)=>{await new Promise(r=>setTimeout(r,30));return window.__OCR[(s.name||'').split('.')[0]]||'';};window.confirm=()=>true;"%json.dumps(OCR)
SIZES=[('ipad-land',1366,1024),('ipad-port',1024,1366),('iphone390',390,844),('iphone430',430,932)]
files=sorted(glob.glob('samples/s*'))
errs=[]
async def main():
  async with async_playwright() as p:
    b=await p.webkit.launch()
    for name,w,h in SIZES:
      ctx=await b.new_context(viewport={'width':w,'height':h},device_scale_factor=2,is_mobile=w<500,has_touch=True,accept_downloads=True)
      await ctx.add_init_script(INIT)
      pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(f'{name}: {e}'))
      pg.on('console',lambda m: m.type=='error' and errs.append(f'{name} console: {m.text}'))
      await pg.goto(BASE); await pg.wait_for_selector('.empty')
      await pg.screenshot(path=f'shots/{name}-0empty.png')
      await pg.set_input_files('#fileIn',files); await pg.wait_for_function('__sf.S.shots.length==12'); await pg.click('.tile[data-filter=""]')
      await pg.set_input_files('#fileIn',['samples/dup.png','samples/s00.jpg']); await pg.wait_for_timeout(600)
      n=await pg.evaluate('__sf.S.shots.length'); assert n==12,('dup',n)
      src=await pg.evaluate('__sf.S.shots.map(s=>s.dateSrc).join(",")'); print(name,'dateSrc',src)
      await pg.wait_for_timeout(500)
      # topbar checks
      tb=await pg.evaluate("(()=>{const r=document.querySelector('#top').getBoundingClientRect();const bg=getComputedStyle(document.querySelector('#top')).backgroundColor;const small=[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&!x.closest('.chiprow')).map(x=>[x.id||x.textContent.trim(),x.getBoundingClientRect().height,x.getBoundingClientRect().width]).filter(a=>a[1]<40||a[2]<40);return {top:r.top,h:r.height,bg,small,sw:document.documentElement.scrollWidth}})()")
      print(name,'topbar',tb)
      # tags: create via sheet on first card
      await pg.click('.card [data-act=tag]') if w>=500 or True else None
      await pg.fill('#newTagName','Travel'); await pg.click('[data-act=add]')
      await pg.fill('#newTagName','Receipts'); await pg.click('[data-act=add]'); await pg.click('.name:has-text("Receipts")')
      await pg.click('#sheetBox [data-act=close] >> nth=-1')
      # multi-select tag
      await pg.click('#selectBtn'); cards=pg.locator('#feed .card')
      for i in (1,2,3): await cards.nth(i).click()
      await pg.screenshot(path=f'shots/{name}-2select.png')
      await pg.click('#selTag'); await pg.click('.name:has-text("Travel")'); await pg.click('#sheetBox [data-act=close] >> nth=-1'); await pg.click('#selDone')
      cnt=await pg.evaluate("__sf.S.shots.filter(s=>s.tags.length).length"); print(name,'tagged',cnt)
      # manage: rename + recolour + pin
      if w>=1100: await pg.click('#sidebar [data-act=manage]')
      else: await pg.click('#menuBtn'); await pg.click('#sidebar [data-act=manage]')
      await pg.click('.trow:has-text("Travel") button[data-act=edit]'); await pg.fill('#rn','Trips'); await pg.click('.sw >> nth=4'); await pg.click('[data-act=save]')
      await pg.click('[data-act=pin] >> nth=0'); await pg.click('#sheetBox [data-act=close]')
      names=await pg.evaluate("__sf.S.tags.map(t=>t.name+':'+t.color+':'+t.pinned).join('|')"); print(name,'tags',names)
      await pg.evaluate("document.querySelector('#feedWrap').scrollTop=0"); await pg.wait_for_timeout(2800); await pg.screenshot(path=f'shots/{name}-1feed.png')
      # filter
      if w>=1100: await pg.click('#sidebar .srow:has-text("Trips")')
      else: await pg.click('#chips .chip:has-text("Trips")')
      fc=await pg.locator('#feed .card').count(); print(name,'filter Trips ->',fc); assert fc==4
      await pg.screenshot(path=f'shots/{name}-3filter.png')
      if w>=1100: await pg.click('#sidebar .srow:has-text("All screenshots")')
      else: await pg.click('#chips .chip:has-text("All")')
      # scan + search
      await pg.click('#settingsBtn'); await pg.click('[data-act=scan]'); await pg.wait_for_selector('#scanTxt:has-text("Done")',timeout=20000)
      await pg.screenshot(path=f'shots/{name}-4settings.png'); await pg.click('#sheetBox [data-act=close]')
      await pg.fill('#search','sunflower'); await pg.wait_for_timeout(400); a=await pg.locator('#feed .card').count()
      await pg.fill('#search','trips'); await pg.wait_for_timeout(400); bb=await pg.locator('#feed .card').count()
      await pg.evaluate("(()=>{const s=__sf.S.shots[0];s.caption='my favorite one';})()")
      await pg.fill('#search','favorite'); await pg.wait_for_timeout(400); c=await pg.locator('#feed .card').count()
      print(name,'search ocr/tag/caption',a,bb,c); assert (a,bb,c)==(1,4,1)
      await pg.screenshot(path=f'shots/{name}-5search.png'); await pg.fill('#search',''); await pg.wait_for_timeout(300)
      # grid
      await pg.click('#viewBtn'); await pg.wait_for_timeout(400); await pg.screenshot(path=f'shots/{name}-6grid.png'); await pg.click('#viewBtn')
      # viewer
      if w>=1100: await pg.locator('#feed .card').nth(0).click(); await pg.screenshot(path=f'shots/{name}-7detail.png'); await pg.click('#detail [data-act=open]')
      else: await pg.locator('#feed .card img').nth(0).click()
      await pg.wait_for_selector('#viewer:not([hidden])'); await pg.wait_for_timeout(400)
      d1=await pg.text_content('#vDate')
      await pg.evaluate("document.querySelector('#vTrack').scrollBy({left:innerWidth})"); await pg.wait_for_timeout(700)
      d2=await pg.text_content('#vDate'); print(name,'viewer',d1,'->',d2); assert '2/' in d2
      await pg.fill('#vCap','caption from viewer'); await pg.press('#vCap','Tab')
      await pg.screenshot(path=f'shots/{name}-8viewer.png'); await pg.click('#vClose')
      # backup roundtrip
      await pg.click('#settingsBtn')
      async with pg.expect_download() as dl: await pg.click('[data-act=export]')
      d=await dl.value; path=f'/tmp/sf-{name}.zip'; await d.save_as(path)
      await pg.click('[data-act=nuke]'); await pg.wait_for_function('__sf.S.shots.length==0')
      await pg.click('#settingsBtn'); await pg.set_input_files('#zipIn',path); await pg.wait_for_function('__sf.S.shots.length==12',timeout=30000)
      await pg.wait_for_timeout(500)
      r=await pg.evaluate("[__sf.S.tags.length,__sf.S.shots.filter(s=>s.tags.length).length,__sf.S.shots.filter(s=>s.ocr).length,__sf.S.shots.some(s=>s.caption=='caption from viewer'),__sf.S.shots.filter(s=>s.dateSrc=='exif').length]")
      print(name,'restore',r, os.path.getsize(path)); await pg.click('#sheetBox [data-act=close]')
      await pg.reload(); await pg.wait_for_selector('.tile'); print(name,'after reload',await pg.evaluate('__sf.S.shots.length'))
      await ctx.close()
    await b.close()
  print('ERRORS',errs)
os.makedirs('shots',exist_ok=True); asyncio.run(main())
