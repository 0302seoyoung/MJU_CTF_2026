# Super MJSEC — The Rage Game 🐱

![C#](https://img.shields.io/badge/C%23-239120?style=for-the-badge&logo=c-sharp&logoColor=white)
![.NET](https://img.shields.io/badge/.NET_8-512BD4?style=for-the-badge&logo=dotnet&logoColor=white)
![ASP.NET Core](https://img.shields.io/badge/ASP.NET_Core-5C2D91?style=for-the-badge&logo=.net&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Phaser](https://img.shields.io/badge/Phaser.js-8B5CF6?style=for-the-badge&logo=phaser&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

🌐 **실시간 배포**: http://3.14.230.237:31337

> **"클리어가 목표가 아니라, 좌절이 목표인 게임."**
>
> 시보냥 액션(고양이 마리오) 계열의 빡침 플랫포머. 9000px 횡스크롤 맵에
> 의도적으로 불합리한 트랩을 배치해 플레이어가 "이건 정상적으로 클리어할 수 있는 게임이 아니다"를
> 깨닫고 다른 길을 찾도록 유도하는 메타게임.

![thumbnail](challenge/wwwroot/assets/thumbnail.png)

---

## 🎮 게임 디자인 철학

### "Rage Game" 장르의 재해석

전통적인 플랫포머는 **공정한 도전**을 통해 플레이어에게 만족감을 줍니다.
반면 *Cat Mario / Syobon Action* 계열의 빡침 게임은 **불공정한 함정**으로 좌절을 유발하지만,
그 좌절 자체가 SNS 공유와 입소문의 동력이 되는 독특한 장르입니다.

본 프로젝트는 이 장르의 메커닉을 **9가지 트랩 시스템**으로 분해하고 재구성했습니다.

### 트랩 시스템 9종

| 트랩 | 메커닉 | 심리적 효과 |
|---|---|---|
| 🚶 일반 굼바 | 좌우 패트롤 (속도 70, 범위 ±100) | 예측 가능 → 기본 학습 |
| 🐢 거북이 (Koopa) | 더 천천히, 더 넓게 (속도 50, 범위 ±200) | "굼바인 줄 알았는데" 혼란 |
| 🔴 미친 굼바 | 빨강 + 4배속(280px/s) + 화면 전체 횡단 | 시각적 충격 |
| 🚀 Bullet Bill 대포 | 3초 주기 자동 발사, 좌우 양방향 | 타이밍 강제 |
| ☄️ 운석 | 점프 시 위에서 떨어짐 | "안전한 점프는 없다" |
| ❓ ?블록 함정 | 점프 → 아이템 등장 → 닿으면 사망 | 마리오 관습 배신 |
| 🕳️ 사라지는 바닥 | 평범한 바닥처럼 보이나 밟으면 추락 | 신뢰 무너뜨림 |
| 👻 보이지 않는 가시 | 첫 사망 후 시각화 (학습 강요) | "거기 있었구나" 학습 |
| 🚩 가짜 깃발 | 빨간 깃발 = 사망 / 초록 깃발 = 클리어 | 시각 코드 비틀기 |

### 학습 곡선 디자인

```
사망 1회  → 굼바 위치 학습
사망 2회  → "보이지 않던 가시"가 드러남
사망 3회  → ?블록은 함정임을 깨달음
사망 5회  → "이거 정상 풀이가 아닐지도?"
사망 10회 → API 호출 흐름 의심 시작
```

각 사망은 정보를 주고, 정보는 다음 시도를 더 분석적으로 만듭니다.
"좌절 → 호기심 → 메타 사고" 의 의도된 흐름.

---

## 🛠 기술 구현 디테일

### Phaser.js 기반 게임 엔진

#### 물리 튜닝
```javascript
gravity: 900           // 마리오류 자연스러운 낙하
jumpVelocity: -410     // 점프 최대 93px → 발판 닿음 빠듯
playerSpeed: 260       // 빠르지만 정밀 조작 가능한 속도
```

물리값은 수십 번의 playtest를 거쳐 결정:
- 너무 높은 점프 = 트랩 무력화
- 너무 짧은 점프 = 좌절 (스킬과 무관)
- 약간 빠듯한 점프 = "조금만 더" 심리

#### 굼바 AI 패트롤 시스템
```javascript
goombas.children.iterate((g) => {
    const origin = g.getData("origin");
    const range = g.getData("range");
    const speed = g.getData("speed") || 70;

    // 안전장치: 막힘 감지 시 자동 재출발
    if (Math.abs(g.body.velocity.x) < 5) {
        const dir = (g.x > origin) ? -1 : 1;
        g.body.velocity.x = speed * dir;
    }
    // 범위 끝 도달 시 반대로
    if (g.x < origin - range && g.body.velocity.x < 0) {
        g.body.velocity.x = speed; g.setFlipX(true);
    } else if (g.x > origin + range && g.body.velocity.x > 0) {
        g.body.velocity.x = -speed; g.setFlipX(false);
    }
});
```

데이터 기반 AI라 트랩 종류별 (굼바/거북이/미친굼바)로
**같은 코드 + 다른 데이터** → 빠른 밸런싱 가능.

#### 동적 카메라 zoom
```javascript
const zoom = window.innerHeight / WORLD_H;
this.cameras.main.setZoom(zoom);
```

뷰포트 크기에 맞춰 자동 zoom → 풀스크린/창모드/모바일 다 대응.

#### 페이드 애니메이션 (사라지는 바닥)
```javascript
scene.tweens.add({
    targets: tile, alpha: 0, duration: 200,
    onComplete: () => { tile.body.enable = false; }
});
```

물리적 충돌과 시각 페이드를 분리해 부드러운 표현.

### 캐릭터 상태 머신 (Animation FSM)

```javascript
if (!onGround)       → 'cat_jump' 텍스처
else if (moving)     → 'cat_walk_a' / 'cat_walk_b' (120ms 토글)
else                 → 'cat_idle'

// 사망 시
player.body.setAllowGravity(false);
player.body.moves = false;
player.setTexture('cat_hit');
```

상태 전환은 매 프레임 평가, 텍스처 swap만으로 가벼운 애니메이션.

### 시각적 디테일

- **Parallax 구름** (`scrollFactor: 0.7`) — 깊이감
- **타일링 배경** (TileSprite 자동 반복) — 9400px 맵 메모리 효율
- **Pixelated 렌더링** (`image-rendering: pixelated`) — NES 시대 텍스처 손상 없이 확대
- **NES 풍 UI** — Press Start 2P 폰트, 굵은 검은 테두리, 그림자 효과

---

## 🧩 풀스택 아키텍처

### 백엔드 (ASP.NET Core 8 Minimal API)

```
GET  /                  → 게임 클라이언트 정적 파일
POST /api/start         → 세션 시작, 닉네임 등록
POST /api/rename        → 게임 중 닉네임 변경 (게이트 미초기화)
GET  /api/state         → 진행 상황 조회 (deaths, play_time, traps 등)
POST /api/sign          → 이동 좌표 HMAC 서명 발급
POST /api/move          → 좌표 업데이트 (HMAC 검증) → 골 도달 시 플래그
POST /api/death         → 사망 기록 (트랩 종류/위치 검증)
GET  /api/death-screen  → 사망 화면 렌더링 (권한 + 게이트 검증)
```

### 세션 게이트 시스템

플레이어가 정당한 플레이를 했는지 검증하는 6개 게이트:

| 게이트 | 조건 | 의도 |
|---|---|---|
| `play_time` | 30초 이상 | 즉시 풀이 방지 |
| `deaths` | 3회 이상 | 실제 게임 진행 증명 |
| `trap_variety` | 2종 이상 트랩 사망 | 다양한 경험 강제 |
| `move_count` | 20회 이상 이동 | 능동적 조작 증명 |
| `y_variance` | 50px 이상 y 변화 | 점프 흔적 |
| `move_intervals` | 평균/표준편차 분석 | 봇 탐지 |

### 안티치트 디테일

```
사망 검증 (per-death):
  ✓ trap_type 화이트리스트
  ✓ 사망 간 최소 2회 이동
  ✓ 트랩 근접 이력 (최근 1.5초 내 80px)

이동 검증 (per-move):
  ✓ HMAC-SHA256 서명
  ✓ 거리 제한 (Δx ≤ 120, Δy ≤ 500)
  ✓ 골 좌표 근접 시 서명 발급 거부 (forge 강제)
```

### 프론트엔드 UX 디테일

- **죽음 화면 진행도** — ✓/✗ 색상 코딩으로 한눈에 게이트 상태 확인
- **F5 후 재개** — 의도적으로 게이트 리셋 (반복 도전 유도)
- **닉네임 라이브 변경** — 게임 중 입력 패널로 즉시 갱신
- **반응형 게임 영역** — 창 크기 변경에 카메라 zoom 자동 대응

---

## 🎯 메타게임: 보안 챌린지 레이어

표면은 빡침 플랫포머지만, 본질은 **CTF(Capture The Flag) 웹 해킹 챌린지**.

```
피지컬 풀이  → 1~2시간 좌절, 거의 불가능
의도 풀이    → 30분, 4단계 익스플로잇 체이닝
              ① 쿠키 변조 (admin 권한 획득)
              ② 게임 게이트 통과 (실제 플레이 강제)
              ③ SSTI(Scriban) — 닉네임에 템플릿 인젝션
              ④ HMAC 위조 — 추출한 SECRET으로 골 좌표 서명
```

**왜 이렇게 디자인했나?**

LLM(ChatGPT/Codex)이 코드만 보고 1분 만에 풀어버리는 시대.
"게임을 실제로 플레이해야만 풀 수 있는 CTF"를 만들어 인간 풀이자의 가치를 살림.

게임 디자인 = 안티봇 디자인 = 안티치트 디자인. 셋이 같은 메커니즘으로 통합.

---

## 🚀 실행 방법

### 로컬 (.NET 8 SDK)
```bash
cd challenge
dotnet restore
dotnet run
# → http://localhost:5000
```

### Docker
```bash
cd challenge
docker compose up --build
# → http://localhost:8080
```

### 환경 변수
| 변수 | 설명 |
|---|---|
| `CTF_SECRET` | HMAC 서명 키 (운영 시 강한 랜덤으로 교체) |
| `FLAG` | 발급할 플래그 |

---

## 📁 폴더 구조

```
.
├── README.md
├── challenge/
│   ├── Program.cs                     # 백엔드: API, 세션, 게이트, SSTI
│   ├── CatMarioWebCTF.csproj
│   ├── Dockerfile / docker-compose.yml
│   ├── flag.txt
│   └── wwwroot/
│       ├── index.html                 # 시작 화면 + HUD + 죽음 오버레이
│       ├── game.js                    # Phaser 게임 로직 (트랩/AI/물리)
│       ├── style.css                  # NES 풍 UI
│       └── assets/                    # 스프라이트, 배경, 효과음
└── docs/
    └── ctf_challenge_design.md        # 설계 문서 (의사결정 기록)
```

---

## 🎨 사용 에셋

- 캐릭터/타일 스프라이트: 고전 플랫폼 게임 팬아트 (학습/포트폴리오 목적)
- 폰트: Google Fonts (Press Start 2P, OFL 라이선스)
- UI/효과 일부 자체 제작

> 본 프로젝트는 비영리 학습/포트폴리오 목적입니다. 모든 캐릭터 IP는 원 저작권자에게 있습니다.

---

## 💡 만들면서 배운 것

### 게임 디자인
- "재미"와 "좌절"의 균형 — 좌절도 동기가 될 수 있음
- 학습 곡선 설계 — 사망마다 새 정보를 제공해 다음 시도가 의미 있도록
- AI 데이터 분리 — 같은 코드 + 다른 파라미터 = 빠른 밸런싱
- 시각/물리 분리 — 페이드/애니메이션은 시각 레이어, 충돌은 별도

### 풀스택 개발
- ASP.NET Core Minimal API의 빠른 프로토타이핑
- 세션 기반 상태 관리 + HMAC 서명으로 클라/서버 분리
- Docker로 일관된 배포 환경
- Cloudflare Tunnel로 노트북에서 외부 노출 (개발/데모 용이)

### 게임 보안
- 클라이언트 좌표를 절대 신뢰하지 않는다 — 항상 서버에서 검증
- 안티치트 ≈ 안티봇 ≈ 안티자동화 — 같은 패턴 검증
- 게임 디자인이 보안 디자인이 될 수 있다

---

## 👤 만든이

**[본인 이름]**
- GitHub: [@0302seoyoung](https://github.com/0302seoyoung)
- 포트폴리오: [링크]
- 이메일: [이메일]

게임 클라이언트 / 백엔드 / 라이브 운영 / 보안 모두 1인 개발.
관심 분야: 게임 메커닉 설계, 라이브 서비스 운영, 안티치트 시스템.
