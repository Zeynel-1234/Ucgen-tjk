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
    with open("index.html", encoding="utf-8") as f:
        return f.read()

class MetinGirdi(BaseModel):
    metin: str
    sehir: str = ""
    tarih: str = ""
    kosuNo: int = 0

@app.post("/metin")
async def metinden_cek(girdi: MetinGirdi):
    atlar = parse_tablo(girdi.metin, girdi.kosuNo)
    if not atlar:
        satirlar = girdi.metin.strip().split("\n")
        at_no = 1
        for satir in satirlar:
            parcalar = satir.split()
            if len(parcalar) >= 2 and any(c.isalpha() for c in parcalar[0]):
                atlar.append(At(no=at_no, isim=parcalar[0], ekBilgi=satir))
                at_no += 1
    if not atlar:
        raise HTTPException(status_code=404, detail={"mesaj": "Metinden at verisi çıkarılamadı"})
    return {"basari": True, "kaynak": "kullanici", "veri": YarisVerisi(
        kosu=Kosu(sehir=girdi.sehir, tarih=girdi.tarih, kosuNo=girdi.kosuNo),
        atlar=atlar, kaynak="kullanici tarafindan girildi"
    )}
