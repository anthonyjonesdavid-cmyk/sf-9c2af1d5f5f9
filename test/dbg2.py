import asyncio,glob
from playwright.async_api import async_playwright
async def m():
  async with async_playwright() as p:
    b=await p.webkit.launch(); pg=await b.new_page()
    pg.on('console',lambda x:print('C',x.type,x.text)); pg.on('pageerror',lambda e:print('E',e))
    await pg.goto('http://localhost:8931/'); await pg.wait_for_timeout(1000)
    await pg.set_input_files('#fileIn',[]) 
    r=await pg.evaluate('''async()=>{const out=[];const r=await fetch('test/samples/s00.jpg');const bl=await r.blob();
    try{const im=await createImageBitmap(bl);out.push('bmp '+im.width)}catch(e){out.push('bmpErr '+e)}
    const c=document.createElement('canvas');c.width=10;c.height=10;
    const t=await Promise.race([new Promise(r=>c.toBlob(r,'image/jpeg',0.8)),new Promise(r=>setTimeout(()=>r('timeout'),2000))]);out.push('toBlob '+(t&&t.size||t));
    try{const d=await db();await tx(['shots','blobs'],'readwrite',(a,b)=>{b.put({id:'x',full:bl,thumb:bl})});out.push('tx ok')}catch(e){out.push('txErr '+e)}
    return out}''')
    print(r)
asyncio.run(m())
