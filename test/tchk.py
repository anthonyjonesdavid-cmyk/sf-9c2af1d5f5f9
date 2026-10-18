import asyncio
from playwright.async_api import async_playwright
async def m():
  async with async_playwright() as p:
    b=await p.webkit.launch(); c=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True); pg=await c.new_page()
    await pg.goto('http://localhost:8931/')
    print(await pg.evaluate("""()=>{try{const r=[typeof document.createTouch];const e0=new TouchEvent("touchmove",{bubbles:true,cancelable:true});Object.defineProperty(e0,"touches",{value:[{clientX:3,clientY:4,identifier:1}]});r.push(e0.touches[0].clientX,e0.cancelable);return r.join(",");const t=new Touch({identifier:1,target:document.body,clientX:5,clientY:5});const e=new TouchEvent('touchstart',{touches:[t],targetTouches:[t],changedTouches:[t],bubbles:true,cancelable:true});return 'ok '+typeof TouchEvent+' '+e.touches.length+' '+('ontouchstart' in window)+' '+matchMedia('(pointer:coarse)').matches}catch(e){return 'err '+e}}"""))
asyncio.run(m())
