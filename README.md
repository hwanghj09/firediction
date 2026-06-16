# Firediction


[ 접속링크 ]
https://hwanghj09.github.io/firediction/

산림청 산불 발생 이력, 가뭄 shapefile, 기상청 API 데이터를 이용해 시군구별 산불 위험도를 예측하고 지도에 표시하는 정적 웹사이트입니다.

## 실행

```bash
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000`으로 접속합니다.

## 데이터 다시 만들기

```bash
python3 scripts/build_data.py
```

생성 파일:

- `data/risk-data.json`
- `data/risk-data.js`

전처리 스크립트는 Python 표준 라이브러리만 사용합니다. 산불 CSV는 CP949로 읽고, 가뭄 shapefile은 zip 안의 SHP/DBF를 직접 파싱합니다. `api.md`에 있는 기상청 API 6개도 호출합니다.

## 모델

`scripts/build_data.py` 안에 1개 은닉층을 가진 작은 신경망을 직접 구현했습니다. 특징값은 월별 계절성, 시군구/시도별 산불 빈도, 피해면적, 가뭄 단계, 기상청 API 기상값, 지도상 위치입니다.

사용 API:

- 기온 월자료 `sts_ta.php`
- 지면온도 월자료 `sts_ts.php`
- 초상온도 월자료 `sts_tg.php`
- 지중온도 월자료 `sts_te.php`
- 습도 월자료 `sts_rhm.php`
- 강수량 월자료 `sts_rn.php`

교육용 예측이므로 실제 재난 판단에는 공식 산림청/기상청 정보를 함께 확인해야 합니다.
