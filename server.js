'use strict';
const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(require('cors')());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const human  = () => sleep(rand(600, 1800));   // insan gecikmesi
const medium = () => sleep(rand(2000, 4000));

// İnsan gibi fare hareketi
async function humanMove(page, x, y) {
  await page.mouse.move(x + rand(-5,5), y + rand(-5,5), { steps: rand(8,20) });
}

// İnsan gibi tıklama
async function humanClick(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 8000 }).catch(() => null);
  if (!el) return false;
  const box = await el.boundingBox();
  if (!box) return false;
  await humanMove(page, box.x + box.width/2, box.y + box.height/2);
  await sleep(rand(100, 300));
  await el.click();
  await human();
  return true;
}

// İnsan gibi scroll
async function humanScroll(page) {
  const dist = rand(200, 600);
  await page.mouse.wheel(0, dist);
  await sleep(rand(300, 700));
}

// Browser başlat
async function launchBrowser() {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
    '--disable-infobars', '--window-size=390,844',
    '--disable-extensions', '--no-first-run',
  ];

  if (process.env.PROXY_URL) {
    args.push(`--proxy-server=${process.env.PROXY_URL}`);
    console.log('[Browser] Proxy:', process.env.PROXY_URL);
  }

  const browser = await chromium.launch({ headless: true, args });

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    extraHTTPHeaders: {
      'Accept-Language': 'tr-TR,tr;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
    },
  });

  // WebDriver gizle
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en'] });
  });

  return { browser, ctx };
}

// ─────────────────────────────────────────────
// TJK SCRAPER — ANA FONKSİYON
// ─────────────────────────────────────────────

const TJK_MOBILE = 'https://mobil.tjk.org';
const TJK_MAIN   = 'https://www.tjk.org';

// ADIM 1: Bugünkü program sayfasını aç
async function getProgram(ctx) {
  const page = await ctx.newPage();
  console.log('[TJK] Program sayfası açılıyor...');

  try {
    await page.goto(`${TJK_MOBILE}/tr/at-yarisi/kosu`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await human();
    await humanScroll(page);
    await human();

    // Hipodrom linklerini bul
    const hipodromlar = await page.evaluate(() => {
      const items = [];
      // Farklı selektörler dene
      const sels = [
        'a[href*="hipodrom"]', 'a[href*="kosu"]',
        '.hipodrom a', '.city-item a', '.track-item a',
        '[class*="hipodrom"] a', '[class*="venue"] a'
      ];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          const href = el.href;
          const name = el.textContent.trim();
          if (name && href && href.includes('http')) {
            items.push({ name, url: href });
          }
        });
        if (items.length > 0) break;
      }
      // Fallback: tüm linkleri tara
      if (items.length === 0) {
        document.querySelectorAll('a').forEach(el => {
          const t = el.textContent.trim();
          const href = el.href;
          if (t && href && (href.includes('kosu') || href.includes('race')) && t.length < 40) {
            items.push({ name: t, url: href });
          }
        });
      }
      return [...new Map(items.map(i => [i.url, i])).values()].slice(0, 6);
    });

    console.log(`[TJK] ${hipodromlar.length} hipodrom bulundu:`, hipodromlar.map(h => h.name));
    await page.close();
    return hipodromlar;
  } catch (e) {
    console.error('[TJK] Program hatası:', e.message);
    await page.close();
    return [];
  }
}

// ADIM 2: Hipodrom sayfasından koşu listesi al
async function getRaceList(ctx, hipodromUrl) {
  const page = await ctx.newPage();
  console.log('[TJK] Hipodrom sayfası:', hipodromUrl);

  try {
    await page.goto(hipodromUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await human();
    await humanScroll(page);

    const races = await page.evaluate(() => {
      const items = [];
      const sels = [
        'a[href*="kosuno"]', 'a[href*="race-no"]', 'a[href*="kosu-no"]',
        '.race-item a', '.kosu-item a', '[class*="race-list"] a',
        '[class*="kosu-list"] a', 'ul li a', '.card a'
      ];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.textContent.trim();
          const href = el.href;
          if (href && (txt.match(/^\d+/) || txt.includes('Koşu') || txt.includes('koşu'))) {
            items.push({ label: txt, url: href });
          }
        });
        if (items.length > 0) break;
      }
      // Fallback: numaralı linkler
      if (items.length === 0) {
        document.querySelectorAll('a').forEach(el => {
          const t = el.textContent.trim();
          const h = el.href;
          if (h && t.match(/^[1-9]\.?\s*(Koşu|koşu|KOŞU)?$/)) {
            items.push({ label: t, url: h });
          }
        });
      }
      return [...new Map(items.map(i => [i.url, i])).values()].slice(0, 15);
    });

    console.log(`[TJK] ${races.length} koşu bulundu`);
    await page.close();
    return races;
  } catch (e) {
    console.error('[TJK] Koşu listesi hatası:', e.message);
    await page.close();
    return [];
  }
}

// ADIM 3: Koşu kartı — tüm at verilerini çek
async function scrapeRaceCard(ctx, raceUrl, raceNo, track) {
  const page = await ctx.newPage();
  console.log(`[TJK] Koşu ${raceNo} kartı çekiliyor...`);

  try {
    await page.goto(raceUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await human();
    await humanScroll(page);
    await sleep(rand(500,1000));
    await humanScroll(page);

    // Koşu başlık bilgileri
    const raceInfo = await page.evaluate(() => {
      const getText = sel => document.querySelector(sel)?.textContent?.trim() || '';
      const html = document.body.innerHTML.toLowerCase();

      // Mesafe bul
      const distMatch = document.body.textContent.match(/(\d{3,4})\s*[Mm](?:etre|\.)?/);
      const dist = distMatch ? parseInt(distMatch[1]) : 0;

      // Pist türü
      const pist = html.includes('çim') ? 'çim' : html.includes('kum') ? 'kum' : '';

      // Koşu saati
      const saatMatch = document.body.textContent.match(/(\d{2}:\d{2})/);
      const saat = saatMatch ? saatMatch[1] : '';

      return { distance: dist, surface: pist, time: saat };
    });

    // AT TABLOSU — ana veri
    const horses = await page.evaluate(() => {
      const horses = [];

      // Tüm tabloları dene
      const tables = document.querySelectorAll('table');
      let bestTable = null;
      let maxRows = 0;

      tables.forEach(t => {
        const rows = t.querySelectorAll('tbody tr, tr');
        if (rows.length > maxRows) { maxRows = rows.length; bestTable = t; }
      });

      const rows = bestTable
        ? bestTable.querySelectorAll('tbody tr, tr')
        : document.querySelectorAll('tr, .horse-row, .at-row, [class*="horse"], [class*="at-item"]');

      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td, .cell, [class*="col"]');
        if (cells.length < 3) return;

        const allText = row.textContent.trim();
        if (!allText || allText.length < 4) return;

        const h = {};

        // No (sıra numarası)
        const noText = cells[0]?.textContent?.trim();
        if (noText && /^\d+$/.test(noText)) h.no = parseInt(noText);
        else h.no = idx + 1;

        // At adı
        const nameEl = row.querySelector('a, [class*="name"], [class*="ad"], strong, b');
        h.name = nameEl?.textContent?.trim() ||
                 cells[1]?.textContent?.trim() ||
                 cells[2]?.textContent?.trim() || '';

        if (!h.name || h.name.length < 2) return;
        if (/^\d+$/.test(h.name)) return; // sadece rakam ise atla

        // At detay linki
        const atLink = row.querySelector('a[href*="at"], a[href*="horse"]');
        if (atLink) h.detailUrl = atLink.href;

        // Jokey
        const jokeyEl = row.querySelector('[class*="jokey"], [class*="jockey"]');
        h.jockeyName = jokeyEl?.textContent?.trim() || cells[3]?.textContent?.trim() || '';

        // Jokey linki
        const jokeyLink = row.querySelector('a[href*="jokey"], a[href*="jockey"]');
        if (jokeyLink) h.jockeyUrl = jokeyLink.href;

        // Antrenör
        const antEl = row.querySelector('[class*="antren"], [class*="trainer"]');
        h.trainerName = antEl?.textContent?.trim() || '';
        const antLink = row.querySelector('a[href*="antren"], a[href*="trainer"]');
        if (antLink) h.trainerUrl = antLink.href;

        // Kilo
        const kiloCell = cells[4] || cells[5];
        const kiloMatch = kiloCell?.textContent?.match(/(\d{2,3}(?:\.\d+)?)/);
        if (kiloMatch) h.weight = parseFloat(kiloMatch[1]);

        // AGF
        let agfFound = false;
        row.querySelectorAll('[class*="agf"]').forEach(el => {
          const m = el.textContent.match(/(\d+\.?\d*)/);
          if (m) { h.agf = parseFloat(m[1]); agfFound = true; }
        });
        if (!agfFound) {
          for (let i = 5; i < cells.length; i++) {
            const t = cells[i]?.textContent?.trim();
            if (t && parseFloat(t) > 0 && parseFloat(t) < 200 && t.includes('.')) {
              h.agf = parseFloat(t); break;
            }
          }
        }

        // HP
        row.querySelectorAll('[class*="hp"]').forEach(el => {
          const m = el.textContent.match(/(\d+\.?\d*)/);
          if (m) h.hp = parseFloat(m[1]);
        });

        // Son 6Y
        const son6El = row.querySelector('[class*="form"], [class*="son6"], [class*="derece"], [class*="sicil"]');
        if (son6El) {
          const raw = son6El.textContent.trim();
          h.son6Y = raw.replace(/[^0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        } else {
          // Hücrelerde form arama
          for (let i = 5; i < Math.min(cells.length, 12); i++) {
            const t = cells[i]?.textContent?.trim() || '';
            if (/^[\d\-]{5,}$/.test(t)) { h.son6Y = t; break; }
          }
        }

        // KGS (Kaç Gün önce koştu)
        const kgsEl = row.querySelector('[class*="kgs"]');
        if (kgsEl) {
          const m = kgsEl.textContent.match(/(\d+)/);
          if (m) h.kgs = parseInt(m[1]);
        }

        // DS bayrağı
        h.ds = row.innerHTML.toLowerCase().includes(' ds') ||
               !!row.querySelector('[class*="ds"]') ||
               row.textContent.includes(' DS');

        // Gate/boks
        const gateEl = row.querySelector('[class*="gate"], [class*="boks"]');
        if (gateEl) {
          const m = gateEl.textContent.match(/(\d+)/);
          if (m) h.lane = parseInt(m[1]);
        }

        // Sahip
        const sahipEl = row.querySelector('[class*="sahip"], [class*="owner"]');
        if (sahipEl) h.ownerName = sahipEl.textContent.trim();

        horses.push(h);
      });

      return horses;
    });

    console.log(`[TJK] Koşu ${raceNo}: ${horses.length} at bulundu`);

    // ADIM 4: Her at için detay sayfasına git (idman + ek form)
    const enrichedHorses = [];
    for (const horse of horses.slice(0, 14)) { // max 14 at
      try {
        const enriched = await enrichHorse(ctx, horse, page);
        enrichedHorses.push(enriched);
      } catch (e) {
        enrichedHorses.push(horse);
      }
      await sleep(rand(400, 900));
    }

    // ADIM 5: Jokey istatistiklerini çek
    for (const horse of enrichedHorses) {
      if (horse.jockeyUrl && !horse.jockeyWinRate) {
        try {
          horse.jockeyWinRate = await scrapeJockeyStats(ctx, horse.jockeyUrl);
          await sleep(rand(300, 700));
        } catch (e) {}
      }
    }

    await page.close();

    return {
      id: `race_${raceNo}_${Date.now()}`,
      no: raceNo,
      track,
      date: new Date().toISOString().split('T')[0],
      time: raceInfo.time,
      distance: raceInfo.distance,
      surface: raceInfo.surface,
      horses: enrichedHorses.filter(h => h.name && h.name.length > 1),
      source: 'playwright',
    };
  } catch (e) {
    console.error(`[TJK] Koşu ${raceNo} hatası:`, e.message);
    await page.close();
    return null;
  }
}

// ADIM 4: At detay sayfası — idman zamanı + ek veri
async function enrichHorse(ctx, horse, parentPage) {
  if (!horse.detailUrl) return horse;

  const page = await ctx.newPage();
  try {
    await page.goto(horse.detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await human();

    // İdman sekmesine tıkla
    const idmanTab = await page.$('[class*="idman"], a:has-text("İdman"), button:has-text("İdman"), [href*="idman"]');
    if (idmanTab) {
      await idmanTab.click();
      await sleep(rand(1000, 2000));
    }

    const detail = await page.evaluate(() => {
      const result = {};

      // İdman verisi
      const idmanRows = document.querySelectorAll('[class*="idman"] tr, .idman-table tr');
      idmanRows.forEach(row => {
        const txt = row.textContent;
        // Süre formatı: 1:14.50 veya 74.50
        const timeMatch = txt.match(/(\d{1,2}:\d{2}\.\d{2}|\d{2}\.\d{1,2})/);
        if (timeMatch && !result.idmanTime) {
          result.idmanTime = timeMatch[1];
        }
        // İdman tarihi
        const dateMatch = txt.match(/(\d{2}[\.\-]\d{2}[\.\-]\d{4}|\d{4}[\.\-]\d{2}[\.\-]\d{2})/);
        if (dateMatch && !result.idmanDate) {
          result.idmanDate = dateMatch[1];
        }
      });

      // KGS (son koşu günü)
      const kgsEl = document.querySelector('[class*="kgs"], [class*="son-kosu"]');
      if (kgsEl) {
        const m = kgsEl.textContent.match(/(\d+)/);
        if (m) result.kgs = parseInt(m[1]);
      }

      // HP
      const hpEl = document.querySelector('[class*="hp"]');
      if (hpEl) {
        const m = hpEl.textContent.match(/(\d+\.?\d*)/);
        if (m) result.hp = parseFloat(m[1]);
      }

      // Yaş ve cinsiyet
      const ageEl = document.querySelector('[class*="yas"], [class*="age"], [class*="dogum"]');
      if (ageEl) {
        const m = ageEl.textContent.match(/(\d{4})/);
        if (m) result.birthYear = parseInt(m[1]);
      }

      // Köken/menşei
      const originEl = document.querySelector('[class*="mensei"], [class*="koken"], [class*="origin"]');
      if (originEl) result.origin = originEl.textContent.trim().slice(0, 30);

      // Son 6Y daha detaylı
      const formEl = document.querySelector('[class*="form"], [class*="sicil"], [class*="derece"]');
      if (formEl) {
        const raw = formEl.textContent.trim();
        const cleaned = raw.replace(/[^0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (cleaned.length > 2) result.son6Y = cleaned;
      }

      // El İdmanı (EID)
      const eidEl = document.querySelector('[class*="eid"], [class*="el-idman"]');
      if (eidEl) result.eid = eidEl.textContent.trim().slice(0, 5);

      return result;
    });

    // Birleştir
    if (detail.idmanTime) horse.idmanTime = detail.idmanTime;
    if (detail.idmanDate) horse.idmanDate = detail.idmanDate;
    if (detail.kgs) horse.kgs = detail.kgs;
    if (detail.hp) horse.hp = detail.hp;
    if (detail.birthYear) horse.age = new Date().getFullYear() - detail.birthYear;
    if (detail.origin) horse.origin = detail.origin;
    if (detail.son6Y && detail.son6Y.length > horse.son6Y?.length) horse.son6Y = detail.son6Y;
    if (detail.eid) horse.eid = detail.eid;

    console.log(`[TJK] At detay: ${horse.name} | idman=${horse.idmanTime || '-'} | kgs=${horse.kgs || '-'}`);
  } catch (e) {
    // Sessizce geç
  } finally {
    await page.close();
  }

  return horse;
}

// ADIM 5: Jokey istatistik sayfası
async function scrapeJockeyStats(ctx, jockeyUrl) {
  const page = await ctx.newPage();
  try {
    await page.goto(jockeyUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await human();

    const rate = await page.evaluate(() => {
      const txt = document.body.textContent;
      // "Kazanma Oranı: %18" veya "Galibiyyet: 45/250"
      const pctMatch = txt.match(/[Kk]azanma[^%]*%(\d+\.?\d*)/);
      if (pctMatch) return parseFloat(pctMatch[1]) / 100;
      const fracMatch = txt.match(/(\d+)\s*\/\s*(\d+)/);
      if (fracMatch && parseInt(fracMatch[2]) > 0) {
        return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
      }
      return null;
    });

    return rate;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ANA SCRAPING FONKSİYONU
async function scrapeTJK() {
  console.log('\n[TJK] ═══ SCRAPING BAŞLIYOR ═══');
  const { browser, ctx } = await launchBrowser();
  const allRaces = [];

  try {
    // Program sayfasını aç
    const hipodromlar = await getProgram(ctx);

    if (hipodromlar.length === 0) {
      // Fallback: direkt URL'lerle dene
      console.log('[TJK] Hipodrom bulunamadı, fallback URL deneniyor...');
      const fallbackUrls = [
        `${TJK_MOBILE}/tr/at-yarisi/kosu/1`,
        `${TJK_MOBILE}/tr/at-yarisi/program`,
        `${TJK_MAIN}/TR/YarisSever/Info/Page/GunlukYarisProgram`,
      ];

      for (const url of fallbackUrls) {
        const races = await getRaceList(ctx, url);
        if (races.length > 0) {
          hipodromlar.push(...races);
          break;
        }
      }
    }

    // Her hipodrom için koşuları çek
    for (const hipodrom of hipodromlar.slice(0, 3)) {
      console.log(`[TJK] Hipodrom: ${hipodrom.name}`);
      await medium();

      // Koşu listesi al
      let raceLinks = await getRaceList(ctx, hipodrom.url);

      // Eğer koşu listesi yoksa direkt hipodrom URL'si ile dene
      if (raceLinks.length === 0) {
        raceLinks = [{ label: '1. Koşu', url: hipodrom.url }];
      }

      // Her koşuyu scrape et
      for (let i = 0; i < Math.min(raceLinks.length, 10); i++) {
        const link = raceLinks[i];
        const raceNo = i + 1;

        console.log(`[TJK] → ${raceNo}. Koşu: ${link.url}`);
        await medium();

        const race = await scrapeRaceCard(ctx, link.url, raceNo, hipodrom.name);
        if (race && race.horses.length > 0) {
          allRaces.push(race);
          console.log(`[TJK] ✓ ${raceNo}. Koşu: ${race.horses.length} at, ${race.track}`);
        }
      }
    }

    console.log(`[TJK] ═══ TAMAMLANDI: ${allRaces.length} koşu ═══\n`);
  } catch (e) {
    console.error('[TJK] Genel hata:', e.message);
  } finally {
    await browser.close();
  }

  return allRaces;
}

// ─────────────────────────────────────────────
// URİS v3.5 — 12 Katman | Max 116 Puan
// ─────────────────────────────────────────────

function scoreSon6Y(son6Y) {
  if (!son6Y || son6Y === '-') return { score: 5, flags: ['YENİ_AT'] };
  const races = String(son6Y).split(/[-\s,]+/).map(r => parseInt(r)).filter(n => !isNaN(n));
  if (races.length === 0) return { score: 5, flags: [] };
  let score = 0;
  const flags = [];
  const w = [1.5, 1.2, 1.0, 0.7, 0.5, 0.4];
  races.slice(0, 6).forEach((pos, i) => {
    const wt = w[i] || 0.3;
    if (pos === 1) score += 5 * wt;
    else if (pos === 2) score += 4 * wt;
    else if (pos === 3) score += 3 * wt;
    else if (pos <= 5) score += 2 * wt;
    else if (pos === 0) score += 1 * wt;
  });
  if (races[0] === 1) { score += 2; flags.push('SON_KOŞU_1. ✓'); }
  if (races.slice(0,3).every(p => p > 0 && p <= 3)) { score += 2; flags.push('TUTARLI_FORM ✓'); }
  if (races.length >= 3 && races[0] < races[1] && races[1] < races[2]) { score += 1.5; flags.push('FORM_YÜKSELİŞİ ↑'); }
  return { score: Math.min(25, Math.round(score)), flags };
}

function scorePiyasa(agf, hp) {
  let score = 0; const flags = [];
  if (agf && agf > 0) {
    if (agf <= 1.5) { score += 12; flags.push(`AGF_BÜYÜK_FAV(${agf})`); }
    else if (agf <= 2.5) { score += 10; flags.push(`AGF_FAV(${agf})`); }
    else if (agf <= 4) score += 8;
    else if (agf <= 7) score += 5;
    else if (agf <= 12) score += 3;
    else { score += 1; flags.push(`AGF_UZUN(${agf}) 👻`); }
  } else score += 4;
  if (hp && hp > 0) {
    if (hp <= 2) { score += 3; flags.push(`HP_GÜÇLÜ(${hp}) ✓`); }
    else if (hp <= 5) score += 2; else score += 1;
  }
  if (hp && agf && hp < agf * 0.5) { score += 2; flags.push('GİZLİ_FAV: Piyasa görüyor'); }
  return { score: Math.min(15, Math.round(score)), flags };
}

function scoreJokey(winRate) {
  if (winRate == null) return { score: 5, flags: [] };
  const wr = winRate > 1 ? winRate / 100 : winRate;
  const flags = [];
  let score;
  if (wr >= 0.20) { score = 12; flags.push(`JOKEY_%${Math.round(wr*100)} ELİT ⭐`); }
  else if (wr >= 0.15) { score = 9; flags.push(`JOKEY_%${Math.round(wr*100)} İYİ`); }
  else if (wr >= 0.10) score = 6;
  else if (wr >= 0.05) score = 4;
  else { score = 2; flags.push('JOKEY_DÜŞÜK_%'); }
  return { score: Math.min(12, score), flags };
}

function scoreAntrenor(winRate) {
  if (winRate == null) return { score: 3, flags: [] };
  const wr = winRate > 1 ? winRate / 100 : winRate;
  let score;
  if (wr >= 0.20) score = 8;
  else if (wr >= 0.15) score = 6;
  else if (wr >= 0.10) score = 4;
  else if (wr >= 0.05) score = 2;
  else score = 1;
  return { score, flags: [] };
}

function scoreKilo(weight, allWeights) {
  if (!weight) return { score: 4, flags: [] };
  const flags = []; let score = 0;
  if (weight <= 54) { score += 3; flags.push(`HAFİF_KİLO:${weight}kg ✓`); }
  else if (weight <= 57) score += 2;
  else if (weight <= 60) score += 1;
  else flags.push(`AĞIR_KİLO:${weight}kg`);
  if (allWeights.length > 0) {
    const avg = allWeights.reduce((a, b) => a + b, 0) / allWeights.length;
    const adv = avg - weight;
    if (adv >= 3) { score += 4; flags.push(`EN_HAFİF:+${adv.toFixed(1)}kg ✓`); }
    else if (adv >= 1) score += 2;
    else if (adv <= -3) flags.push(`EN_AĞIR:-${Math.abs(adv).toFixed(1)}kg`);
  }
  return { score: Math.min(8, score), flags };
}

function scoreKGS(kgs) {
  if (kgs == null) return { score: 4, flags: [] };
  const flags = []; let score;
  if (kgs <= 14) { score = 8; flags.push(`TAZE:${kgs}gün ✓`); }
  else if (kgs <= 21) { score = 6; flags.push(`İYİ_FORM:${kgs}gün`); }
  else if (kgs <= 30) score = 5;
  else if (kgs <= 45) score = 3;
  else if (kgs <= 60) { score = 2; flags.push(`UZUN_ARA:${kgs}gün`); }
  else { score = 1; flags.push(`ÇOK_UZUN:${kgs}gün ⚠️`); }
  return { score, flags };
}

function scoreIdman(idmanTime) {
  if (!idmanTime) return { score: 3, flags: [] };
  const flags = []; let score = 0; let secs = 0;
  const s = String(idmanTime);
  if (s.includes(':')) { const p = s.split(':'); secs = parseFloat(p[0]) * 60 + parseFloat(p[1]); }
  else secs = parseFloat(s) || 0;
  if (secs > 0) {
    if (secs <= 67) { score = 8; flags.push(`İDMAN_SÜPER:${idmanTime} ✓`); }
    else if (secs <= 70) { score = 6; flags.push(`İDMAN_İYİ:${idmanTime}`); }
    else if (secs <= 74) score = 4;
    else if (secs <= 80) score = 2;
    else { score = 1; flags.push(`İDMAN_YAVAŞ:${idmanTime}`); }
  } else score = 3;
  if (s.toLowerCase().includes('k')) { score = Math.max(score, 4); flags.push('KENTER: Gizleme?'); }
  return { score: Math.min(8, score), flags };
}

function scoreDS(ds) {
  return ds ? { score: 5, flags: ['DS_BAYRAĞ ✓'] } : { score: 0, flags: [] };
}

function scoreHorse(horse, race) {
  const weights = (race.horses || []).map(h => h.weight).filter(w => w > 0);
  const l1 = scoreSon6Y(horse.son6Y);
  const l2 = scorePiyasa(horse.agf, horse.hp);
  const l3 = scoreJokey(horse.jockeyWinRate);
  const l4 = scoreAntrenor(horse.trainerWinRate);
  const l5 = scoreKilo(horse.weight, weights);
  const l6 = scoreKGS(horse.kgs);
  const l7 = scoreIdman(horse.idmanTime);
  const l8 = scoreDS(horse.ds);
  const ham = l1.score+l2.score+l3.score+l4.score+l5.score+l6.score+l7.score+l8.score;
  let bonus = 0;
  if (l1.score>=18 && l3.score>=9) bonus += 4;
  if (l2.score>=10 && l1.score>=15) bonus += 3;
  if (l7.score>=6 && l6.score>=7) bonus += 3;
  if (l8.score>0 && l3.score>=7) bonus += 3;
  if (l5.score>=6 && l2.score>=8) bonus += 3;
  bonus = Math.min(16, bonus);
  const total = Math.min(116, ham + bonus);
  let tier;
  if (total >= 80) tier = 'SOVEREIGN';
  else if (total >= 70) tier = 'BREAKER';
  else if (total >= 60) tier = 'GHOST';
  else tier = 'IZLE';
  const flags = [...l1.flags,...l2.flags,...l3.flags,...l4.flags,...l5.flags,...l6.flags,...l7.flags,...l8.flags];
  const breakdown = { son6Y:l1.score,piyasa:l2.score,jokey:l3.score,antrenor:l4.score,kilo:l5.score,kgs:l6.score,idman:l7.score,ds:l8.score };
  return { horse, score:ham, bonus, total, probability:0, tier, breakdown, flags };
}

function analyzeRace(race) {
  let scores = race.horses.map(h => scoreHorse(h, race));
  const tot = scores.reduce((s,r) => s + Math.max(1, r.total), 0);
  scores = scores.map(r => ({ ...r, probability: Math.round((Math.max(1,r.total)/tot)*100) }));
  const sorted = [...scores].sort((a,b) => b.total - a.total);
  const sovereign = sorted[0];
  const breaker = sorted[1] || sorted[0];
  // Ghost: piyasanın görmediği ama form var
  let ghost = sorted.find((s,i) => i>=2 && (!s.horse.agf||s.horse.agf>6) && s.total>=55);
  if (!ghost) ghost = sorted[Math.min(2, sorted.length-1)];
  sovereign.tier = 'SOVEREIGN';
  if (breaker!==sovereign) breaker.tier = 'BREAKER';
  if (ghost!==sovereign && ghost!==breaker) { ghost.tier = 'GHOST'; ghost.flags.push('👻 GHOST: Piyasanın görmediği aday'); }
  return { raceId: race.id||`r${Date.now()}`, raceNo:race.no, track:race.track, sovereign, breaker, ghost, allScores:sorted, timestamp:new Date().toISOString() };
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
let cache = { results:[], time:0 };
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 saat
let scraping = false;

app.get('/health', (_, res) => res.json({ ok:true, results:cache.results.length, scraping }));

// OTOMATİK SCRAPING
app.get('/api/scrape', async (_, res) => {
  if (scraping) return res.json({ status:'running', message:'Scraping devam ediyor, bekleyin...' });

  // Cache kontrol
  if (Date.now() - cache.time < CACHE_TTL && cache.results.length > 0) {
    return res.json({ success:true, source:'cache', count:cache.results.length, results:cache.results });
  }

  scraping = true;
  res.json({ status:'started', message:'TJK scraping başladı. /api/results ile takip edin.' });

  // Arka planda çalıştır
  scrapeTJK().then(races => {
    if (races.length > 0) {
      cache.results = races.map(r => analyzeRace(r));
      cache.time = Date.now();
      console.log(`[Cache] ${cache.results.length} koşu analizi kaydedildi`);
    }
  }).catch(e => console.error('[Scrape] Hata:', e.message))
    .finally(() => { scraping = false; });
});

// Bookmarklet veri al
app.post('/api/bookmarklet', (req, res) => {
  try {
    const { races, track, date } = req.body;
    if (!races || !Array.isArray(races)) return res.status(400).json({ error:'races gerekli' });
    const results = [];
    for (const r of races) {
      if (!r.horses || !r.horses.length) continue;
      const race = { id:`bkm_${r.no}_${Date.now()}`, no:r.no||1, track:track||r.track||'TJK', date:date||new Date().toISOString().split('T')[0], horses:r.horses };
      const result = analyzeRace(race);
      results.push(result);
      cache.results.push(result);
    }
    if (cache.results.length > 100) cache.results = cache.results.slice(-100);
    res.json({ success:true, analyzed:results.length, results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Sonuçları getir
app.get('/api/results', (_, res) => {
  res.json({ results:cache.results, count:cache.results.length, scraping });
});

// Bookmarklet kurulum sayfası
app.get('/bookmarklet', (req, res) => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  const bm = `javascript:(function(){var S='${host}';var rows=document.querySelectorAll('tr');var horses=[];rows.forEach(function(row,i){var c=row.querySelectorAll('td');if(c.length<4)return;var name=(c[1]||c[0]).textContent.trim();if(!name||name.length<2||/^\\d+$/.test(name))return;var h={no:parseInt(c[0].textContent)||i+1,name:name,jockeyName:(c[3]||{}).textContent||''};var wm=((c[4]||{}).textContent||'').match(/(\\d+\\.?\\d*)/);if(wm)h.weight=parseFloat(wm[1]);var s6=row.querySelector('[class*=form],[class*=son],[class*=derece]');h.son6Y=(s6?s6.textContent:(c[5]||{}).textContent||'').trim().replace(/\\s+/g,'-').replace(/[^0-9\\-]/g,'');var ae=row.querySelector('[class*=agf]');if(ae){var am=ae.textContent.match(/(\\d+\\.?\\d*)/);if(am)h.agf=parseFloat(am[1]);}var he=row.querySelector('[class*=hp]');if(he){var hm=he.textContent.match(/(\\d+\\.?\\d*)/);if(hm)h.hp=parseFloat(hm[1]);}h.ds=row.innerHTML.toLowerCase().includes(' ds');horses.push(h);});if(!horses.length){alert('AT BULUNAMADI!');return;}var no=prompt('Kaçıncı koşu?','1');var track=(document.querySelector('h1,h2,.title,.hipodrom')||{}).textContent||'TJK';fetch(S+'/api/bookmarklet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({races:[{no:parseInt(no)||1,track:track.trim().slice(0,20),horses:horses}],track:track.trim().slice(0,20)})}).then(r=>r.json()).then(function(d){if(d.success&&d.results[0]){var r=d.results[0];alert('✅ ANALİZ\\n\\n👑 '+r.sovereign.horse.name+' '+r.sovereign.total+'p %'+r.sovereign.probability+'\\n⚔️ '+r.breaker.horse.name+' '+r.breaker.total+'p %'+r.breaker.probability+'\\n👻 '+r.ghost.horse.name+' '+r.ghost.total+'p %'+r.ghost.probability+'\\n\\n'+S);}else alert(JSON.stringify(d));}).catch(e=>alert(e.message));})();`;

  res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Bookmarklet</title>
<style>body{background:#0a0a0f;color:#eee;font-family:monospace;padding:20px;max-width:640px;margin:0 auto}h1{color:#f5a623;margin-bottom:20px}.code{background:#111;border:1px solid #f5a623;border-radius:8px;padding:16px;word-break:break-all;font-size:11px;color:#aaa;cursor:pointer;margin:12px 0}.step{background:#1a1a1a;border-left:3px solid #f5a623;padding:12px 16px;margin:8px 0;border-radius:0 6px 6px 0}.step strong{color:#f5a623}code{background:#222;padding:2px 6px;border-radius:3px;color:#f5a623}.copy-btn{background:#f5a623;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:13px;margin-top:8px}</style></head><body>
<h1>🏇 TJK Bookmarklet Kurulumu</h1>
<div class="step"><strong>1. Adım:</strong> Aşağıdaki koda tıkla → Kopyalandı!</div>
<div class="code" onclick="navigator.clipboard.writeText(this.dataset.bm);this.style.borderColor='#2ecc71';this.textContent='✅ Kopyalandı!';" data-bm="${bm.replace(/"/g,'&quot;')}">${bm.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
<div class="step"><strong>2. Adım:</strong> Via Browser → adres çubuğuna yapıştır → Çalıştır<br>(Ya da: Yeni bookmark → URL olarak kaydet)</div>
<div class="step"><strong>3. Adım:</strong> <code>mobil.tjk.org</code> → Bir koşunun at listesi sayfasına git</div>
<div class="step"><strong>4. Adım:</strong> Bookmarkı çalıştır → Koşu no gir → Analiz gelir</div>
<div class="step"><strong>Dashboard:</strong> <code>${host}</code></div>
</body></html>`);
});

// Ana dashboard
app.get('/', (_, res) => {
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
.btn:hover{background:var(--g);color:#000}
.btn.sec{border-color:#444;color:#777}.btn.sec:hover{background:#444;color:#fff}
.progress{background:var(--card);border:1px solid var(--g);border-radius:6px;padding:12px;margin-bottom:16px;font-size:12px;color:var(--g);display:none}
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
.hi{font-size:10px;color:#666}
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
.fl.p{color:var(--gr);border-color:rgba(46,204,113,.2)}.fl.w{color:var(--g);border-color:rgba(245,166,35,.2)}.fl.gh{color:var(--p);border-color:rgba(155,89,182,.2)}
.alc{background:var(--card);border:1px solid var(--brd);border-radius:8px;margin-bottom:14px;overflow:hidden}
.alh{padding:10px 14px;font-size:10px;color:#555;letter-spacing:2px;border-bottom:1px solid var(--brd)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#444;font-size:9px;letter-spacing:1px;padding:7px 6px;border-bottom:1px solid var(--brd)}
td{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.03)}
tr:hover td{background:rgba(255,255,255,.02)}
.ts{color:var(--g)}.tb{color:var(--b)}.tg{color:var(--p)}.ti{color:#555}
.empty,.loading{text-align:center;padding:50px 20px;color:#555;line-height:2}
.spin{width:28px;height:28px;border:2px solid var(--brd);border-top-color:var(--g);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--g);border-radius:6px;padding:10px 16px;font-size:12px;color:var(--g);z-index:999;opacity:0;transition:opacity .3s;white-space:nowrap}
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
  <div class="progress" id="prog">⏳ TJK scraping devam ediyor... Her koşu için detay sayfaları geziliyor. 3-5 dakika sürebilir.</div>
  <div id="tabs" class="tabs" style="display:none"></div>
  <div id="app"></div>
</main>
<div class="toast" id="toast"></div>
<script>
let results=[],cur=0,polling=null;

async function startScrape(){
  document.getElementById('prog').style.display='block';
  document.getElementById('scrapeBtn').textContent='⏳ SCRAPING...';
  show('<div class="loading"><div class="spin"></div>TJK.org\'a bağlanılıyor...<br>İnsan gibi sayfalar geziliyor...<br>At detayları, idman ve jokey verileri çekiliyor...<br><br>Bu 3-5 dakika sürebilir.</div>');
  try{
    await fetch('/api/scrape');
    // Polling başlat
    if(polling) clearInterval(polling);
    polling=setInterval(async()=>{
      const d=await fetch('/api/results').then(r=>r.json());
      if(d.results&&d.results.length>0){
        clearInterval(polling); polling=null;
        document.getElementById('prog').style.display='none';
        document.getElementById('scrapeBtn').textContent='🤖 OTO SCRAPE';
        results=d.results; renderTabs(); renderRace(0);
        toast('✅ '+d.count+' koşu analiz edildi');
      }
      // Scraping bittiyse ama sonuç yoksa
      const h=await fetch('/health').then(r=>r.json());
      if(!h.scraping&&d.results.length===0){
        clearInterval(polling); polling=null;
        document.getElementById('prog').style.display='none';
        document.getElementById('scrapeBtn').textContent='🤖 OTO SCRAPE';
        show('<div class="empty">⚠️ TJK\'dan veri çekilemedi.<br>IP engeli olabilir. Bookmarklet deneyin.</div>');
      }
    },5000);
  }catch(e){show('<div class="empty">Hata: '+e.message+'</div>');}
}

async function loadResults(){
  try{
    const d=await fetch('/api/results').then(r=>r.json());
    if(d.results&&d.results.length){results=d.results;renderTabs();renderRace(0);toast('✅ '+d.count+' sonuç');}
    else show('<div class="empty">Veri yok.<br><br>🤖 <b style="color:var(--g)">OTO SCRAPE</b> → TJK\'yı otomatik gez<br>📋 <b style="color:var(--g)">BOOKMARKLET</b> → Kendin gir, veriyi gönder</div>');
  }catch(e){show('<div class="empty">Sunucu hatası: '+e.message+'</div>');}
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
    return\`<span class="fl \${c}">\${f.slice(0,30)}</span>\`;
  }).join('');
  return\`<div class="card \${cls}"><div class="ch"><div>
    <div class="cl">\${label}</div>
    <div class="hn">\${s.horse?.name||'?'}</div>
    <div class="hi">No:\${s.horse?.no} \${s.horse?.jockeyName?'| '+s.horse.jockeyName:''} \${s.horse?.weight?'| '+s.horse.weight+'kg':''} \${s.horse?.idmanTime?'| İdman:'+s.horse.idmanTime:''} \${s.horse?.kgs?'| KGS:'+s.horse.kgs+'g':''}</div>
  </div><div>
    <div class="sb">\${s.total}</div>
    <div class="sp">%\${s.probability}</div>
    <div style="font-size:10px;color:#555;text-align:right">+\${s.bonus}bonus</div>
  </div></div>
  <div class="pb"><div class="pf" style="width:\${s.probability}%"></div></div>
  <div class="bd">\${bi('SON6Y',bd.son6Y)}\${bi('PİYASA',bd.piyasa)}\${bi('JOKEY',bd.jokey)}\${bi('KILO',bd.kilo)}\${bi('KGS',bd.kgs)}\${bi('İDMAN',bd.idman)}\${bi('DS',bd.ds)}\${bi('BONUS',s.bonus)}</div>
  <div class="fls">\${fls}</div></div>\`;
}

function allTable(r){
  const tc={SOVEREIGN:'ts',BREAKER:'tb',GHOST:'tg',IZLE:'ti'};
  const rows=(r.allScores||[]).map(s=>\`<tr>
    <td>\${s.horse?.no}</td>
    <td>\${s.horse?.name}</td>
    <td>\${s.horse?.son6Y||'-'}</td>
    <td>\${s.horse?.agf||'-'}</td>
    <td>\${s.horse?.kgs!=null?s.horse.kgs+'g':'-'}</td>
    <td>\${s.horse?.idmanTime||'-'}</td>
    <td class="\${tc[s.tier]||'ti'}">\${s.total}p</td>
    <td class="\${tc[s.tier]||'ti'}" style="font-size:10px">\${s.tier}</td>
  </tr>\`).join('');
  return\`<div class="alc"><div class="alh">TÜM ATLAR — \${r.raceNo}. KOŞU / \${r.track}</div>
  <table><thead><tr><th>No</th><th>At</th><th>Son6Y</th><th>AGF</th><th>KGS</th><th>İdman</th><th>Puan</th><th>Rol</th></tr></thead>
  <tbody>\${rows}</tbody></table></div>\`;
}

function show(html){document.getElementById('app').innerHTML=html;}
function clearAll(){results=[];cur=0;document.getElementById('tabs').style.display='none';show('<div class="empty">Temizlendi.</div>');}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');setTimeout(()=>el.classList.remove('on'),3000);}

fetch('/health').then(r=>r.json()).then(d=>{
  document.getElementById('badge').textContent='● ÇEVRIMIÇI';
  if(d.scraping){document.getElementById('prog').style.display='block';}
}).catch(()=>{document.getElementById('badge').style.cssText='border-color:red;color:red';document.getElementById('badge').textContent='● BAĞLANTI YOK';});

loadResults();
</script></body></html>`);
});

app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
