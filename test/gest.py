import asyncio, glob, json, sys
from playwright.async_api import async_playwright
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8931/'
PFX=sys.argv[2] if len(sys.argv)>2 else ''
INIT="window.__mockOCR=async(b,s)=>'';window.confirm=()=>true;"
SIZES=[('ipad-land',1366,1024),('ipad-port',1024,1366),('iphone390',390,844),('iphone430',430,932)]
errs=[]
async def drag(pg,x0,y0,x1,y1,steps=12):
  await pg.mouse.move(x0,y0); await pg.mouse.down()
  for i in range(1,steps+1): await pg.mouse.move(x0+(x1-x0)*i/steps,y0+(y1-y0)*i/steps); await pg.wait_for_timeout(16)
  await pg.mouse.up(); await pg.wait_for_timeout(400)
async def main():
  async with async_playwright() as p:
    b=await p.webkit.launch()
    for name,w,h in SIZES:
      ctx=await b.new_context(viewport={'width':w,'height':h},device_scale_factor=2,is_mobile=w<500,has_touch=True)
      await ctx.add_init_script(INIT); pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(f'{name}: {e}'))
      await pg.goto(BASE); await pg.wait_for_selector('.empty')
      await pg.set_input_files('#fileIn',sorted(glob.glob('samples/s*'))); await pg.wait_for_function('__sf.S.shots.length==12')
      await pg.evaluate("(async()=>{const S=__sf.S;const mk=(id,n,c)=>({id,name:n,color:c,pinned:false});S.tags.push(mk('t1','Receipts','#4fc3f7'),mk('t2','Travel','#ff5c7a'),mk('t3','Recipes','#7ee787'));S.shots.forEach((s,i)=>{s.tags=[['t1'],['t2'],['t3'],[]][i%4]});S.shots[2].pinned=true;__sf.render()})()")
      await pg.wait_for_selector('.tile'); await pg.wait_for_timeout(1500)
      tiles=await pg.locator('.tile').count(); print(name,'home tiles',tiles)
      await pg.screenshot(path=f'shots/{PFX}v2-{name}-home.png')
      # tile -> feed -> back button
      await pg.click('.tile:has-text("Travel")'); n=await pg.locator('#feed .card').count(); print(name,'travel feed',n); assert n==3
      await pg.click('#backBtn'); await pg.wait_for_selector('.tile'); print(name,'back button ok')
      # tile -> feed -> edge swipe
      await pg.click('.tile:has-text("All")'); await pg.wait_for_selector('#feed .card')
      e=await pg.locator('#edge').bounding_box(); await drag(pg,e['x']+8,e['y']+200,e['x']+260,e['y']+210)
      await pg.wait_for_selector('.tile',timeout=3000); print(name,'edge swipe back ok')
      # browser/history back
      await pg.click('.tile:has-text("Recipes")'); await pg.go_back(); await pg.wait_for_selector('.tile',timeout=3000); print(name,'history back ok')
      # viewer gestures
      await pg.click('.tile:has-text("All")'); await pg.wait_for_timeout(300)
      if w>=1100: await pg.locator('#feed .card').first.click(); await pg.click('#detail [data-act=open]')
      else: await pg.locator('#feed .card img').first.click()
      await pg.wait_for_selector('#viewer:not([hidden])'); await pg.wait_for_timeout(300)
      await pg.evaluate("document.querySelector('#vTrack').scrollBy({left:innerWidth})"); await pg.wait_for_timeout(600)
      assert '2/' in await pg.text_content('#vDate')
      # horizontal mouse drag must NOT close
      await drag(pg,w*0.7,h*0.5,w*0.3,h*0.52); assert await pg.is_visible('#viewer'), 'closed on horizontal'
      # short down drag snaps back
      await drag(pg,w/2,h*0.4,w/2,h*0.4+50); vis=await pg.is_visible('#viewer'); tf=await pg.evaluate("getComputedStyle(document.querySelector('#vTrack')).transform"); print(name,'short drag stays',vis,tf); assert vis
      # mid-drag screenshot
      await pg.mouse.move(w/2,h*0.35); await pg.mouse.down()
      for i in range(1,8): await pg.mouse.move(w/2,h*0.35+i*20); await pg.wait_for_timeout(16)
      await pg.screenshot(path=f'shots/{PFX}v2-{name}-viewer-drag.png')
      for i in range(8,14): await pg.mouse.move(w/2,h*0.35+i*20); await pg.wait_for_timeout(16)
      await pg.mouse.up(); await pg.wait_for_timeout(500); print(name,'swipe down closes',await pg.is_hidden('#viewer')); assert await pg.is_hidden('#viewer')
      # viewer edge swipe
      await pg.locator('#feed .card img').first.click()
      if w>=1100: await pg.click('#detail [data-act=open]')
      await pg.wait_for_selector('#viewer:not([hidden])')
      await drag(pg,6,h/2,280,h/2); print(name,'viewer edge swipe closes',await pg.is_hidden('#viewer')); assert await pg.is_hidden('#viewer')
      # sheet: swipe down, edge swipe, backdrop
      for how in ('down','edge','backdrop'):
        await pg.click('#settingsBtn'); await pg.wait_for_selector('#sheet:not([hidden])')
        bb=await pg.locator('#sheetBox').bounding_box()
        if how=='down': await drag(pg,bb['x']+bb['width']/2,bb['y']+30,bb['x']+bb['width']/2,bb['y']+260)
        elif how=='edge': await drag(pg,6,h/2,300,h/2)
        else: await pg.mouse.click(w-5,h-5); await pg.wait_for_timeout(300)
        hid=await pg.is_hidden('#sheet'); print(name,'sheet',how,hid); assert hid
      await ctx.close()
    await b.close()
  print('ERRORS',errs)
asyncio.run(main())
