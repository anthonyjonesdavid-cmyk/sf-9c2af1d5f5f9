
import asyncio, glob, sys
from playwright.async_api import async_playwright
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8931/'
PFX=sys.argv[2] if len(sys.argv)>2 else ''
JS="""window.__swipe=async(sel,pts,opt={})=>{const el=document.querySelector(sel);const mk=(type,x,y,end)=>{let ev;const t=document.createTouch(window,el,1,x,y,x,y);
 try{ev=new TouchEvent(type,{bubbles:true,cancelable:type!='touchcancel',touches:end?[]:[t],targetTouches:end?[]:[t],changedTouches:[t]})}catch(e){ev=new TouchEvent(type,{bubbles:true,cancelable:true});Object.defineProperty(ev,'touches',{value:end?[]:[t]});Object.defineProperty(ev,'changedTouches',{value:[t]})}
 return ev};let prevented=0;
 if(opt.pointerCancel){el.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',pointerId:7,bubbles:true,clientX:pts[0][0],clientY:pts[0][1]}))}
 el.dispatchEvent(mk('touchstart',...pts[0]));
 for(let i=1;i<pts.length;i++){if(opt.pointerCancel&&i==2)el.dispatchEvent(new PointerEvent('pointercancel',{pointerType:'touch',pointerId:7,bubbles:true}));const ev=mk('touchmove',...pts[i]);el.dispatchEvent(ev);if(ev.defaultPrevented)prevented++;await new Promise(r=>setTimeout(r,16));}
 const L=pts[pts.length-1];el.dispatchEvent(mk(opt.cancel?'touchcancel':'touchend',L[0],L[1],true));await new Promise(r=>setTimeout(r,400));return prevented}"""
def line(x0,y0,x1,y1,n=12): return [[x0+(x1-x0)*i/n,y0+(y1-y0)*i/n] for i in range(n+1)]
errs=[]
async def main():
  async with async_playwright() as p:
    b=await p.webkit.launch()
    for name,w,h in [('iphone390',390,844),('ipad-port',1024,1366),('ipad-land',1366,1024)]:
      ctx=await b.new_context(viewport={'width':w,'height':h},device_scale_factor=2,is_mobile=True,has_touch=True)
      await ctx.add_init_script(JS+";window.confirm=()=>true;"); pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e)))
      await pg.goto(BASE); await pg.wait_for_selector('.empty')
      await pg.set_input_files('#fileIn',sorted(glob.glob('samples/s*'))); await pg.wait_for_function('__sf.S.shots.length==12')
      await pg.evaluate("(()=>{const S=__sf.S;const mk=(id,n,c)=>({id,name:n,color:c,pinned:false});S.tags.push(mk('t1','Receipts','#4fc3f7'),mk('t2','Travel','#ff5c7a'),mk('t3','Recipes','#7ee787'),mk('t4','Screenshots of things to read later','#b48cff'));S.shots.forEach((s,i)=>{s.tags=[['t1'],['t2'],['t3'],['t4']][i%4]});S.shots[2].pinned=true;__sf.render()})()")
      await pg.wait_for_timeout(1500); await pg.screenshot(path=f'shots/{PFX}v2b-{name}-home.png')
      th=await pg.evaluate("[...document.querySelectorAll('.tile')].map(t=>Math.round(t.getBoundingClientRect().height))"); fs=await pg.evaluate("getComputedStyle(document.querySelector('.tn')).fontSize")
      cols=await pg.evaluate("getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length"); print(name,'tile heights',min(th),'name font',fs,'cols',cols)
      await pg.tap('.tile:has-text("All")'); await pg.wait_for_selector('#feed .card')
      async def openv():
        await pg.locator('#feed .card img').first.tap()
        await pg.wait_for_timeout(200)
        if w>=1100 and await pg.is_hidden('#viewer'): await pg.tap('#detail [data-act=open]')
        await pg.wait_for_selector('#viewer:not([hidden])'); await pg.wait_for_timeout(300)
      def r(label,ok): print(name,label,'PASS' if ok else 'FAIL'); ok or errs.append(name+' '+label)
      await openv()
      pv=await pg.evaluate("__swipe('#vTrack',%s)"%line(w/2,h*.4,w/2-150,h*.4+8)); r('horizontal touch swipe does not close (not prevented=%d)'%pv, await pg.is_visible('#viewer') and pv==0)
      pv=await pg.evaluate("__swipe('#vTrack',%s)"%line(w/2,h*.4,w/2+4,h*.4+50)); r('short down swipe snaps back', await pg.is_visible('#viewer') and await pg.evaluate("document.querySelector('#vTrack').style.transform")=='')
      pv=await pg.evaluate("__swipe('#vTrack',%s)"%line(w/2,h*.4,w/2+10,h*.4+260)); r('down swipe closes viewer (touchmove prevented %d/12)'%pv, await pg.is_hidden('#viewer') and pv>=11)
      await openv(); await pg.evaluate("__swipe('#vTrack',%s,{pointerCancel:true})"%line(w/2,h*.4,w/2,h*.4+260)); r('down swipe closes despite pointercancel', await pg.is_hidden('#viewer'))
      await openv(); await pg.evaluate("__swipe('#vTrack',%s,{cancel:true})"%line(w/2,h*.4,w/2,h*.4+60)); r('touchcancel mid-short-swipe snaps back', await pg.is_visible('#viewer'))
      await pg.evaluate("__swipe('#vEdge',%s)"%line(4,h/2,260,h/2+5)); r('viewer left-edge swipe closes', await pg.is_hidden('#viewer'))
      for how in ('down','edge'):
        await pg.tap('#settingsBtn'); await pg.wait_for_selector('#sheet:not([hidden])')
        bb=await pg.locator('#sheetBox').bounding_box()
        if how=='down': await pg.evaluate("__swipe('#sheetBox',%s)"%line(bb['x']+bb['width']/2,bb['y']+120,bb['x']+bb['width']/2,bb['y']+380))
        else: await pg.evaluate("__swipe('#sheetEdge',%s)"%line(4,h/2,300,h/2))
        r('sheet '+how+' swipe closes', await pg.is_hidden('#sheet'))
      await pg.tap('#settingsBtn'); await pg.tap('#sheet',position={'x':w-6,'y':h-6}); r('sheet backdrop tap closes', await pg.is_hidden('#sheet'))
      # scrolled sheet: down swipe must scroll, not close
      await pg.tap('#settingsBtn'); await pg.evaluate("(()=>{const b=document.querySelector('#sheetBox');b.style.maxHeight='300px';b.scrollTop=40})()")
      await pg.evaluate("__swipe('#sheetBox',%s)"%line(w/2,h/2-100,w/2,h/2+150)); r('scrolled sheet ignores down swipe', await pg.is_visible('#sheet'))
      await pg.tap('#sheet',position={'x':w-6,'y':h-6})
      await pg.evaluate("__swipe('#edge',%s)"%line(4,h/2,260,h/2+5)); await pg.wait_for_timeout(300); r('feed left-edge swipe back to Tags', await pg.locator('.tile').count()>0)
      await ctx.close()
    await b.close()
  print('ERRORS',errs)
asyncio.run(main())
