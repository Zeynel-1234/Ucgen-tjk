from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import asyncio
import json
import re
from datetime import datetime
from playwright.async_api import async_playwright

app = FastAPI(title="ÜÇGEN TJK API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    ekBilgi: str = ""

class Kosu(BaseModel):
    sehir: str = ""
    tarih: str = ""
    kosuNo: int = 0
    mesafe: str = ""
    pist: str = ""
    kondisyon: str = ""

class YarisVerisi(BaseModel):
    kosu: Kosu
    atlar: List[At]
    kaynak: str = ""
    uyari: str = ""

class AramaParametre(BaseModel):
    sehir: str
    tarih: str
    kosuNo: int
  def safe_float(v):
    try: return float(str(v).replace(",",".").strip())
    except: return 0.0

def safe_int(v):
    try: return int(re.sub(r'[^\d]','', str(v)))
    except: return 0

def veri_kalitesi(atlar):
    if not atlar: return 0
    skor = len(atlar) * 10
    for at in atlar:
        if at.siklet: skor += 3
        if at.kgs: skor += 3
        if at.agf: skor += 3
        if at.jokey: skor += 2
        if len([y for y in at.sonYarislar if y]) >= 4: skor += 5
    return skor

async def scrape_site(url, sehir, tarih, kosu_no, kaynak_adi):
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
            locale="tr-TR"
        )
        page = await context.new_page()
        atlar = []
        try:
            await page.goto(url, timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(4)
            content = await page.content()
            clean = re.compile(r'<[^>]+>')
            td_pat = re.compile(r'<td[^>]*>(.*?)</td>', re.DOTALL|re.IGNORECASE)
            tr_pat = re.compile(r'<tr[^>]*>(.*?)</tr>', re.DOTALL|re.IGNORECASE)
            rows = tr_pat.findall(content)
            at_no = 1
            for row in rows:
                tds = td_pat.findall(row)
                if len(tds) < 4: continue
                vals = [clean.sub("",td).strip() for td in tds]
                isim = vals[1] if len(vals)>1 else ""
                if not isim or len(isim)<2: continue
                if not any(c.isalpha() for c in isim): continue
                son_str = vals[6] if len(vals)>6 else ""
                son_yarislar = re.split(r'[-\s]+', son_str)[:6]
                at = At(
                    no=at_no,
                    isim=isim,
                    siklet=safe_float(vals[3]) if len(vals)>3 else 0,
                    kgs=safe_int(vals[4]) if len(vals)>4 else 0,
                    agf=safe_int(vals[0]) if len(vals)>0 else at_no,
                    jokey=vals[5] if len(vals)>5 else "",
                    sonYarislar=son_yarislar,
                )
                atlar.append(at)
                at_no += 1
        except Exception as e:
            print(f"{kaynak_adi} hata: {e}")
        finally:
            await browser.close()
        return atlar
      SEHIR_MAP = {
    "İzmir":"izmir","İstanbul":"istanbul","Ankara":"ankara",
    "Antalya":"antalya","Bursa":"bursa","Adana":"adana",
    "Şanlıurfa":"sanliurfa","Elazığ":"elazig","Kocaeli":"kocaeli"
}

@app.get("/")
async def root():
    return {"app":"ÜÇGEN TJK API","durum":"aktif"}

@app.get("/saglik")
async def saglik():
    return {"durum":"ok","zaman":datetime.now().isoformat()}

@app.post("/veri")
async def veri_cek(params: AramaParametre):
    sehir_slug = SEHIR_MAP.get(params.sehir, params.sehir.lower())
    tarih_str = params.tarih.replace("-","")
    dt = datetime.strptime(params.tarih, "%Y-%m-%d")
    tarih_lf = dt.strftime("%d.%m.%Y")

    urls = [
        (f"https://www.tjk.org/TR/YarisSever/Info/Page/ProgramVeBulten?TarihId={tarih_str}", "tjk.org"),
        (f"https://www.liderform.com.tr/program/{sehir_slug}/{tarih_lf}", "liderform.com.tr"),
        (f"https://www.misli.com/at-yarisi/{sehir_slug}/{params.tarih}/kosu-{params.kosuNo}", "misli.com"),
    ]

    tasks = [scrape_site(url, params.sehir, params.tarih, params.kosuNo, ad) for url, ad in urls]
    sonuclar = await asyncio.gather(*tasks, return_exceptions=True)

    en_iyi_atlar = []
    en_iyi_kaynak = ""
    en_iyi_skor = 0

    for (url, ad), sonuc in zip(urls, sonuclar):
        if isinstance(sonuc, list) and sonuc:
            skor = veri_kalitesi(sonuc)
            if skor > en_iyi_skor:
                en_iyi_skor = skor
                en_iyi_atlar = sonuc
                en_iyi_kaynak = ad

    if not en_iyi_atlar:
        raise HTTPException(status_code=404, detail={
            "mesaj":"Hiçbir kaynaktan veri alınamadı",
            "ipucu":"Tarih ve şehri kontrol et"
        })

    return {
        "basari": True,
        "kaynak": en_iyi_kaynak,
        "veri": YarisVerisi(
            kosu=Kosu(sehir=params.sehir, tarih=params.tarih, kosuNo=params.kosuNo),
            atlar=en_iyi_atlar,
            kaynak=en_iyi_kaynak
        )
    }

@app.get("/veri/{sehir}/{tarih}/{kosu_no}")
async def veri_cek_get(sehir: str, tarih: str, kosu_no: int):
    return await veri_cek(AramaParametre(sehir=sehir, tarih=tarih, kosuNo=kosu_no))
