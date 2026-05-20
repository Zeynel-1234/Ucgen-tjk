"""
KET Backtest API
================
RTALB ve diğer BIST hisselerinde Kinezyolojik Denge İzi indikatörünün
tüm geçmiş üzerinde otomatik backtest'i. Yahoo Finance üzerinden veri alır,
KET formülünü uygular, isabet oranı / ortalama kazanç / max düşüş istatistikleri çıkarır.

Render deployment: Dockerfile mevcut, PORT env auto-detect.
Yerel: uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
import yfinance as yf
import numpy as np
import pandas as pd
from typing import List, Optional
import math


app = FastAPI(title="KET Backtest API", version="1.0")


# =================== MODEL ===================
class BacktestParams(BaseModel):
    symbol: str = Field("RTALB.IS", description="Yahoo sembolü, BIST için .IS suffix")
    period: str = Field("5y", description="1y, 2y, 5y, 10y, max")
    interval: str = Field("1d", description="1d, 1wk, 1h")
    lookback: int = Field(20, ge=5, le=200)
    k_bars: int = Field(10, ge=3, le=50)
    m_bars: int = Field(4, ge=2, le=30)
    v_ratio: float = Field(0.60, ge=0.1, le=1.0)
    n_ratio: float = Field(0.60, ge=0.1, le=1.0)
    range_ratio: float = Field(0.50, ge=0.1, le=1.0)
    delta_tol: float = Field(0.005, ge=0.0, le=0.05)
    dts_trigger: float = Field(0.80, ge=0.5, le=0.99)
    alpha: float = Field(1.5, gt=0)
    beta: float = Field(1.0, ge=0)
    target_gain: float = Field(0.20, gt=0)
    max_hold_bars: int = Field(60, ge=2, le=500)
    min_aqs: float = Field(0.4, ge=0, le=1.0, description="Minimum Soğurma Kalitesi Skoru")


# =================== KET ÇEKİRDEK ===================
def compute_ket(df: pd.DataFrame, p: BacktestParams) -> pd.DataFrame:
    """KET indikatörünü hesapla. df: OHLCV pandas DataFrame."""
    df = df.copy()
    eps = 1e-9
    avg_price = float(df['Close'].mean())
    tick_proxy = avg_price * 0.0001

    df['range'] = (df['High'] - df['Low']).clip(lower=tick_proxy)

    # N-proxy: Yahoo trade count vermiyor; relative volume + range çeşitliliği kombine
    # Activity intensity = (V / V̄) * (range / rangē)  — yüksek aktivite işareti
    v_norm = df['Volume'] / df['Volume'].rolling(p.lookback).mean().clip(lower=1.0)
    r_norm = df['range'] / df['range'].rolling(p.lookback).mean().clip(lower=tick_proxy)
    df['n_proxy'] = (v_norm * r_norm).clip(lower=0.1) * 10.0

    # Atomik metrikler
    df['g'] = df['Volume'] / df['n_proxy']
    df['e'] = (df['Close'] - df['Open']) / df['range']
    df['a'] = df['Volume'] * df['range'] / df['n_proxy']

    # === DTS (dip tükenme) ===
    df['prior_min_low'] = df['Low'].shift(1).rolling(p.k_bars).min()
    df['disp_low'] = (df['Low'] - df['prior_min_low']).abs().clip(lower=tick_proxy * 0.5)
    df['pdr_low'] = (df['Volume'] * df['n_proxy']) / df['disp_low']
    pdr_low_mean = df['pdr_low'].rolling(p.lookback).mean()
    pdr_low_std = df['pdr_low'].rolling(p.lookback).std().clip(lower=eps)
    df['pdr_low_z'] = (df['pdr_low'] - pdr_low_mean) / pdr_low_std
    df['dts'] = 1.0 / (1.0 + np.exp(-p.alpha * (df['pdr_low_z'] - p.beta).clip(-50, 50)))

    # === TTS (tepe tükenme) ===
    df['prior_max_high'] = df['High'].shift(1).rolling(p.k_bars).max()
    df['disp_high'] = (df['High'] - df['prior_max_high']).abs().clip(lower=tick_proxy * 0.5)
    df['pdr_high'] = (df['Volume'] * df['n_proxy']) / df['disp_high']
    pdr_high_mean = df['pdr_high'].rolling(p.lookback).mean()
    pdr_high_std = df['pdr_high'].rolling(p.lookback).std().clip(lower=eps)
    df['pdr_high_z'] = (df['pdr_high'] - pdr_high_mean) / pdr_high_std
    df['tts'] = 1.0 / (1.0 + np.exp(-p.alpha * (df['pdr_high_z'] - p.beta).clip(-50, 50)))

    # Pre-trigger & soğurma penceresi ortalamaları
    df['v_mean_k'] = df['Volume'].rolling(p.k_bars).mean()
    df['n_mean_k'] = df['n_proxy'].rolling(p.k_bars).mean()
    df['r_mean_k'] = df['range'].rolling(p.k_bars).mean()
    df['v_mean_m'] = df['Volume'].rolling(p.m_bars).mean()
    df['n_mean_m'] = df['n_proxy'].rolling(p.m_bars).mean()
    df['r_mean_m'] = df['range'].rolling(p.m_bars).mean()
    df['min_low_m'] = df['Low'].rolling(p.m_bars).min()
    df['max_high_m'] = df['High'].rolling(p.m_bars).max()

    # === Tetik durum makinesi + AQS ===
    df['buy_signal'] = False
    df['sell_signal'] = False
    df['aqs_low'] = np.nan
    df['aqs_high'] = np.nan

    cooldown = p.m_bars * 2
    last_low_trig = -10**9
    last_high_trig = -10**9
    pending_lows = []   # [(trigger_idx, low_px, ref_v, ref_n, ref_r), ...]
    pending_highs = []

    def f_score(actual, target_max):
        if target_max <= 0 or np.isnan(target_max):
            return 0.0
        if actual >= target_max:
            return 0.0
        return max(0.0, 1.0 - actual / target_max)

    n = len(df)
    cols = {c: df.columns.get_loc(c) for c in ['buy_signal', 'sell_signal', 'aqs_low', 'aqs_high']}
    arr = df.values

    dts_col = df.columns.get_loc('dts')
    tts_col = df.columns.get_loc('tts')
    low_col = df.columns.get_loc('Low')
    high_col = df.columns.get_loc('High')
    vmk_col = df.columns.get_loc('v_mean_k')
    nmk_col = df.columns.get_loc('n_mean_k')
    rmk_col = df.columns.get_loc('r_mean_k')
    vmm_col = df.columns.get_loc('v_mean_m')
    nmm_col = df.columns.get_loc('n_mean_m')
    rmm_col = df.columns.get_loc('r_mean_m')
    minl_col = df.columns.get_loc('min_low_m')
    maxh_col = df.columns.get_loc('max_high_m')

    for i in range(n):
        # ---- DİP tetik ----
        dts_val = arr[i, dts_col]
        if not np.isnan(dts_val) and dts_val > p.dts_trigger and (i - last_low_trig) > cooldown:
            ref_v = arr[i-1, vmk_col] if i > 0 else arr[i, vmk_col]
            ref_n = arr[i-1, nmk_col] if i > 0 else arr[i, nmk_col]
            ref_r = arr[i-1, rmk_col] if i > 0 else arr[i, rmk_col]
            if not (np.isnan(ref_v) or np.isnan(ref_n) or np.isnan(ref_r)):
                pending_lows.append((i, arr[i, low_col], ref_v, ref_n, ref_r))
                last_low_trig = i

        # ---- AQS hesabı (tetikten m bar sonra) ----
        keep_lows = []
        for (t_idx, t_low, t_v, t_n, t_r) in pending_lows:
            age = i - t_idx
            if age == p.m_bars:
                vs = f_score(arr[i, vmm_col], p.v_ratio * t_v)
                ns = f_score(arr[i, nmm_col], p.n_ratio * t_n)
                rs = f_score(arr[i, rmm_col], p.range_ratio * t_r)
                ls = 1.0 if arr[i, minl_col] >= t_low * (1.0 - p.delta_tol) else 0.0
                prod = max(vs, 1e-9) * max(ns, 1e-9) * max(rs, 1e-9) * max(ls, 1e-9)
                aqs = prod ** 0.25
                arr[i, cols['aqs_low']] = aqs
                if aqs >= p.min_aqs:
                    arr[i, cols['buy_signal']] = True
            elif age < p.m_bars:
                keep_lows.append((t_idx, t_low, t_v, t_n, t_r))
        pending_lows = keep_lows

        # ---- TEPE tetik ----
        tts_val = arr[i, tts_col]
        if not np.isnan(tts_val) and tts_val > p.dts_trigger and (i - last_high_trig) > cooldown:
            ref_v = arr[i-1, vmk_col] if i > 0 else arr[i, vmk_col]
            ref_n = arr[i-1, nmk_col] if i > 0 else arr[i, nmk_col]
            ref_r = arr[i-1, rmk_col] if i > 0 else arr[i, rmk_col]
            if not (np.isnan(ref_v) or np.isnan(ref_n) or np.isnan(ref_r)):
                pending_highs.append((i, arr[i, high_col], ref_v, ref_n, ref_r))
                last_high_trig = i

        keep_highs = []
        for (t_idx, t_high, t_v, t_n, t_r) in pending_highs:
            age = i - t_idx
            if age == p.m_bars:
                vs = f_score(arr[i, vmm_col], p.v_ratio * t_v)
                ns = f_score(arr[i, nmm_col], p.n_ratio * t_n)
                rs = f_score(arr[i, rmm_col], p.range_ratio * t_r)
                hs = 1.0 if arr[i, maxh_col] <= t_high * (1.0 + p.delta_tol) else 0.0
                prod = max(vs, 1e-9) * max(ns, 1e-9) * max(rs, 1e-9) * max(hs, 1e-9)
                aqs = prod ** 0.25
                arr[i, cols['aqs_high']] = aqs
                if aqs >= p.min_aqs:
                    arr[i, cols['sell_signal']] = True
            elif age < p.m_bars:
                keep_highs.append((t_idx, t_high, t_v, t_n, t_r))
        pending_highs = keep_highs

    out = pd.DataFrame(arr, index=df.index, columns=df.columns)
    out['buy_signal'] = out['buy_signal'].astype(bool)
    out['sell_signal'] = out['sell_signal'].astype(bool)
    return out


def evaluate_signals(df: pd.DataFrame, p: BacktestParams) -> dict:
    """Her AL sinyali için: gelecek max_hold_bars içinde target_gain'e ulaştı mı?"""
    buy_idx = df.index[df['buy_signal']].tolist()
    sell_idx = df.index[df['sell_signal']].tolist()

    closes = df['Close'].values
    highs = df['High'].values
    lows = df['Low'].values
    aqs_low_arr = df['aqs_low'].values

    buy_results = []
    for bi in buy_idx:
        pos = df.index.get_loc(bi)
        if pos + 2 >= len(df):
            continue
        entry = float(closes[pos])
        end = min(pos + p.max_hold_bars + 1, len(df))
        fh = highs[pos+1:end]
        fl = lows[pos+1:end]
        if len(fh) == 0:
            continue
        max_gain = (fh.max() - entry) / entry
        max_dd = (fl.min() - entry) / entry
        hit = max_gain >= p.target_gain
        bars_to_target = -1
        if hit:
            for j, h in enumerate(fh):
                if (h - entry) / entry >= p.target_gain:
                    bars_to_target = j + 1
                    break
        buy_results.append({
            'date': str(bi)[:10],
            'entry_price': round(entry, 4),
            'max_gain_pct': round(float(max_gain) * 100, 2),
            'max_drawdown_pct': round(float(max_dd) * 100, 2),
            'hit_target': bool(hit),
            'bars_to_target': int(bars_to_target),
            'aqs': round(float(aqs_low_arr[pos]) if not np.isnan(aqs_low_arr[pos]) else 0.0, 3),
        })

    sell_results = []
    aqs_high_arr = df['aqs_high'].values
    for si in sell_idx:
        pos = df.index.get_loc(si)
        if pos + 2 >= len(df):
            continue
        entry = float(closes[pos])
        end = min(pos + p.max_hold_bars + 1, len(df))
        fh = highs[pos+1:end]
        fl = lows[pos+1:end]
        if len(fl) == 0:
            continue
        max_dd_short = (entry - fl.min()) / entry   # short pozisyon için kazanç
        max_adverse = (fh.max() - entry) / entry
        hit = max_dd_short >= p.target_gain
        sell_results.append({
            'date': str(si)[:10],
            'entry_price': round(entry, 4),
            'max_decline_pct': round(float(max_dd_short) * 100, 2),
            'max_adverse_pct': round(float(max_adverse) * 100, 2),
            'hit_target': bool(hit),
            'aqs': round(float(aqs_high_arr[pos]) if not np.isnan(aqs_high_arr[pos]) else 0.0, 3),
        })

    total_buy = len(buy_results)
    hits = sum(1 for r in buy_results if r['hit_target'])
    hit_rate = hits / total_buy if total_buy else 0.0
    avg_gain = float(np.mean([r['max_gain_pct'] for r in buy_results])) if buy_results else 0.0
    avg_dd = float(np.mean([r['max_drawdown_pct'] for r in buy_results])) if buy_results else 0.0
    med_bars = float(np.median([r['bars_to_target'] for r in buy_results if r['bars_to_target'] > 0])) if hits else -1.0

    return {
        'total_buy_signals': total_buy,
        'hits_at_target': hits,
        'hit_rate': round(hit_rate, 4),
        'avg_max_gain_pct': round(avg_gain, 2),
        'avg_max_drawdown_pct': round(avg_dd, 2),
        'median_bars_to_target': med_bars,
        'total_sell_signals': len(sell_results),
        'sell_hits': sum(1 for r in sell_results if r['hit_target']),
        'buy_signals': buy_results,
        'sell_signals': sell_results,
    }


# =================== ENDPOINT'LER ===================
@app.post("/backtest")
def run_backtest(params: BacktestParams):
    try:
        tkr = yf.Ticker(params.symbol)
        df = tkr.history(period=params.period, interval=params.interval, auto_adjust=False)
        if df is None or len(df) < max(50, params.lookback * 3):
            raise HTTPException(400, f"Yetersiz veri: {0 if df is None else len(df)} bar (min {params.lookback * 3})")
        df_ket = compute_ket(df, params)
        eval_res = evaluate_signals(df_ket, params)
        return {
            'symbol': params.symbol,
            'period': params.period,
            'interval': params.interval,
            'bars_analyzed': len(df),
            'date_range': [str(df.index[0])[:10], str(df.index[-1])[:10]],
            'target_gain_pct': params.target_gain * 100,
            'max_hold_bars': params.max_hold_bars,
            **eval_res,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {str(e)}")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def home():
    return HTML_UI


# =================== MOBİL ARAYÜZ ===================
HTML_UI = """<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>KET // Backtest</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Fraunces:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0e1a;
  --panel:#11182a;
  --panel-2:#161f33;
  --border:#1f2a44;
  --text:#e6e9f0;
  --muted:#7c8aa8;
  --amber:#f5a623;
  --mint:#5cd6a8;
  --red:#e85a71;
  --grid:rgba(245,166,35,0.06);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased}
body{
  min-height:100vh;
  background-image:
    linear-gradient(var(--grid) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:32px 32px;
  background-position:-1px -1px;
}
.wrap{max-width:540px;margin:0 auto;padding:18px 14px 40px}
header{padding:8px 0 24px;border-bottom:1px solid var(--border);margin-bottom:18px;position:relative}
header::before{content:"";position:absolute;left:0;top:0;width:36px;height:2px;background:var(--amber)}
h1{font-family:'Fraunces',serif;font-weight:700;font-size:28px;letter-spacing:-0.02em;line-height:1}
.tag{color:var(--muted);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-top:6px}
.sub{color:var(--mint);font-size:12px;margin-top:10px;font-weight:500}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
label{font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);font-weight:500}
input,select{background:var(--panel);color:var(--text);border:1px solid var(--border);padding:10px 12px;border-radius:0;font-family:'IBM Plex Mono',monospace;font-size:14px;width:100%;transition:border-color .15s}
input:focus,select:focus{outline:none;border-color:var(--amber)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
button{background:var(--amber);color:var(--bg);border:none;padding:14px 20px;font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;width:100%;margin-top:14px;transition:transform .1s,filter .15s}
button:hover{filter:brightness(1.1)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5;cursor:wait}
.summary{background:var(--panel);border:1px solid var(--border);padding:18px;margin-top:22px;position:relative}
.summary::before{content:"";position:absolute;left:-1px;top:0;width:3px;height:100%;background:var(--amber)}
.summary h2{font-family:'Fraunces',serif;font-size:18px;font-weight:500;letter-spacing:-0.01em;margin-bottom:14px}
.summary .sym{color:var(--amber);font-weight:600}
.metric-row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px dotted var(--border)}
.metric-row:last-child{border:none}
.metric-row .k{color:var(--muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase}
.metric-row .v{font-size:16px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.metric-row .v.mint{color:var(--mint)}
.metric-row .v.red{color:var(--red)}
.metric-row .v.amber{color:var(--amber)}
.sig-list{margin-top:18px}
.sig-list h3{font-family:'Fraunces',serif;font-size:14px;color:var(--muted);font-weight:500;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.sig{background:var(--panel-2);border-left:2px solid var(--border);padding:12px 14px;margin-bottom:6px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
.sig.hit{border-left-color:var(--mint)}
.sig.miss{border-left-color:var(--red)}
.sig .d{font-size:13px;color:var(--text);font-weight:500}
.sig .g{font-size:11px;color:var(--muted);margin-top:2px}
.sig .badge{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.sig .badge.hit{color:var(--mint)}
.sig .badge.miss{color:var(--red)}
.sig .aqs{font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.05em}
.status{padding:10px 14px;color:var(--muted);font-size:12px;letter-spacing:0.05em;text-align:center;margin-top:14px}
.err{color:var(--red);background:rgba(232,90,113,0.08);padding:12px;border:1px solid var(--red);margin-top:14px;font-size:12px}
details{margin-top:14px;background:var(--panel);border:1px solid var(--border);padding:14px}
details summary{cursor:pointer;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);font-weight:500;outline:none}
details[open] summary{color:var(--amber);margin-bottom:10px}
.footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:10px;letter-spacing:0.08em;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>KET</h1>
    <div class="tag">Kinezyolojik Denge İzi // backtest</div>
    <div class="sub">v1.0 — rtalb &amp; BIST için kantitatif test ortamı</div>
  </header>

  <div class="field">
    <label>Sembol</label>
    <input id="sym" value="RTALB.IS" autocomplete="off">
  </div>
  <div class="row">
    <div class="field">
      <label>Periyot</label>
      <select id="per">
        <option value="1y">1y</option>
        <option value="2y">2y</option>
        <option value="5y" selected>5y</option>
        <option value="10y">10y</option>
        <option value="max">max</option>
      </select>
    </div>
    <div class="field">
      <label>Aralık</label>
      <select id="intv">
        <option value="1d" selected>1d</option>
        <option value="1wk">1wk</option>
        <option value="1h">1h</option>
      </select>
    </div>
  </div>
  <div class="row3">
    <div class="field"><label>Hedef %</label><input id="tgt" type="number" value="20" step="1" min="1"></div>
    <div class="field"><label>Max bar</label><input id="hold" type="number" value="60" step="5" min="2"></div>
    <div class="field"><label>Min AQS</label><input id="aqs" type="number" value="0.4" step="0.05" min="0" max="1"></div>
  </div>

  <details>
    <summary>İleri parametreler</summary>
    <div class="row3">
      <div class="field"><label>lookback</label><input id="lb" type="number" value="20"></div>
      <div class="field"><label>k bars</label><input id="k" type="number" value="10"></div>
      <div class="field"><label>m bars</label><input id="m" type="number" value="4"></div>
    </div>
    <div class="row3">
      <div class="field"><label>V oran</label><input id="vr" type="number" value="0.6" step="0.05"></div>
      <div class="field"><label>N oran</label><input id="nr" type="number" value="0.6" step="0.05"></div>
      <div class="field"><label>R oran</label><input id="rr" type="number" value="0.5" step="0.05"></div>
    </div>
    <div class="row3">
      <div class="field"><label>DTS tetik</label><input id="dt" type="number" value="0.8" step="0.05"></div>
      <div class="field"><label>α</label><input id="al" type="number" value="1.5" step="0.1"></div>
      <div class="field"><label>β</label><input id="be" type="number" value="1.0" step="0.1"></div>
    </div>
  </details>

  <button id="go" onclick="runBT()">Backtest Çalıştır</button>

  <div id="out"></div>

  <div class="footer">// not investment advice — quantitative research only</div>
</div>

<script>
function $(id){return document.getElementById(id);}
function escapeHTML(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}

function buildPayload(){
  return {
    symbol: $('sym').value || 'RTALB.IS',
    period: $('per').value,
    interval: $('intv').value,
    target_gain: parseFloat($('tgt').value)/100,
    max_hold_bars: parseInt($('hold').value,10),
    min_aqs: parseFloat($('aqs').value),
    lookback: parseInt($('lb').value,10),
    k_bars: parseInt($('k').value,10),
    m_bars: parseInt($('m').value,10),
    v_ratio: parseFloat($('vr').value),
    n_ratio: parseFloat($('nr').value),
    range_ratio: parseFloat($('rr').value),
    dts_trigger: parseFloat($('dt').value),
    alpha: parseFloat($('al').value),
    beta: parseFloat($('be').value)
  };
}

function fmtPct(x){var s=x>=0?'+':'';return s+x.toFixed(1)+'%';}

function render(d){
  var html='';
  html+='<div class="summary"><h2>Özet // <span class="sym">'+escapeHTML(d.symbol)+'</span></h2>';
  html+='<div class="metric-row"><span class="k">tarih aralığı</span><span class="v">'+escapeHTML(d.date_range[0])+' → '+escapeHTML(d.date_range[1])+'</span></div>';
  html+='<div class="metric-row"><span class="k">analiz edilen bar</span><span class="v">'+d.bars_analyzed+'</span></div>';
  html+='<div class="metric-row"><span class="k">toplam AL sinyali</span><span class="v amber">'+d.total_buy_signals+'</span></div>';
  html+='<div class="metric-row"><span class="k">hedef vuran ('+d.target_gain_pct+'%)</span><span class="v mint">'+d.hits_at_target+'</span></div>';
  html+='<div class="metric-row"><span class="k">isabet oranı</span><span class="v amber">'+(d.hit_rate*100).toFixed(1)+'%</span></div>';
  html+='<div class="metric-row"><span class="k">ort. max kazanç</span><span class="v mint">'+fmtPct(d.avg_max_gain_pct)+'</span></div>';
  html+='<div class="metric-row"><span class="k">ort. max düşüş</span><span class="v red">'+fmtPct(d.avg_max_drawdown_pct)+'</span></div>';
  html+='<div class="metric-row"><span class="k">medyan bar/hedef</span><span class="v">'+d.median_bars_to_target+'</span></div>';
  html+='<div class="metric-row"><span class="k">toplam SAT sinyali</span><span class="v">'+d.total_sell_signals+'</span></div>';
  html+='<div class="metric-row"><span class="k">SAT isabet</span><span class="v">'+d.sell_hits+'</span></div>';
  html+='</div>';

  if(d.buy_signals && d.buy_signals.length){
    html+='<div class="sig-list"><h3>// Son AL sinyalleri</h3>';
    var arr=d.buy_signals.slice().reverse();
    var lim=Math.min(arr.length,20);
    for(var i=0;i<lim;i++){
      var s=arr[i];
      var cls=s.hit_target?'hit':'miss';
      var icon=s.hit_target?'+'+s.max_gain_pct.toFixed(1)+'%':s.max_gain_pct.toFixed(1)+'%';
      html+='<div class="sig '+cls+'">';
      html+='<div><div class="d">'+escapeHTML(s.date)+' @ '+s.entry_price.toFixed(2)+'</div>';
      html+='<div class="g">dd '+s.max_drawdown_pct.toFixed(1)+'% · bar→hedef '+s.bars_to_target+' · aqs '+s.aqs.toFixed(2)+'</div></div>';
      html+='<div class="badge '+cls+'">'+icon+'</div></div>';
    }
    html+='</div>';
  }
  return html;
}

function runBT(){
  var btn=$('go'); btn.disabled=true; btn.textContent='Çalışıyor…';
  var out=$('out'); out.innerHTML='<div class="status">veri çekiliyor + KET hesaplanıyor…</div>';
  var xhr=new XMLHttpRequest();
  xhr.open('POST','/backtest');
  xhr.setRequestHeader('Content-Type','application/json');
  xhr.onload=function(){
    btn.disabled=false; btn.textContent='Backtest Çalıştır';
    try{
      if(xhr.status===200){
        var d=JSON.parse(xhr.responseText);
        out.innerHTML=render(d);
      }else{
        var err=xhr.responseText;
        try{err=JSON.parse(xhr.responseText).detail || err;}catch(e){}
        out.innerHTML='<div class="err">// hata '+xhr.status+': '+escapeHTML(err)+'</div>';
      }
    }catch(e){
      out.innerHTML='<div class="err">// parse hatası: '+escapeHTML(e.message)+'</div>';
    }
  };
  xhr.onerror=function(){
    btn.disabled=false; btn.textContent='Backtest Çalıştır';
    out.innerHTML='<div class="err">// ağ hatası</div>';
  };
  xhr.send(JSON.stringify(buildPayload()));
}
</script>
</body>
</html>"""
