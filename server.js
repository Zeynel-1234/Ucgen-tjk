'use strict';
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(require('cors')());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// URİS v3.5 SCORER — Playwright'a bağımlı DEĞİL
// ─────────────────────────────────────────────

function scoreSon6Y(son6Y) {
  if (!son6Y || son6Y === '-') return { score: 5, flags: ['YENİ_AT'] };
  const races = String(son6Y).split(/[-\s,]+/).map(r => parseInt(r)).filter(n => !isNaN(n));
  if (!races.length) return { score: 5, flags: [] };
  let score = 0; const flags = [];
  [1.5,1.2,1.0,0.7,0.5,0.4].forEach((w,i) => {
    if (i >= races.length) return;
    const p = races[i];
    if (p===1) score+=5*w; else if(p===2) score+=4*w; else if(p===3) score+=3*w;
    else if(p<=5) score+=2*w; else if(p===0) score+=w;
  });
  if (races[0]===1) { score+=2; flags.push('SON_KOŞU_1. ✓'); }
  if (races.slice(0,3).every(p=>p>0&&p<=3)) { score+=2; flags.push('TUTARLI_FORM ✓'); }
  if (races.length>=3&&races[0]<races[1]&&races[1]<races[2]) { score+=1.5; flags.push('FORM_YÜKSELİŞİ ↑'); }
  return { score: Math.min(25, Math.round(score)), flags };
}

function scorePiyasa(agf, hp) {
  let score=0; const flags=[];
  if (agf&&agf>0) {
    if (agf<=1.5){score+=12;flags.push(`AGF_BÜYÜK_FAV(${agf})`);} 
    else if(agf<=2.5){score+=10;flags.push(`AGF_FAV(${agf})`);} 
    else if(agf<=4)score+=8; else if(agf<=7)score+=5; else if(agf<=12)score+=3;
    else{score+=1;flags.push(`AGF_UZUN(${agf}) 👻`);}
  } else score+=4;
  if (hp&&hp>0){if(hp<=2){score+=3;flags.push(`HP_GÜÇLÜ(${hp}) ✓`);}else if(hp<=5)score+=2;else score+=1;}
  if (hp&&agf&&hp<agf*0.5){score+=2;flags.push('GİZLİ_FAV ✓');}
  return { score: Math.min(15,Math.round(score)), flags };
}

function scoreJokey(wr) {
  if (wr==null) return { score:5, flags:[] };
  const w = wr>1?wr/100:wr; const flags=[];
  let s;
  if(w>=0.20){s=12;flags.push(`JOKEY_%${Math.round(w*100)} ELİT ⭐`);}
  else if(w>=0.15){s=9;flags.push(`JOKEY_%${Math.round(w*100)} İYİ`);}
  else if(w>=0.10)s=6; else if(w>=0.05)s=4;
  else{s=2;flags.push('JOKEY_DÜŞÜK_%');}
  return { score:Math.min(12,s), flags };
}

function scoreAntrenor(wr) {
  if(wr==null)return{score:3,flags:[]};
  const w=wr>1?wr/100:wr;
  let s=wr>=0.20?8:wr>=0.15?6:wr>=0.10?4:wr>=0.05?2:1;
  return{score:s,flags:[]};
}

function scoreKilo(weight, all) {
  if(!weight)return{score:4,flags:[]};
  const flags=[]; let s=0;
  if(weight<=54){s+=3;flags.push(`HAFİF:${weight}kg ✓`);}
  else if(weight<=57)s+=2; else if(weight<=60)s+=1;
  else flags.push(`AĞIR:${weight}kg`);
  if(all.length){
    const avg=all.reduce((a,b)=>a+b,0)/all.length;
    const adv=avg-weight;
    if(adv>=3){s+=4;flags.push(`EN_HAFİF:+${adv.toFixed(1)}kg ✓`);}
    else if(adv>=1)s+=2; else if(adv<=-3)flags.push(`EN_AĞIR:-${Math.abs(adv).toFixed(1)}kg`);
  }
  return{score:Math.min(8,s),flags};
}

function scoreKGS(kgs) {
  if(kgs==null)return{score:4,flags:[]};
  const flags=[]; let s;
  if(kgs<=14){s=8;flags.push(`TAZE:${kgs}g ✓`);}
  else if(kgs<=21){s=6;flags.push(`İYİ:${kgs}g`);}
  else if(kgs<=30)s=5; else if(kgs<=45)s=3;
  else if(kgs<=60){s=2;flags.push(`UZUN_ARA:${kgs}g`);}
  else{s=1;flags.push(`ÇOK_UZUN:${kgs}g ⚠️`);}
  return{score:s,flags};
}

function scoreIdman(t) {
  if(!t)return{score:3,flags:[]};
  const flags=[]; let s=0,secs=0;
  const str=String(t);
  if(str.includes(':'))secs=parseFloat(str.split(':')[0])*60+parseFloat(str.split(':')[1]);
  else secs=parseFloat(str)||0;
  if(secs>0){
    if(secs<=67){s=8;flags.push(`İDMAN_SÜPER:${t} ✓`);}
    else if(secs<=70){s=6;flags.push(`İDMAN_İYİ:${t}`);}
    else if(secs<=74)s=4; else if(secs<=80)s=2;
    else{s=1;flags.push(`İDMAN_YAVAŞ:${t}`);}
  }else s=3;
  if(str.toLowerCase().includes('k')){s=Math.max(s,4);flags.push('KENTER:Gizleme?');}
  return{score:Math.min(8,s),flags};
}

function scoreDS(ds) {
  return ds?{score:5,flags:['DS_BAYRAĞ ✓']}:{score:0,flags:[]};
}

function scoreHorse(horse, race) {
  const ws=(race.horses||[]).map(h=>h.weight).filter(w=>w>0);
  const l1=scoreSon6Y(horse.son6Y), l2=scorePiyasa(horse.agf,horse.hp);
  const l3=scoreJokey(horse.jockeyWinRate), l4=scoreAntrenor(horse.trainerWinRate);
  const l5=scoreKilo(horse.weight,ws), l6=scoreKGS(horse.kgs);
  const l7=scoreIdman(horse.idmanTime), l8=scoreDS(horse.ds);
  const ham=l1.score+l2.score+l3.score+l4.score+l5.score+l6.score+l7.score+l8.score;
  let bonus=0;
  if(l1.score>=18&&l3.score>=9)bonus+=4;
  if(l2.score>=10&&l1.score>=15)bonus+=3;
  if(l7.score>=6&&l6.score>=7)bonus+=3;
  if(l8.score>0&&l3.score>=7)bonus+=3;
  if(l5.score>=6&&l2.score>=8)bonus+=3;
  bonus=Math.min(16,bonus);
  const total=Math.min(116,ham+bonus);
  let tier=total>=80?'SOVEREIGN':total>=70?'BREAKER':total>=60?'GHOST':'IZLE';
  const flags=[...l1.flags,...l2.flags,...l3.flags,...l4.flags,...l5.flags,...l6.flags,...l7.flags,...l8.flags];
  return{horse,score:ham,bonus,total,probability:0,tier,
    breakdown:{son6Y:l1.score,piyasa:l2.score,jokey:l3.score,antrenor:l4.score,kilo:l5.score,kgs:l6.score,idman:l7.score,ds:l8.score},
    flags};
}

function analyzeRace(race) {
  let scores=race.horses.map(h=>scoreHorse(h,race));
  const tot=scores.reduce((s,r)=>s+Math.max(1,r.total),0);
  scores=scores.map(r=>({...r,probability:Math.round((Math.max(1,r.total)/tot)*100)}));
  const sorted=[...scores].sort((a,b)=>b.total-a.total);
  const sovereign=sorted[0];
  const breaker=sorted[1]||sorted[0];
  let ghost=sorted.find((s,i)=>i>=2&&(!s.horse.agf||s.horse.agf>6)&&s.total>=55);
  if(!ghost)ghost=sorted[Math.min(2,sorted.length-1)];
  sovereign.tier='SOVEREIGN';
  if(breaker!==sovereign)breaker.tier='BREAKER';
  if(ghost!==sovereign&&ghost!==breaker){ghost.tier='GHOST';ghost.flags.push('👻 GHOST: Piyasanın görmediği');}
  return{raceId:race.id||`r${Date.now()}`,raceNo:race.no,track:race.track,sovereign,breaker,ghost,allScores:sorted,timestamp:new Date().toISOString()};
}

// ─────────────────────────────────────────────
// PLAYWRIGHT — LAZY LOAD (sadece scrape sırasında)
// ─────────────────────────────────────────────

const sleep  = ms => new Promise(r=>setTimeout(r,ms));
const rand   = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const human  = ()=>sleep(rand(600,1800));
const medium = ()=>sleep(rand(2000,4000));

async function launchBrowser() {
  // LAZY: sadece bu fonksiyon çağrıldığında yükle
  let chromium;
  try {
    const extra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    chromium = extra.chromium;
    chromium.use(stealth());
    console.log('[Browser] playwright-extra + stealth yüklendi');
  } catch(e) {
    console.log('[Browser] playwright-extra yok, standart playwright kullanılıyor');
    chromium = require('playwright').chromium;
  }

  const args=[
    '--no-sandbox','--disable-setuid-sandbox',
    '--disable-dev-shm-usage','--disable-blink-features=AutomationControlled',
    '--window-size=390,844','--disable-infobars',
  ];
  if(process.env.PROXY_URL) args.push(`--proxy-server=${process.env.PROXY_URL}`);

  const browser=await chromium.launch({headless:true,args});
  const ctx=await browser.newContext({
    viewport:{width:390,height:844},
    userAgent:'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
    locale:'tr-TR',timezoneId:'Europe/Istanbul',
    extraHTTPHeaders:{'Accept-Language':'tr-TR,tr;q=0.9','Accept':'text/html,application/xhtml+xml,*/*;q=0.8'},
  });
  await ctx.addInitScript(()=>{
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    window.chrome={runtime:{}};
    Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
  });
  return{browser,ctx};
}

async function humanClick(page,sel){
  const el=await page.waitForSelector(sel,{timeout:8000}).catch(()=>null);
  if(!el)return false;
  const box=await el.boundingBox();
  if(!box)return false;
  await page.mouse.move(box.x+box.width/2+rand(-5,5),box.y+box.height/2+rand(-3,3),{steps:rand(8,20)});
  await sleep(rand(100,300));
  await el.click();
  await human();
  return true;
}

async function humanScroll(page){
  await page.mouse.wheel(0,rand(200,600));
  await sleep(rand(300,700));
}

// TJK URL listesi — farklı giriş noktaları
const TJK_URLS = [
  'https://mobil.tjk.org/tr/at-yarisi/kosu',
  'https://mobil.tjk.org/tr/at-yarisi/program',
  'https://www.tjk.org/TR/YarisSever/Info/Page/GunlukYarisProgram',
  'https://mobil.tjk.org',
];

async function scrapeTJK() {
  console.log('\n[TJK] ═══ SCRAPING BAŞLIYOR ═══');
  const {browser,ctx}=await launchBrowser();
  const allRaces=[];

  try {
    let entryPage=null;

    // Giriş URL'sini bul
    for(const url of TJK_URLS){
      const page=await ctx.newPage();
      try{
        console.log('[TJK] Deneniyor:', url);
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
        await human();
        await humanScroll(page);

        const bodyLen=(await page.textContent('body')||'').length;
        console.log('[TJK] Sayfa boyutu:', bodyLen);

        if(bodyLen>500){
          entryPage=page;
          console.log('[TJK] ✓ Giriş başarılı:', url);
          break;
        }
        await page.close();
      }catch(e){
        console.log('[TJK] ✗ Erişilemedi:', url, e.message.slice(0,50));
        await page.close();
      }
    }

    if(!entryPage){
      console.log('[TJK] Hiçbir URL\'ye erişilemedi');
      return allRaces;
    }

    // Sayfa içeriğini analiz et
    await humanScroll(entryPage);
    await human();

    // Tüm linkleri tara — koşu/hipodrom linkleri bul
    const links=await entryPage.evaluate(()=>{
      const found=[];
      document.querySelectorAll('a').forEach(a=>{
        const href=a.href||'';
        const txt=(a.textContent||'').trim();
        if(!href||href==='#')return;
        // Koşu sayfası kriterleri
        const isRace=href.includes('kosu')||href.includes('race')||
                     href.includes('program')||href.includes('hipodrom')||
                     href.includes('track');
        if(isRace&&txt&&txt.length<60&&txt.length>1){
          found.push({url:href,label:txt});
        }
      });
      // Deduplicate
      return [...new Map(found.map(i=>[i.url,i])).values()].slice(0,20);
    });

    console.log('[TJK] Bulunan linkler:', links.length);
    links.forEach(l=>console.log(' -',l.label,'→',l.url.slice(0,60)));

    // Her link için at verisi çek
    const racePages=links.filter(l=>
      l.url.includes('kosu')||l.url.includes('race')||
      l.label.match(/^\d+\.?\s*(Ko[şs]u|Race)?$/)
    ).slice(0,10);

    if(racePages.length===0){
      // Mevcut sayfadan at verisi çekmeyi dene
      console.log('[TJK] Direkt sayfadan at çekiliyor...');
      const raceData=await extractHorsesFromPage(entryPage,'TJK',1);
      if(raceData&&raceData.horses.length>0)allRaces.push(raceData);
    }

    for(let i=0;i<racePages.length;i++){
      const link=racePages[i];
      await medium();
      console.log(`[TJK] Koşu ${i+1}:`, link.url.slice(0,60));

      const pg=await ctx.newPage();
      try{
        await pg.goto(link.url,{waitUntil:'domcontentloaded',timeout:20000});
        await human();
        await humanScroll(pg);
        await human();

        // At verilerini çek
        const raceData=await extractHorsesFromPage(pg,'TJK',i+1);

        if(raceData&&raceData.horses.length>0){
          // Her at için detay sayfası
          for(const horse of raceData.horses){
            if(horse.detailUrl){
              await enrichHorse(ctx,horse);
              await sleep(rand(300,800));
            }
          }
          allRaces.push(raceData);
          console.log(`[TJK] ✓ Koşu ${i+1}: ${raceData.horses.length} at`);
        }
      }catch(e){
        console.log(`[TJK] ✗ Koşu ${i+1} hatası:`, e.message.slice(0,60));
      }finally{
        await pg.close();
      }
    }

    await entryPage.close();
  }catch(e){
    console.error('[TJK] Genel hata:', e.message);
  }finally{
    await browser.close();
  }

  console.log(`[TJK] ═══ TAMAMLANDI: ${allRaces.length} koşu ═══\n`);
  return allRaces;
}

// At tablosunu parse et
async function extractHorsesFromPage(page, track, raceNo) {
  const data=await page.evaluate((no)=>{
    const horses=[];

    // Track adı
    let trackName='TJK';
    const trackEl=document.querySelector('h1,h2,.title,.hipodrom-adi,[class*="track"],[class*="venue"]');
    if(trackEl) trackName=trackEl.textContent.trim().slice(0,30);

    // Koşu bilgileri
    const bodyText=document.body.textContent;
    const distMatch=bodyText.match(/(\d{3,4})\s*[Mm](?:etre)?/);
    const dist=distMatch?parseInt(distMatch[1]):0;
    const timeMatch=bodyText.match(/(\d{2}:\d{2})/);
    const raceTime=timeMatch?timeMatch[1]:'';
    const surf=bodyText.toLowerCase().includes('çim')?'çim':bodyText.toLowerCase().includes('kum')?'kum':'';

    // En iyi tabloyu bul
    const tables=document.querySelectorAll('table');
    let bestTable=null, maxRows=0;
    tables.forEach(t=>{
      const n=t.querySelectorAll('tr').length;
      if(n>maxRows){maxRows=n;bestTable=t;}
    });

    // Satırları işle
    const rowSel=bestTable?'tr':'.horse-row,[class*="at-item"],[class*="horse-item"],tr';
    const container=bestTable||document;
    container.querySelectorAll(rowSel).forEach((row,idx)=>{
      const cells=row.querySelectorAll('td');
      if(cells.length<3)return;
      const allText=row.textContent.trim();
      if(!allText||allText.length<4)return;

      const h={};

      // No
      const noTxt=cells[0]?.textContent?.trim()||'';
      h.no=/^\d+$/.test(noTxt)?parseInt(noTxt):idx+1;

      // At adı
      const nameEl=row.querySelector('a,[class*="name"],[class*="ad"],strong');
      h.name=(nameEl?.textContent||cells[1]?.textContent||'').trim();
      if(!h.name||h.name.length<2||/^\d+$/.test(h.name))return;

      // Detay linki
      const atLink=row.querySelector('a[href*="at"],a[href*="horse"]');
      if(atLink)h.detailUrl=atLink.href;

      // Jokey
      h.jockeyName=(cells[3]?.textContent||'').trim().slice(0,30);
      const jLink=row.querySelector('a[href*="jokey"],a[href*="jockey"]');
      if(jLink)h.jockeyUrl=jLink.href;

      // Kilo
      const kiloM=(cells[4]?.textContent||'').match(/(\d{2,3}(?:\.\d+)?)/);
      if(kiloM)h.weight=parseFloat(kiloM[1]);

      // Son 6Y
      const s6el=row.querySelector('[class*="form"],[class*="son"],[class*="derece"],[class*="sicil"]');
      const s6raw=(s6el?.textContent||cells[5]?.textContent||'').trim();
      h.son6Y=s6raw.replace(/[^0-9\-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');

      // AGF
      const agfEl=row.querySelector('[class*="agf"]');
      if(agfEl){const m=agfEl.textContent.match(/(\d+\.?\d*)/);if(m)h.agf=parseFloat(m[1]);}
      else{
        for(let i=6;i<Math.min(cells.length,12);i++){
          const t=(cells[i]?.textContent||'').trim();
          if(t&&t.includes('.')&&parseFloat(t)>0&&parseFloat(t)<200){h.agf=parseFloat(t);break;}
        }
      }

      // HP
      const hpEl=row.querySelector('[class*="hp"]');
      if(hpEl){const m=hpEl.textContent.match(/(\d+\.?\d*)/);if(m)h.hp=parseFloat(m[1]);}

      // KGS
      const kgsEl=row.querySelector('[class*="kgs"]');
      if(kgsEl){const m=kgsEl.textContent.match(/(\d+)/);if(m)h.kgs=parseInt(m[1]);}

      // DS
      h.ds=row.innerHTML.toLowerCase().includes(' ds')||!!row.querySelector('[class*="ds"]');

      horses.push(h);
    });

    return{horses,trackName,dist,raceTime,surf};
  },raceNo);

  if(!data||!data.horses.length)return null;
  return{
    id:`race_${raceNo}_${Date.now()}`,
    no:raceNo,
    track:data.trackName||track,
    date:new Date().toISOString().split('T')[0],
    time:data.raceTime,
    distance:data.dist,
    surface:data.surf,
    horses:data.horses,
    source:'playwright',
  };
}

// At detay sayfası — idman + ek veri
async function enrichHorse(ctx, horse) {
  if(!horse.detailUrl)return;
  const page=await ctx.newPage();
  try{
    await page.goto(horse.detailUrl,{waitUntil:'domcontentloaded',timeout:12000});
    await human();

    // İdman sekmesini bul ve tıkla
    const idmanBtn=await page.$('[class*="idman"],a:has-text("İdman"),button:has-text("İdman")').catch(()=>null);
    if(idmanBtn){await idmanBtn.click();await sleep(rand(800,1500));}

    const detail=await page.evaluate(()=>{
      const r={};
      const txt=document.body.textContent;
      const tm=txt.match(/(\d{1,2}:\d{2}\.\d{2}|\d{2}\.\d{1,2})/);
      if(tm)r.idmanTime=tm[1];
      const kgsEl=document.querySelector('[class*="kgs"]');
      if(kgsEl){const m=kgsEl.textContent.match(/(\d+)/);if(m)r.kgs=parseInt(m[1]);}
      const hpEl=document.querySelector('[class*="hp"]');
      if(hpEl){const m=hpEl.textContent.match(/(\d+\.?\d*)/);if(m)r.hp=parseFloat(m[1]);}
      const yr=txt.match(/(?:Doğum|doğum|20\d{2}|19\d{2})/);
      const yrM=txt.match(/(20\d{2}|199\d)/);
      if(yrM)r.birthYear=parseInt(yrM[1]);
      return r;
    });

    if(detail.idmanTime)horse.idmanTime=detail.idmanTime;
    if(detail.kgs&&!horse.kgs)horse.kgs=detail.kgs;
    if(detail.hp&&!horse.hp)horse.hp=detail.hp;
    if(detail.birthYear)horse.age=new Date().getFullYear()-detail.birthYear;

    // Jokey istatistiği
    if(horse.jockeyUrl&&!horse.jockeyWinRate){
      await page.goto(horse.jockeyUrl,{waitUntil:'domcontentloaded',timeout:10000}).catch(()=>{});
      await human();
      const wr=await page.evaluate(()=>{
        const txt=document.body.textContent;
        const pm=txt.match(/[Kk]azanma[^%]*%(\d+\.?\d*)/);
        if(pm)return parseFloat(pm[1])/100;
        const fm=txt.match(/(\d+)\s*\/\s*(\d+)/);
        if(fm&&parseInt(fm[2])>0)return parseInt(fm[1])/parseInt(fm[2]);
        return null;
      });
      if(wr)horse.jockeyWinRate=wr;
    }

    console.log(`[At] ${horse.name}: idman=${horse.idmanTime||'-'} kgs=${horse.kgs||'-'}`);
  }catch(e){}
  finally{await page.close();}
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const state = { results:[], scraping:false, lastScrape:0, error:'' };

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// HEALTH — her zaman çalışır
app.get('/health',(_, res)=>{
  res.json({ok:true,results:state.results.length,scraping:state.scraping,error:state.error});
});

// OTO SCRAPE — arka planda başlat
app.get('/api/scrape',async(_,res)=>{
  if(state.scraping)return res.json({status:'running',message:'Devam ediyor...'});

  // 12 saatlik cache
  if(Date.now()-state.lastScrape<12*3600000&&state.results.length>0){
    return res.json({success:true,source:'cache',count:state.results.length,results:state.results});
  }

  state.scraping=true;
  state.error='';
  res.json({status:'started',message:'TJK scraping başladı. /api/results ile takip edin.'});

  scrapeTJK()
    .then(races=>{
      if(races.length>0){
        state.results=races.map(r=>analyzeRace(r));
        state.lastScrape=Date.now();
        console.log(`[OK] ${state.results.length} koşu analiz edildi`);
      }else{
        state.error='TJK\'dan veri çekilemedi';
        console.log('[WARN] Hiç koşu çekilemedi');
      }
    })
    .catch(e=>{state.error=e.message;console.error('[ERR]',e.message);})
    .finally(()=>{state.scraping=false;});
});

// BOOKMARKLET — veri al ve analiz et
app.post('/api/bookmarklet',(req,res)=>{
  try{
    const{races,track,date}=req.body;
    if(!races||!Array.isArray(races))return res.status(400).json({error:'races gerekli'});
    const results=[];
    for(const r of races){
      if(!r.horses||!r.horses.length)continue;
      const race={id:`bkm_${r.no}_${Date.now()}`,no:r.no||1,
        track:track||r.track||'TJK',
        date:date||new Date().toISOString().split('T')[0],horses:r.horses};
      const result=analyzeRace(race);
      results.push(result);
      state.results.push(result);
    }
    if(state.results.length>100)state.results=state.results.slice(-100);
    res.json({success:true,analyzed:results.length,results});
  }catch(e){res.status(500).json({error:e.message});}
});

// RESULTS
app.get('/api/results',(_,res)=>{
  res.json({results:state.results,count:state.results.length,scraping:state.scraping,error:state.error});
});

// BOOKMARKLET KURULUM SAYFASI
app.get('/bookmarklet',(req,res)=>{
  const host=process.env.RAILWAY_PUBLIC_DOMAIN
    ?`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    :`http://localhost:${PORT}`;

  const bm=`javascript:(function(){var S='${host}';var rows=document.querySelectorAll('tr');var horses=[];rows.forEach(function(row,i){var c=row.querySelectorAll('td');if(c.length<4)return;var name=(c[1]||c[0]).textContent.trim();if(!name||name.length<2||/^\\d+$/.test(name))return;var h={no:parseInt(c[0].textContent)||i+1,name:name,jockeyName:(c[3]||{}).textContent||''};var wm=((c[4]||{}).textContent||'').match(/(\\d+\\.?\\d*)/);if(wm)h.weight=parseFloat(wm[1]);var s6=row.querySelector('[class*=form],[class*=son],[class*=derece]');h.son6Y=(s6?s6.textContent:(c[5]||{}).textContent||'').trim().replace(/\\s+/g,'-').replace(/[^0-9\\-]/g,'');var ae=row.querySelector('[class*=agf]');if(ae){var am=ae.textContent.match(/(\\d+\\.?\\d*)/);if(am)h.agf=parseFloat(am[1]);}var he=row.querySelector('[class*=hp]');if(he){var hm=he.textContent.match(/(\\d+\\.?\\d*)/);if(hm)h.hp=parseFloat(hm[1]);}h.ds=row.innerHTML.toLowerCase().includes(' ds');horses.push(h);});if(!horses.length){alert('AT BULUNAMADI! Yarış programı sayfasında mısınız?');return;}var no=prompt('Kaçıncı koşu?','1');var track=(document.querySelector('h1,h2,.title,.hipodrom')||{}).textContent||'TJK';fetch(S+'/api/bookmarklet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({races:[{no:parseInt(no)||1,track:track.trim().slice(0,20),horses:horses}],track:track.trim().slice(0,20)})}).then(r=>r.json()).then(function(d){if(d.success&&d.results[0]){var r=d.results[0];alert('✅ ANALİZ\\n\\n👑 '+r.sovereign.horse.name+' '+r.sovereign.total+'p %'+r.sovereign.probability+'\\n⚔️ '+r.breaker.horse.name+' '+r.breaker.total+'p %'+r.breaker.probability+'\\n👻 '+r.ghost.horse.name+' '+r.ghost.total+'p %'+r.ghost.probability+'\\n\\n'+S);}else alert(JSON.stringify(d));}).catch(e=>alert(e.message));})();`;

  res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Bookmarklet</title>
<style>body{background:#0a0a0f;color:#eee;font-family:monospace;padding:20px;max-width:640px;margin:0 auto}h1{color:#f5a623;margin-bottom:20px}.code{background:#111;border:1px solid #f5a623;border-radius:8px;padding:16px;word-break:break-all;font-size:11px;color:#aaa;cursor:pointer;margin:12px 0}.step{background:#1a1a1a;border-left:3px solid #f5a623;padding:12px 16px;margin:8px 0;border-radius:0 6px 6px 0}.step strong{color:#f5a623}code{background:#222;padding:2px 6px;border-radius:3px;color:#f5a623}</style></head><body>
<h1>🏇 TJK Bookmarklet</h1>
<div class="step"><strong>1.</strong> Aşağıdaki koda tıkla → kopyalanır</div>
<div class="code" onclick="try{navigator.clipboard.writeText(this.dataset.bm);this.style.borderColor='#2ecc71';this.textContent='✅ Kopyalandı!';}catch(e){this.select&&this.select();}" data-bm="${bm.replace(/"/g,'&quot;')}">${bm.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
<div class="step"><strong>2.</strong> Via Browser adres çubuğuna yapıştır → Çalıştır<br>VEYA: Yeni bookmark → URL olarak kaydet</div>
<div class="step"><strong>3.</strong> <code>mobil.tjk.org</code> → Koşu programına gir</div>
<div class="step"><strong>4.</strong> Bookmarkı çalıştır → Koşu no gir → Analiz!</div>
<div class="step"><strong>Dashboard:</strong> <code>${host}</code></div>
</body></html>`);
});

// ANA DASHBOARD
app.get('/',(_,res)=>{
  res.send(`<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>TJK Analiz</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600&display=swap');
:root{--g:#f5a623;--b:#3498db;--p:#9b59b6;--gr:#2ecc71;--r:#e74c3c;--bg:#0a0a0f;--card:#111118;--brd:#222230}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:#e0e0e0;font-family:'IBM Plex Mono',monospace;min-height:100vh}
header{background:linear-gradient(135deg,#0a0a0f,#1a0800);border-bottom:1px solid var(--g);padding:14px 16px;position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--g);letter-spacing:3px}.logo span{color:#fff}
.badge{font-size:10px;padding:3px 8px;border-radius:12px;border:1px solid var(--gr);color:var(--gr)}
main{max-width:900px;margin:0 auto;padding:14px}
.btns{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.btn{flex:1;min-width:110px;background:transparent;border:1px solid var(--g);color:var(--g);font-family:'IBM Plex Mono',monospace;font-size:12px;padding:10px 8px;border-radius:4px;cursor:pointer;transition:.2s;text-align:center}
.btn:hover{background:var(--g);color:#000}.btn.sec{border-color:#444;color:#777}.btn.sec:hover{background:#444;color:#fff}
.progress{background:var(--card);border:1px solid var(--g);border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:12px;color:var(--g);display:none;line-height:1.8}
.tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:14px;padding-bottom:4px;scrollbar-width:none}
.tab{background:var(--card);border:1px solid var(--brd);color:#777;font-family:'IBM Plex Mono',monospace;font-size:11px;padding:8px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:.2s;text-align:center;line-height:1.4}
.tab.on{border-color:var(--g);color:var(--g);background:rgba(245,166,35,.08)}
.card{background:var(--card);border:1px solid var(--brd);border-radius:8px;padding:14px;margin-bottom:10px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%}
.card.s::before{background:var(--g)}.card.b::before{background:var(--b)}.card.g::before{background:var(--p)}
.cl{font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:2px}
.card.s .cl{color:var(--g)}.card.b .cl{color:var(--b)}.card.g .cl{color:var(--p)}
.ch{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.hn{font-size:18px;font-weight:600;color:#fff;margin:3px 0}
.hi{font-size:10px;color:#666;line-height:1.6}
.sb{font-family:'Bebas Neue',sans-serif;font-size:32px;text-align:right;line-height:1}
.card.s .sb{color:var(--g)}.card.b .sb{color:var(--b)}.card.g .sb{color:var(--p)}
.sp{font-size:14px;color:#888;text-align:right}
.pb{height:3px;background:var(--brd);border-radius:2px;margin:8px 0;overflow:hidden}
.pf{height:100%;border-radius:2px;transition:width .8s}
.card.s .pf{background:var(--g)}.card.b .pf{background:var(--b)}.card.g .pf{background:var(--p)}
.bd{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:8px 0}
.bdi{text-align:center;background:rgba(255,255,255,.03);border-radius:3px;padding:4px}
.bdl{font-size:8px;color:#555}.bdv{font-size:13px;font-weight:600;color:#bbb}
.fls{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.fl{font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(255,255,255,.04);color:#888;border:1px solid var(--brd)}
.fl.p{color:var(--gr);border-color:rgba(46,204,113,.2)}.fl.gh{color:var(--p);border-color:rgba(155,89,182,.2)}
.alc{background:var(--card);border:1px solid var(--brd);border-radius:8px;margin-bottom:14px;overflow:hidden}
.alh{padding:10px 14px;font-size:10px;color:#555;letter-spacing:2px;border-bottom:1px solid var(--brd)}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;color:#444;font-size:9px;letter-spacing:1px;padding:7px 6px;border-bottom:1px solid var(--brd)}
td{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.03)}
tr:hover td{background:rgba(255,255,255,.02)}
.ts{color:var(--g)}.tb{color:var(--b)}.tg{color:var(--p)}.ti{color:#555}
.empty{text-align:center;padding:40px 20px;color:#555;line-height:2.2}
.spin{width:28px;height:28px;border:2px solid var(--brd);border-top-color:var(--g);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--g);border-radius:6px;padding:10px 16px;font-size:12px;color:var(--g);z-index:999;opacity:0;transition:opacity .3s;white-space:nowrap;max-width:90vw}
.toast.on{opacity:1}
</style></head><body>
<header>
  <div class="logo">TJK<span>ANALİZ</span></div>
  <div class="badge" id="badge">● BAĞLANIYOR</div>
</header>
<main>
  <div class="btns">
    <button class="btn" id="scrapeBtn" onclick="startScrape()">🤖 OTO SCRAPE</button>
    <button class="btn" onclick="loadResults()">🔄 YENİLE</button>
    <button class="btn" onclick="location='/bookmarklet'">📋 BOOKMARKLET</button>
    <button class="btn sec" onclick="clearAll()">🗑</button>
  </div>
  <div class="progress" id="prog">
    ⏳ TJK.org'a bağlanılıyor...<br>
    🤖 İnsan gibi sayfalar geziliyor...<br>
    📋 At detayları ve idman verileri çekiliyor...<br>
    ⏱ Bu 3-5 dakika sürebilir.
  </div>
  <div id="tabs" class="tabs" style="display:none"></div>
  <div id="app">
    <div class="empty">
      TJK analiz sistemi hazır.<br><br>
      🤖 <b style="color:var(--g)">OTO SCRAPE</b> → Railway sunucusu TJK'yı gezer<br>
      📋 <b style="color:var(--g)">BOOKMARKLET</b> → Kendin TJK'yı aç, veriyi gönder
    </div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
let results=[],cur=0,poll=null;

async function startScrape(){
  document.getElementById('prog').style.display='block';
  document.getElementById('scrapeBtn').textContent='⏳ SCRAPING...';
  document.getElementById('scrapeBtn').style.background='rgba(245,166,35,.1)';
  try{
    await fetch('/api/scrape');
    if(poll)clearInterval(poll);
    poll=setInterval(async()=>{
      try{
        const h=await fetch('/health').then(r=>r.json());
        const d=await fetch('/api/results').then(r=>r.json());
        if(d.results&&d.results.length>0){
          clearInterval(poll);poll=null;
          document.getElementById('prog').style.display='none';
          document.getElementById('scrapeBtn').textContent='🤖 OTO SCRAPE';
          document.getElementById('scrapeBtn').style.background='';
          results=d.results;renderTabs();renderRace(0);
          toast('✅ '+d.count+' koşu analiz edildi!');
        }else if(!h.scraping){
          clearInterval(poll);poll=null;
          document.getElementById('prog').style.display='none';
          document.getElementById('scrapeBtn').textContent='🤖 OTO SCRAPE';
          document.getElementById('scrapeBtn').style.background='';
          const msg=h.error||'TJK\'dan veri çekilemedi';
          document.getElementById('app').innerHTML='<div class="empty">⚠️ '+msg+'<br><br>📋 BOOKMARKLET ile manuel veri gir</div>';
        }
      }catch(e){}
    },5000);
  }catch(e){
    document.getElementById('prog').style.display='none';
    document.getElementById('scrapeBtn').textContent='🤖 OTO SCRAPE';
    document.getElementById('app').innerHTML='<div class="empty">Hata: '+e.message+'</div>';
  }
}

async function loadResults(){
  try{
    const d=await fetch('/api/results').then(r=>r.json());
    if(d.results&&d.results.length){results=d.results;renderTabs();renderRace(0);toast('✅ '+d.count+' sonuç');}
    else{document.getElementById('app').innerHTML='<div class="empty">Veri yok.<br><br>🤖 OTO SCRAPE veya 📋 BOOKMARKLET kullan</div>';}
  }catch(e){document.getElementById('app').innerHTML='<div class="empty">Hata: '+e.message+'</div>';}
}

function renderTabs(){
  const el=document.getElementById('tabs');
  el.style.display='flex';
  el.innerHTML=results.map((r,i)=>\`<div class="tab \${i===cur?'on':''}" onclick="renderRace(\${i})">\${r.raceNo}.KŞ<br><small>\${(r.track||'').slice(0,6)}</small></div>\`).join('');
}

function renderRace(i){
  cur=i;
  document.querySelectorAll('.tab').forEach((t,j)=>t.classList.toggle('on',j===i));
  const r=results[i];if(!r)return;
  document.getElementById('app').innerHTML=card('s','👑 SOVEREIGN',r.sovereign)+card('b','⚔️ BREAKER',r.breaker)+card('g','👻 GHOST',r.ghost)+allTable(r);
}

function card(cls,label,s){
  if(!s)return'';
  const bd=s.breakdown||{};
  const bi=(l,v)=>\`<div class="bdi"><div class="bdl">\${l}</div><div class="bdv">\${v||0}</div></div>\`;
  const fls=(s.flags||[]).slice(0,4).map(f=>{
    const c=f.includes('👻')?'gh':f.includes('✓')||f.includes('ELİT')?'p':'';
    return\`<span class="fl \${c}">\${f.slice(0,28)}</span>\`;
  }).join('');
  return\`<div class="card \${cls}"><div class="ch"><div>
    <div class="cl">\${label}</div>
    <div class="hn">\${s.horse?.name||'?'}</div>
    <div class="hi">No:\${s.horse?.no}\${s.horse?.jockeyName?' | '+s.horse.jockeyName:''}\${s.horse?.weight?' | '+s.horse.weight+'kg':''}<br>\${s.horse?.idmanTime?'İdman:'+s.horse.idmanTime+' ':''}\${s.horse?.kgs?'KGS:'+s.horse.kgs+'g ':''}\${s.horse?.ds?'DS ✓':''}</div>
  </div><div>
    <div class="sb">\${s.total}</div>
    <div class="sp">%\${s.probability}</div>
    <div style="font-size:10px;color:#555;text-align:right">+\${s.bonus}b</div>
  </div></div>
  <div class="pb"><div class="pf" style="width:\${s.probability}%"></div></div>
  <div class="bd">\${bi('SON6Y',bd.son6Y)}\${bi('PİYASA',bd.piyasa)}\${bi('JOKEY',bd.jokey)}\${bi('KILO',bd.kilo)}\${bi('KGS',bd.kgs)}\${bi('İDMAN',bd.idman)}\${bi('DS',bd.ds)}\${bi('BONUS',s.bonus)}</div>
  <div class="fls">\${fls}</div></div>\`;
}

function allTable(r){
  const tc={SOVEREIGN:'ts',BREAKER:'tb',GHOST:'tg',IZLE:'ti'};
  const rows=(r.allScores||[]).map(s=>\`<tr>
    <td>\${s.horse?.no}</td><td>\${s.horse?.name}</td>
    <td>\${s.horse?.son6Y||'-'}</td><td>\${s.horse?.agf||'-'}</td>
    <td>\${s.horse?.kgs!=null?s.horse.kgs+'g':'-'}</td>
    <td>\${s.horse?.idmanTime||'-'}</td>
    <td class="\${tc[s.tier]||'ti'}">\${s.total}p</td>
    <td class="\${tc[s.tier]||'ti'}" style="font-size:9px">\${s.tier}</td>
  </tr>\`).join('');
  return\`<div class="alc"><div class="alh">TÜM ATLAR — \${r.raceNo}. KOŞU / \${r.track}</div>
  <table><thead><tr><th>No</th><th>At</th><th>Son6Y</th><th>AGF</th><th>KGS</th><th>İdman</th><th>Puan</th><th>Rol</th></tr></thead>
  <tbody>\${rows}</tbody></table></div>\`;
}

function clearAll(){results=[];cur=0;document.getElementById('tabs').style.display='none';document.getElementById('app').innerHTML='<div class="empty">Temizlendi.</div>';}
function toast(m){const el=document.getElementById('toast');el.textContent=m;el.classList.add('on');setTimeout(()=>el.classList.remove('on'),3500);}

// Bağlantı kontrolü
fetch('/health')
  .then(r=>r.json())
  .then(d=>{
    const b=document.getElementById('badge');
    b.textContent='● ÇEVRIMIÇI';
    b.style.borderColor='#2ecc71';b.style.color='#2ecc71';
    if(d.scraping){
      document.getElementById('prog').style.display='block';
      document.getElementById('scrapeBtn').textContent='⏳ SCRAPING...';
    }
    if(d.results>0)loadResults();
  })
  .catch(()=>{
    const b=document.getElementById('badge');
    b.textContent='● BAĞLANTI YOK';
    b.style.borderColor='#e74c3c';b.style.color='#e74c3c';
  });
</script></body></html>`);
});

// SERVER BAŞLAT — Playwright'tan bağımsız
app.listen(PORT, ()=>{
  console.log(`[Server] http://localhost:${PORT}`);
  console.log('[Server] Playwright LAZY load — scrape çağrıldığında yüklenecek');
});
