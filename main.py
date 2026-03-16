from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import asyncio
import httpx
import re
from datetime import datetime
from bs4 import BeautifulSoup

app = FastAPI(title="ÜÇGEN TJK API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

HEADERS = {"User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36", "Accept-Language": "tr-TR,tr;q=0.9"}

class At(BaseModel):
    no: int = 0
    isim: str = ""
    siklet: float = 0
    kgs: int = 0
    agf: int = 0
    jokey: str = ""
    jokeyWin: float = 0
    antrenor: str = ""
    sonYarislar: List[str] = []
    farkliSehirKazandi: bool = False
    sikletDustu: bool = False
    sonKosuSureyiIyi: bool = False

class Kosu(BaseModel):
    sehir: str = ""
    tarih: str = ""
    kosuNo: int = 0
    mesafe: str = ""
    pist: str = ""

class YarisVerisi(BaseModel):
    kosu: Kosu
    atlar: List[At]
    kaynak: str = ""
    uyari: str = ""

class AramaParametre(BaseModel):
    sehir: str
    tarih: str
    kosuNo: int

SEHIR_MAP = {"İzmir":"izmir","İstanbul":"istanbul","Ankara":"ankara","Antalya":"antalya","Bursa":"bursa","Adana":"adana","Şanlıurfa":"sanliurfa","Elazığ":"elazig","Kocaeli":"kocaeli"}

def safe_float(v):
    try: return float(str(v).replace(",",".").strip())
    except: return 0.0

def safe_int(v):
    try: return int(re.sub(r'[^\d]','',str(v)))
    except: return 0

def parse_tablo(html, kosu_no):
    atlar = []
    try:
        soup = BeautifulSoup(html, "lxml")
        tablolar = soup.find_all("table")
        for tablo in tablolar:
            satirlar = tablo.find_all("tr")
            at_no = 1
            for satir in satirlar[1:]:
                hucreler = satir.find_all("td")
                if len(hucreler) < 4: continue
                vals = [h.get_text(strip=True) for h in hucreler]
                isim = vals[1] if len(vals)>1 else ""
                if not isim or len(isim)<2: continue
                if not any(c.isalpha() for c in isim): continue
                son_str = vals[6] if len(vals)>6 else ""
                son_yarislar = re.split(r'[-\s]+', son_str)[:6]
                at = At(no=at_no, isim=isim,
                    siklet=safe_float(vals[3]) if len(vals)>3 else 0,
                    kgs=safe_int(vals[4]) if len(vals)>4 else 0,
                    agf=safe_int(vals[0]) if len(vals)>0 else at_no,
                    jokey=vals[5] if len(vals)>5 else "",
                    sonYarislar=son_yarislar)
                atlar.append(at)
                at_no += 1
            if len(atlar) >= 4: break
    except Exception as e:
        print(f"Parse hata: {e}")
    return atlar

async def cek(url, kaynak):
    try:
        async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code == 200:
                atlar = parse_tablo(r.text, 0)
                return atlar, kaynak
    except Exception as e:
        print(f"{kaynak} hata: {e}")
    return [], kaynak

@app.get("/")
async def root():
    return {"app": "ÜÇGEN TJK API", "durum": "aktif"}

@app.get("/saglik")
async def saglik():
    return {"durum": "ok", "zaman": datetime.now().isoformat()}

@app.post("/veri")
async def veri_cek(params: AramaParametre):
    slug = SEHIR_MAP.get(params.sehir, params.sehir.lower())
    tarih_fmt = params.tarih.replace("-","")
    dt = datetime.strptime(params.tarih, "%Y-%m-%d")
    tarih_lf = dt.strftime("%d.%m.%Y")
    urls = [
        (f"https://www.tjk.org/TR/YarisSever/Info/Page/ProgramVeBulten?TarihId={tarih_fmt}", "tjk.org"),
        (f"https://www.liderform.com.tr/program/{slug}/{tarih_lf}", "liderform.com.tr"),
        (f"https://www.misli.com/at-yarisi/{slug}/{params.tarih}/kosu-{params.kosuNo}", "misli.com"),
    ]
    sonuclar = await asyncio.gather(*[cek(u, k) for u, k in urls])
    en_iyi, en_iyi_kaynak = [], ""
    for atlar, kaynak in sonuclar:
        if len(atlar) > len(en_iyi):
            en_iyi = atlar
            en_iyi_kaynak = kaynak
    if not en_iyi:
        raise HTTPException(status_code=404, detail={"mesaj": "Veri alınamadı"})
    return {"basari": True, "kaynak": en_iyi_kaynak, "veri": YarisVerisi(kosu=Kosu(sehir=params.sehir, tarih=params.tarih, kosuNo=params.kosuNo), atlar=en_iyi, kaynak=en_iyi_kaynak)}

@app.get("/veri/{sehir}/{tarih}/{kosu_no}")
async def veri_get(sehir: str, tarih: str, kosu_no: int):
    return await veri_cek(AramaParametre(sehir=sehir, tarih=tarih, kosuNo=kosu_no))
from fastapi.responses import HTMLResponse

@app.get("/uygulama", response_class=HTMLResponse)
async def uygulama():
    return """<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ÜÇGEN TJK</title></head>
<body style="margin:0;background:#070714;color:#e2e8f0;font-family:monospace">
<div style="max-width:480px;margin:0 auto;padding:16px">
<div style="text-align:center;padding:20px 0">
<div style="font-size:40px">🐎</div>
<div style="font-size:24px;font-weight:900;color:#f59e0b;letter-spacing:4px">ÜÇGEN</div>
<div style="font-size:10px;color:#374151;letter-spacing:2px">TJK ANALİZ MOTORU</div>
</div>
<div style="background:#0d0d1a;border:1px solid #1a1a30;border-radius:12px;padding:16px;margin-bottom:12px">
<div style="color:#4b5563;font-size:11px;margin-bottom:8px">📍 ŞEHİR</div>
<div id="sehirler" style="display:flex;gap:6px;flex-wrap:wrap"></div>
</div>
<div style="background:#0d0d1a;border:1px solid #1a1a30;border-radius:12px;padding:16px;margin-bottom:12px">
<div style="color:#4b5563;font-size:11px;margin-bottom:6px">📅 TARİH</div>
<input type="date" id="tarih" style="width:100%;background:#111128;border:1px solid #1a1a35;border-radius:8px;color:#e2e8f0;padding:8px;font-size:13px;outline:none;box-sizing:border-box;color-scheme:dark">
<div style="color:#4b5563;font-size:11px;margin:10px 0 6px">🏁 KOŞU NO</div>
<div id="kosular" style="display:flex;gap:4px"></div>
</div>
<button onclick="analiz()" id="btn" style="width:100%;padding:14px;background:linear-gradient(135deg,#f59e0b,#d97706);border:none;border-radius:12px;color:#000;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:2px">⚡ ANALİZ ET</button>
<div id="sonuc" style="margin-top:16px"></div>
</div>
<script>
const SEHIRLER=["İzmir","İstanbul","Ankara","Antalya","Bursa","Adana","Şanlıurfa","Elazığ","Kocaeli"];
let sehir="İzmir",kosuNo=1;
const bugun=new Date().toISOString().split("T")[0];
document.getElementById("tarih").value=bugun;
const sd=document.getElementById("sehirler");
SEHIRLER.forEach(s=>{const b=document.createElement("button");b.textContent=s;b.onclick=()=>{sehir=s;render();};b.style.cssText="padding:5px 10px;border-radius:20px;border:none;cursor:pointer;font-size:10px;font-weight:700;transition:all 0.15s";sd.appendChild(b);});
const kd=document.getElementById("kosular");
for(let i=1;i<=10;i++){const b=document.createElement("button");b.textContent=i;b.onclick=()=>{kosuNo=i;render();};b.style.cssText="flex:1;padding:7px 0;border-radius:6px;border:none;cursor:pointer;font-size:11px;font-weight:700";kd.appendChild(b);}
function render(){
  document.querySelectorAll("#sehirler button").forEach((b,i)=>{b.style.background=SEHIRLER[i]===sehir?"#f59e0b":"#111128";b.style.color=SEHIRLER[i]===sehir?"#000":"#6b7280";});
  document.querySelectorAll("#kosular button").forEach((b,i)=>{b.style.background=(i+1)===kosuNo?"#f59e0b":"#111128";b.style.color=(i+1)===kosuNo?"#000":"#6b7280";});
}
render();
async function analiz(){
  const btn=document.getElementById("btn");
  btn.textContent="⏳ ÇEKİLİYOR...";btn.disabled=true;btn.style.background="#111128";btn.style.color="#374151";
  const tarih=document.getElementById("tarih").value;
  const sonuc=document.getElementById("sonuc");
  try{
    const r=await fetch("/veri",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sehir,tarih,kosuNo})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.detail?.mesaj||"Veri alınamadı");
    const atlar=d.veri.atlar;
    const maxS=Math.max(...atlar.map(a=>a.siklet||0));
    const puanli=atlar.map(at=>{
      const kgs=at.kgs||30,agf=at.agf||10,s=at.siklet||0;
      const fp=Math.min(30,Math.round(((at.sonYarislar||[]).slice(0,6).reduce((a,y)=>a+({1:6,2:4,3:2,4:1}[parseInt(y)]||0),0)/36)*30));
      const sp=Math.max(0,Math.round(20-(maxS-s)*1.8));
      const kp=kgs>=14&&kgs<=28?15:kgs>=7&&kgs<=13?10:8;
      const ap=agf>=5&&agf<=12?20:agf>=13?15:agf<=4?10:12;
      const jp=Math.min(15,Math.round((at.jokeyWin||0)*0.3));
      const gp=(kgs>=14&&kgs<=28?4:0)+(agf>=3&&agf<=8?4:0);
      const toplam=Math.min(100,fp+sp+kp+ap+jp+gp);
      return{...at,toplam};
    }).sort((a,b)=>b.toplam-a.toplam);
    const medals=["🥇","🥈","🥉"];
    const colors=["#f59e0b","#94a3b8","#cd7f32"];
    sonuc.innerHTML=`<div style="background:linear-gradient(135deg,#1a0f00,#1a1400);border:1px solid #f59e0b30;border-radius:16px;padding:16px;margin-bottom:16px"><div style="color:#f59e0b;font-size:10px;letter-spacing:3px;font-weight:700;text-align:center;margin-bottom:14px">🔺 ÜÇGEN — 3 KESİN ADAY</div>${puanli.slice(0,3).map((at,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:${i<2?"1px solid #1a1a30":"none"}"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:22px">${medals[i]}</span><div><div style="color:#e2e8f0;font-weight:700;font-size:14px">${at.isim}</div><div style="color:#6b7280;font-size:10px">🏇 ${at.jokey||"—"}</div></div></div><div style="text-align:right"><div style="font-size:22px;font-weight:900;color:${colors[i]}">${at.toplam}</div><div style="font-size:9px;color:#4b5563">/100</div></div></div>`).join("")}</div><div style="color:#374151;font-size:10px;letter-spacing:2px;margin-bottom:10px">TÜM ATLAR (${puanli.length})</div>${puanli.map((at,i)=>`<div style="background:${i<3?"linear-gradient(135deg,#0f0f23,#1a1a35)":"#0a0a18"};border:1px solid ${i<3?colors[i]+"50":"#1a1a30"};border-radius:10px;padding:12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center"><div><span style="color:${i<3?"#e2e8f0":"#9ca3af"};font-weight:700">${i+1}. ${at.isim}</span><div style="color:#6b7280;font-size:10px;margin-top:2px">⚖️${at.siklet}kg · KGS:${at.kgs}g · AGF:${at.agf}.</div></div><div style="font-size:18px;font-weight:900;color:${i<3?colors[i]:"#374151"}">${at.toplam}</div></div>`).join("")}<div style="color:#374151;font-size:10px;text-align:center;margin-top:8px">📡 ${d.kaynak}</div>`;
  }catch(e){sonuc.innerHTML=`<div style="background:#1a0000;border:1px solid #7f1d1d;border-radius:10px;padding:14px;color:#ef4444">⚠️ ${e.message}</div>`;}
  btn.textContent="⚡ ANALİZ ET";btn.disabled=false;btn.style.background="linear-gradient(135deg,#f59e0b,#d97706)";btn.style.color="#000";
}
</script></body></html>"""
