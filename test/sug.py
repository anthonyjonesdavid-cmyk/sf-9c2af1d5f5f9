import asyncio, glob, json, sys
from playwright.async_api import async_playwright
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8931/'
PFX=sys.argv[2] if len(sys.argv)>2 else ''
OCR={'s00':"Boarding pass\nDL 1482 MSP to AUS\nGate C12  Seat 14A\nConfirmation HX93KD",'s01':"Chili recipe\n2 cups beans\n1 tbsp cumin\nPreheat oven to 350",
's02':"UPS tracking 1Z999AA10123456784\nOut for delivery",'s03':"Home Depot\nSubtotal $78.00\nTax $6.17\nTotal $84.17\nOrder # 5521",
's04':"@levelsio\nBe the change you wish to see\n1.2K likes  340 reposts",'s05':"Chicago weather rain later",'s06':"Comic Shelf spinner rack",
's07':"Directions to Zilker Park\n4.2 mi  12 min drive\n2100 Barton Springs Rd",'s08':"Dinner at 7 at Joe's?\nsee you there\nRead 6:41 PM\nlol ok",
's09':"Your verification code is 482913\nGuest wifi password sunflower42",'s10':"Chase checking\nAvailable balance $2,340.11\nPayment due Nov 3",'s11':"Comic night with Sam"}
INIT="window.__noShare=1;window.__OCR=%s;window.__mockOCR=async(b,s)=>window.__OCR[(s.name||'').split('.')[0]]||'';window.confirm=()=>true;"%json.dumps(OCR)
SIZES=[('ipad-land',1366,1024),('ipad-port',1024,1366),('iphone390',390,844),('iphone430',430,932)]
errs=[]
async def main():
  async with async_playwright() as p:
    b=await p.webkit.launch()
    for name,w,h in SIZES:
      ctx=await b.new_context(viewport={'width':w,'height':h},device_scale_factor=2,is_mobile=w<500,has_touch=True)
      await ctx.add_init_script(INIT); pg=await ctx.new_page()
      pg.on('pageerror',lambda e:errs.append(f'{name}: {e}'))
      await pg.goto(BASE); await pg.wait_for_selector('.empty')
      await pg.set_input_files('#fileIn',sorted(glob.glob('samples/s*'))); await pg.wait_for_function('__sf.S.shots.length==12')
      # own tag that should match text
      await pg.evaluate("(async()=>{})()")
      assert await pg.locator('.chip.sug').count()==0  # nothing before scan
      await pg.click('#settingsBtn'); await pg.click('[data-act=scan]'); await pg.wait_for_selector('#scanTxt:has-text("Done")')
      print(name,await pg.text_content('#scanTxt')); await pg.click('#sheetBox [data-act=close]')
      sug=await pg.evaluate("Object.fromEntries([...__sf.S.sugg].map(([k,v])=>[__sf.S.shots.find(s=>s.id==k).name,v]))"); print(name,sug)
      assert await pg.evaluate("__sf.S.tags.length")==0 and await pg.evaluate("__sf.S.shots.every(s=>!s.tags.length)")
      await pg.evaluate("document.querySelector('#feedWrap').scrollTop=0"); await pg.wait_for_timeout(2500)
      await pg.screenshot(path=f'shots/{PFX}v2-{name}-cards.png')
      await pg.evaluate("(()=>{const c=document.querySelector('#feed .card:has(.chip.sug) .meta');const f=document.querySelector('#feedWrap');f.scrollTop+=c.getBoundingClientRect().bottom-f.getBoundingClientRect().bottom+120})()"); await pg.wait_for_timeout(1500); await pg.screenshot(path=f'shots/{PFX}v2-{name}-cards-chips.png'); await pg.evaluate("document.querySelector('#feedWrap').scrollTop=0")
      # accept first card's suggestion, dismiss another
      first=pg.locator('#feed .card').first; n1=await first.locator('.chip.sug').first.get_attribute('data-sug')
      await first.locator('.chip.sug').first.click(position={'x':12,'y':12}); await pg.wait_for_timeout(300)
      t=await pg.evaluate("__sf.S.tags.map(t=>t.name)"); print(name,'accepted',n1,'tags',t); assert n1 in t
      c2=pg.locator('#feed .card:has(.chip.sug)').first; sid=await c2.get_attribute('data-id'); n2=await c2.locator('.chip.sug').first.get_attribute('data-sug')
      await c2.locator('.chip.sug .sx').first.click(); await pg.wait_for_timeout(300)
      assert n2 not in await pg.evaluate(f"__sf.S.sugg.get('{sid}')||[]")
      # own tag matching: create 'Comic' tag -> s06, s11 suggested
      await pg.evaluate("(async()=>{})()")
      # review
      if w>=1100: await pg.click('#sidebar [data-act=review]')
      else: await pg.click('#chips [data-act=review]')
      await pg.wait_for_timeout(1200); await pg.screenshot(path=f'shots/{PFX}v2-{name}-review.png')
      grp=await pg.locator('.rg').count(); before=await pg.evaluate("__sf.S.tags.length")
      await pg.locator('[data-ra=acceptall]').first.click(); await pg.wait_for_timeout(300)
      await pg.locator('[data-ra=no]').first.click(); await pg.wait_for_timeout(300)
      after=await pg.evaluate("__sf.S.tags.length"); print(name,'groups',grp,'tags',before,'->',after)
      await pg.click('#sheetBox [data-act=close]')
      # own-tag match
      await pg.evaluate("(async()=>{const t={id:'own1',name:'Comic',color:'#ff5c7a',pinned:false};__sf.S.tags.push(t);__sf.render();})()")
      own=await pg.evaluate("[...__sf.S.sugg].filter(([k,v])=>v.includes('Comic')).length"); print(name,'own-tag Comic suggested on',own); assert own==2
      # viewer
      await pg.evaluate("__sf.S.tags=__sf.S.tags.filter(t=>t.id!='own1');__sf.render()")
      if w>=1100: c=pg.locator('#feed .card:has(.chip.sug)').first; await c.locator('img').click(); await pg.screenshot(path=f'shots/{PFX}v2-{name}-detail.png'); await pg.click('#detail [data-act=open]')
      else: await pg.locator('#feed .card:has(.chip.sug) img').first.click()
      await pg.wait_for_timeout(500); vs=await pg.locator('#vChips .chip.sug').count(); print(name,'viewer sug chips',vs); assert vs>=1
      await pg.screenshot(path=f'shots/{PFX}v2-{name}-viewer.png'); await pg.click('#vClose')
      # persistence of dismissals + recompute on open
      await pg.reload(); await pg.wait_for_selector('#feed .card'); await pg.wait_for_timeout(300)
      ok=await pg.evaluate(f"!(__sf.S.sugg.get('{sid}')||[]).includes('{n2}') && __sf.S.sugg.size>0"); print(name,'after reload dismissal kept & recomputed',ok); assert ok
      tb=await pg.evaluate("[...document.querySelectorAll('button,.chip.sug')].filter(x=>x.offsetParent).map(x=>[x.className,x.getBoundingClientRect().height]).filter(a=>a[1]<40 && !/tagb/.test(a[0]))"); print(name,'small targets',tb[:5])
      await ctx.close()
    await b.close()
  print('ERRORS',errs)
asyncio.run(main())
