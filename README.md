# 모멘텀 분석기

GitHub Pages 로 동작하는 정적 버전. 서버가 없어서 잠들지 않고 바로 열립니다.

- `portfolio.json` — 종목 목록, 관심종목, 그룹, 그룹별 레시피
- `settings.json` — 지표 기간·가중치, 벤치마크, 랭킹 레시피
- `scripts/build_data.py` — 일봉 수집 → `site/data.json` (한국: Naver/pykrx 미조정 주가, 미국: yfinance 수정주가)
- `site/` — 화면. 지표·랭킹은 브라우저에서 계산 (`indicators.js` = 기존 `indicators.py` 이식)
- `.github/workflows/deploy.yml` — 평일 16:10 / 06:40 KST 자동 수집 + 배포, 위 JSON 이 바뀌어도 재배포

화면에서 종목·설정을 바꾸면 GitHub 토큰(설정 → GitHub 연결)으로 위 JSON 파일이 커밋되고, 자동으로 데이터가 다시 수집됩니다.
