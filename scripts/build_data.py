# -*- coding: utf-8 -*-
"""GitHub Actions 에서 실행: portfolio.json 의 종목 일봉(OHLCV)을 수집해 site/data.json 생성.

지표 계산은 브라우저(site/indicators.js)에서 하므로 여기서는 원시 가격만 모은다.
- 한국(6자리, 숫자로 시작): Naver 차트 API → 실패 시 pykrx  (미조정 주가)
- 미국(영문):               yfinance auto_adjust=True         (수정 주가)
수집에 실패한 종목은 직전 배포본(data.json)의 데이터를 그대로 유지한다.
"""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT         = Path(__file__).resolve().parent.parent
SITE         = ROOT / 'site'
TRADING_DAYS = 800          # 약 3년 2개월 — 설정 최대 기간(36개월)까지 계산 가능
UA           = {'User-Agent': 'Mozilla/5.0'}
KST          = timezone(timedelta(hours=9))


def is_korean(ticker: str) -> bool:
    return len(ticker) == 6 and ticker.isalnum() and ticker[0].isdigit()


# ── 한국 ──────────────────────────────────────────────────────────────────────

def fetch_kr_naver(ticker: str):
    url = ('https://fchart.stock.naver.com/sise.nhn'
           f'?symbol={ticker}&timeframe=day&count={TRADING_DAYS}&requestType=0')
    r = requests.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    text = r.content.decode('euc-kr', errors='replace')
    m    = re.search(r'<chartdata[^>]*\bname="([^"]*)"', text)
    name = html.unescape(m.group(1)).strip() if m else None   # &amp; → & 등 XML 엔티티 복원
    recs = []
    for row in re.findall(r'<item data="([^"]+)"', text):
        p = row.split('|')
        if len(p) < 6:
            continue
        try:
            d = datetime.strptime(p[0], '%Y%m%d')
            o, h, l, c, v = (float(x) for x in p[1:6])
        except ValueError:
            continue
        if c > 0:
            recs.append((d, o, h, l, c, v))
    if not recs:
        raise ValueError('Naver 데이터 없음')
    df = pd.DataFrame(recs, columns=['Date', 'Open', 'High', 'Low', 'Close', 'Volume'])
    return df.set_index('Date'), name


def fetch_kr_pykrx(ticker: str):
    from pykrx import stock as krx
    end   = datetime.now()
    start = end - timedelta(days=int(TRADING_DAYS * 1.6) + 30)
    df = krx.get_market_ohlcv(start.strftime('%Y%m%d'), end.strftime('%Y%m%d'), ticker)
    if df is None or df.empty:
        raise ValueError('pykrx 데이터 없음')
    df = df.rename(columns={'시가': 'Open', '고가': 'High', '저가': 'Low',
                            '종가': 'Close', '거래량': 'Volume'})
    name = None
    try:
        n = krx.get_market_ticker_name(ticker)
        if isinstance(n, str) and n.strip() and n.strip() != ticker:
            name = n.strip()
    except Exception:
        pass
    return df[['Open', 'High', 'Low', 'Close', 'Volume']], name


def fetch_kr(ticker: str):
    try:
        return fetch_kr_naver(ticker)
    except Exception as e:
        print(f'  Naver 실패 {ticker}: {e} → pykrx 시도')
    return fetch_kr_pykrx(ticker)


# ── 미국 ──────────────────────────────────────────────────────────────────────

def fetch_us_batch(tickers: list) -> dict:
    if not tickers:
        return {}
    start = (datetime.now() - timedelta(days=int(TRADING_DAYS * 1.6) + 30)).strftime('%Y-%m-%d')
    end   = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')
    raw = yf.download(tickers, start=start, end=end, progress=False,
                      auto_adjust=True, group_by='ticker', threads=False)
    out = {}
    for t in tickers:
        try:
            df = raw[t].copy() if isinstance(raw.columns, pd.MultiIndex) else raw.copy()
            df = df[['Open', 'High', 'Low', 'Close', 'Volume']].dropna(subset=['Close'])
            df = df[df['Close'] > 0]
            if not df.empty:
                out[t] = df
        except Exception as e:
            print(f'  yfinance 실패 {t}: {e}')
    return out


def fetch_us_name(ticker: str):
    try:
        r = requests.get('https://query2.finance.yahoo.com/v1/finance/search',
                         params={'q': ticker, 'quotesCount': 1, 'newsCount': 0},
                         headers=UA, timeout=10)
        if r.ok:
            q = r.json().get('quotes', [])
            if q and q[0].get('symbol', '').upper() == ticker.upper():
                n = (q[0].get('shortname') or q[0].get('longname') or '').strip()
                if n and n != ticker:
                    return n
    except Exception:
        pass
    return None


# ── 직렬화 ────────────────────────────────────────────────────────────────────

def to_record(df: pd.DataFrame, name: str, kr: bool) -> dict:
    df = df.tail(TRADING_DAYS)
    rnd = (lambda x: round(float(x))) if kr else (lambda x: round(float(x), 4))
    return {
        'name': name,
        'kr':   kr,
        'd':    [d.strftime('%Y-%m-%d') for d in df.index],
        'o':    [rnd(x) for x in df['Open']],
        'h':    [rnd(x) for x in df['High']],
        'l':    [rnd(x) for x in df['Low']],
        'c':    [rnd(x) for x in df['Close']],
        'v':    [int(x) if pd.notna(x) else 0 for x in df['Volume']],
    }


def load_previous() -> dict:
    """직전 배포본 — 이번에 수집 실패한 종목의 대체 데이터 / 종목명 캐시."""
    url = os.environ.get('PAGES_URL', '').rstrip('/')
    if not url:
        return {}
    try:
        r = requests.get(f'{url}/data.json', timeout=20)
        if r.ok:
            return r.json().get('tickers', {})
    except Exception:
        pass
    return {}


def main():
    portfolio = json.loads((ROOT / 'portfolio.json').read_text(encoding='utf-8'))
    settings  = json.loads((ROOT / 'settings.json').read_text(encoding='utf-8'))
    rsm       = settings.get('RSM', {})

    tickers = list(dict.fromkeys(
        [t.strip().upper() for t in portfolio.get('all_tickers', []) if t.strip()]
        + [rsm.get('benchmark_kr', '069500'), rsm.get('benchmark_us', 'SPY'), '069500', 'SPY']
    ))
    prev   = load_previous()
    result = {}
    errors = {}

    kr_list = [t for t in tickers if is_korean(t)]
    us_list = [t for t in tickers if not is_korean(t)]

    for t in kr_list:
        try:
            df, name = fetch_kr(t)
            name = name or prev.get(t, {}).get('name') or t
            result[t] = to_record(df, name, True)
            print(f'OK  {t} {name} ({len(df)}일)')
        except Exception as e:
            errors[t] = str(e)[:200]
            print(f'ERR {t}: {e}')

    us_data = {}
    try:
        us_data = fetch_us_batch(us_list)
    except Exception as e:
        print(f'yfinance 일괄 다운로드 실패: {e}')
    for t in us_list:
        if t not in us_data:
            errors[t] = '데이터 없음'
            print(f'ERR {t}: 데이터 없음')
            continue
        name = prev.get(t, {}).get('name')
        if not name or name == t:
            name = fetch_us_name(t) or t
        result[t] = to_record(us_data[t], name, False)
        print(f'OK  {t} {name} ({len(us_data[t])}일)')

    # 수집 실패 종목은 직전 데이터 유지
    stale = []
    for t in errors:
        if t in prev:
            result[t] = prev[t]
            stale.append(t)

    out = {
        'generated_at': datetime.now(KST).strftime('%Y-%m-%d %H:%M'),
        'tickers':      result,
        'errors':       {t: e for t, e in errors.items() if t not in stale},
        'stale':        stale,
    }
    SITE.mkdir(exist_ok=True)
    (SITE / 'data.json').write_text(
        json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'\n완료: {len(result)}개 종목, 실패 {len(errors)}개 (직전 데이터 유지 {len(stale)}개)')
    if not result:
        sys.exit(1)


if __name__ == '__main__':
    main()
