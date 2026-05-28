// Neko Mario - rage platformer
// 서버와 좌표를 동기화하기 위해 매 이동마다 /api/sign 으로 서명을 받음.

const WORLD_W = 9400;
const WORLD_H = 600;
const GOAL_X = 9000;

let gameState = { name: "user", deaths: 0, cleared: false };

// HTML 이스케이프 (death overlay 안에 닉네임 등 안전하게 표시)
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let serverPos = { x: 50, y: 500 };
let lastSyncTime = 0;
let sendMovePending = false;     // race condition 방지 (병렬 호출 막음)
let dead = false;
let activeMeteors = new Set();

// ============== UI ==============
const startScreen = document.getElementById("startScreen");
const startBtn = document.getElementById("startBtn");
const nameInput = document.getElementById("nameInput");
const deathOverlay = document.getElementById("deathOverlay");
const deathContent = document.getElementById("deathContent");
const respawnBtn = document.getElementById("respawnBtn");
const winOverlay = document.getElementById("winOverlay");
const flagBox = document.getElementById("flagBox");
const hudX = document.getElementById("hudX");
const hudDeaths = document.getElementById("hudDeaths");
const hudName = document.getElementById("hudName");

startBtn.onclick = async () => {
    const name = nameInput.value || "user";
    const r = await fetch("/api/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name}),
    });
    if (!r.ok) { alert("start failed"); return; }
    gameState.name = name;
    hudName.textContent = name.length > 30 ? name.slice(0, 30) + "..." : name;
    startScreen.classList.add("hidden");
    initPhaser();
};

respawnBtn.onclick = () => {
    deathOverlay.classList.add("hidden");
    respawn();
};

// 닉네임 즉시 변경 (게임 상태 유지)
const renameInput = document.getElementById("renameInput");
const renameBtn = document.getElementById("renameBtn");
async function doRename() {
    const newName = renameInput.value;
    if (!newName) return;
    const r = await fetch("/api/rename", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: newName}),
    });
    if (r.ok) {
        gameState.name = newName;
        hudName.textContent = newName.length > 30 ? newName.slice(0, 30) + "..." : newName;
        renameInput.value = "";
        renameInput.blur();          // ★ 포커스 해제 → WASD가 게임으로 다시 감
    }
}
renameBtn.onclick = doRename;
renameInput.addEventListener("keydown", (e) => {
    e.stopPropagation();             // ★ 게임 입력으로 새는 거 방지
    if (e.key === "Enter") doRename();
});

// ============== Trap layout (클라이언트 표시용; 서버에도 동일) ==============
const TRAP_LAYOUT = {
    fake_platform: [
        // 파이프 위치(1550, 3650, 6050) 근처는 제외
        [560, 515], [1160, 515], [2560, 515], [3260, 515], [3860, 515],
        [4860, 515], [5560, 515], [6460, 515], [7260, 515], [7860, 515],
    ],
    spike_ground: [
        // 8000 이후는 비워둠 (골 도달 전 안전 구간)
        [500, 545], [1100, 545], [1700, 545], [2500, 545], [3200, 545], [3800, 545],
        [4800, 545], [5500, 545], [6400, 545], [7200, 545], [7800, 545],
    ],
    spike_ceiling: [
        [1500, 390], [2900, 390], [4400, 390], [5800, 390], [6800, 390],
    ],
    spike_invisible: [
        [800, 545], [2100, 545], [3500, 545], [5000, 545], [6800, 545],
    ],
    meteor: [
        [1200, 540], [1800, 540], [2400, 540], [2800, 540], [3500, 540], [4200, 540],
        [5000, 540], [5800, 540], [6300, 540], [6800, 540], [7400, 540], [8000, 540],
    ],
    mystery_block: [
        [400, 440], [1300, 440], [2200, 440], [3100, 440], [4000, 440],
        [4900, 440], [5800, 440], [6700, 440], [7300, 440], [7600, 440], [7900, 440],
    ],
    koopa: [
        [1400, 540], [3500, 540], [5500, 540], [7400, 540], [7700, 540],
    ],
    // [x, y, range] — range 생략 시 3500
    crazy_goomba: [[1000, 540], [4000, 540]],
    // 사라지는 바닥 — 일반 바닥처럼 보이지만 밟으면 사라져서 추락
    disappearing_floor: [
        [2450, 580], [4550, 580], [6300, 580],
    ],
    // 대포 — 주기적으로 포탄 발사
    cannon: [
        // mystery_block(400/1300/2200/3100/4000/4900/5800/6700/7600)와 겹치지 않게 배치
        [1800, 540], [4500, 540], [7000, 540],
    ],
    false_goal: [],   // 제거 — 진짜 골 도달 방해 X
};

// ============== Phaser 설정 ==============
function initPhaser() {
    const config = {
        type: Phaser.AUTO,
        width: window.innerWidth,
        height: window.innerHeight,
        parent: "game",
        pixelArt: true,           // 픽셀아트 nearest-neighbor 보간
        backgroundColor: 0x6b8cff, // 마리오 하늘색
        physics: {
            default: "arcade",
            arcade: { gravity: { y: 900 }, debug: false },
        },
        scene: { preload, create, update },
    };
    new Phaser.Game(config);
}

let cursors, wasd, spaceKey;
let player, platforms, fakePlats, spikes, falseGoal, realGoal, meteorGroup;
let goombas, qBlocks;
let disappearingFloor, cannons, cannonBalls;
let goalFlag, goalPole;
let scene;

function preload() {
    const M = "/assets/mario/";
    // 플레이어 (마리오)
    this.load.image('cat_idle',   M + 'Mario_Small_Idle.png');
    this.load.image('cat_walk_a', M + 'Mario_Small_Run1.png');
    this.load.image('cat_walk_b', M + 'Mario_Small_Run2.png');
    this.load.image('cat_jump',   M + 'Mario_Small_Jump.png');
    this.load.image('cat_hit',    M + 'Mario_Small_Death.png');
    // 블록
    this.load.image('terrain',    M + 'GroundBlock.png');
    this.load.image('block_safe', M + 'Brick.png');
    this.load.image('block_fake', M + 'Brick.png');           // 안전과 동일 텍스처
    // 트랩
    this.load.image('spikes_img', M + 'Goomba_Walk1.png');    // 가시 대신 굼바
    this.load.image('bomb',       M + 'Koopa_Shell.png');     // 운석 → 쿠파 등껍질
    // 골
    this.load.image('flag_real',  M + 'Flag.png');
    this.load.image('flag_pole',  M + 'FlagPole.png');
    this.load.image('castle',     M + 'Castle.png');
    this.load.image('flag_fake',  M + 'PipeTop.png');          // 가짜 골은 파이프
    this.load.image('pipe_bottom', M + 'PipeBottom.png');
    // 배경
    this.load.image('mystery',    M + 'MysteryBlock.png');
    this.load.image('empty_block', M + 'EmptyBlock.png');
    this.load.image('mushroom',   M + 'MagicMushroom.png');
    this.load.image('one_up',     M + '1upMushroom.png');
    this.load.image('starman',    M + 'Starman.png');
    this.load.image('koopa',      M + 'Koopa_Walk1.png');
    this.load.image('koopa_b',    M + 'Koopa_Walk2.png');
    this.load.image('pipe_top',   M + 'PipeTop.png');
    this.load.image('bullet',     M + 'BulletBill.png');
    this.load.audio('bgm', '/assets/audio/bgm.mp3');
    this.load.audio('clear', '/assets/audio/clear.mp3');
    this.load.image('hill1',      M + 'Hill1.png');
    this.load.image('hill2',      M + 'Hill2.png');
    this.load.image('cloud1',     M + 'Cloud1.png');
    this.load.image('cloud2',     M + 'Cloud2.png');
    this.load.image('cloud3',     M + 'Cloud3.png');
    this.load.image('bush1',      M + 'Bush1.png');
    this.load.image('bush2',      M + 'Bush2.png');
}

function create() {
    scene = this;
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // 카메라 zoom 동적 — viewport 높이에 WORLD_H 가득 차게 (검정 빈공간 없앰)
    const zoom = window.innerHeight / WORLD_H;
    this.cameras.main.setZoom(zoom);

    // 배경: 하늘 backgroundColor, 산은 floor 위에 놓이게 y=580 (floor top과 동일)
    for (let x = 100; x < WORLD_W; x += 700) {
        this.add.image(x, 595, 'hill1').setOrigin(0.5, 1).setScale(3);
    }
    for (let x = 400; x < WORLD_W; x += 700) {
        this.add.image(x, 595, 'hill2').setOrigin(0.5, 1).setScale(2.5);
    }
    // 구름은 위쪽에 (parallax 살짝)
    const clouds = ['cloud1', 'cloud2', 'cloud3'];
    for (let x = 50; x < WORLD_W; x += 380) {
        const c = clouds[((x / 380) | 0) % 3];
        this.add.image(x, 80 + ((x * 7) % 60), c).setScale(2).setScrollFactor(0.7);
    }
    // 덤불도 floor top에 정확히
    for (let x = 200; x < WORLD_W; x += 280) {
        const b = (x % 2 === 0) ? 'bush1' : 'bush2';
        this.add.image(x, 562, b).setOrigin(0.5, 1).setScale(2);
    }

    // 바닥 — 구멍 위치에는 일반 floor를 깔지 않음 (사라지는 floor가 따로 차지)
    platforms = this.physics.add.staticGroup();
    const HOLE_W = 100;
    const holeXs = TRAP_LAYOUT.disappearing_floor.map(p => p[0]).sort((a, b) => a - b);
    let lastEnd = 0;
    const segments = [];
    for (const hx of holeXs) {
        segments.push([lastEnd, hx - HOLE_W / 2]);
        lastEnd = hx + HOLE_W / 2;
    }
    segments.push([lastEnd, WORLD_W]);
    for (const [start, end] of segments) {
        const w = end - start;
        if (w <= 0) continue;
        const seg = this.add.tileSprite(start + w / 2, 580, w, 40, 'terrain');
        this.physics.add.existing(seg, true);
        platforms.add(seg);
    }

    // 마리오 파이프 (1세그, 점프해서 넘어야 함) — staticGroup.create로 staticSprite 생성
    const PIPE_XS = [1550, 3650, 6050];
    for (const px of PIPE_XS) {
        const bot = platforms.create(px, 560, 'pipe_bottom').setOrigin(0.5, 1).setScale(2).refreshBody();
        const top = platforms.create(px, 560 - bot.displayHeight, 'pipe_top').setOrigin(0.5, 1).setScale(2).refreshBody();
    }

    // 캐슬 (장식, 충돌 없음)
    this.add.image(8950, 560, 'castle').setOrigin(0.5, 1).setScale(4);

    // 사라지는 바닥 — 일반 floor와 똑같은 텍스처라 시각 구분 X
    disappearingFloor = this.physics.add.staticGroup();
    for (const [x, y] of TRAP_LAYOUT.disappearing_floor) {
        const tile = this.add.tileSprite(x, y, HOLE_W, 40, 'terrain');
        tile.setData("trapType", "disappearing_floor");
        tile.setData("trapX", x);
        tile.setData("trapY", y);
        this.physics.add.existing(tile, true);
        disappearingFloor.add(tile);
    }

    // 정상 발판 (planks 텍스처). 점프해서 닿기 좋은 높이로 배치.
    const safePlatforms = [
        [400, 510, 80], [800, 510, 60], [1100, 500, 80],
        [1400, 510, 60], [1900, 510, 100], [2300, 500, 60],
        [2700, 510, 80], [3000, 500, 80], [3400, 510, 100],
        [3800, 500, 80], [4200, 510, 80], [4600, 510, 80],
        [5000, 500, 80], [5300, 510, 80], [5700, 500, 80],
        [6100, 510, 80], [6600, 500, 80], [7000, 510, 80],
        [7400, 500, 80], [7700, 510, 80],
        // 8000 이후 발판 제거 — 골 영역 청정 구간
    ];
    for (const [x, y, w] of safePlatforms) {
        const r = this.add.tileSprite(x, y, w, 24, 'block_safe');
        this.physics.add.existing(r, true);
        r.body.setSize(w, 16);
        platforms.add(r);
    }

    // 가짜 발판 (안전 발판과 동일한 텍스처 — 시각 구분 불가능, 빡침 강화)
    fakePlats = this.physics.add.staticGroup();
    for (const [x, y] of TRAP_LAYOUT.fake_platform) {
        const r = this.add.tileSprite(x, y, 80, 24, 'block_safe');
        r.setData("trapType", "fake_platform");
        r.setData("trapX", x);
        r.setData("trapY", y);
        this.physics.add.existing(r, true);
        r.body.setSize(80, 16);
        fakePlats.add(r);
    }

    // 가시 (Goomba) — 천장/숨은 = static, 바닥 = dynamic (좌우 patrol)
    spikes = this.physics.add.staticGroup();
    goombas = this.physics.add.group();
    // 바닥 굼바 — 좌우로 움직임 (속도 70). group.create() 사용
    for (const [x, y] of TRAP_LAYOUT.spike_ground) {
        const s = goombas.create(x, 530, 'spikes_img');
        s.setDisplaySize(36, 36);
        s.body.setSize(14, 14).setOffset(1, 1);
        s.setData("trapType", "spike");
        s.setData("trapX", x);
        s.setData("trapY", y);
        s.setData("origin", x);
        s.setData("range", 100);
        s.setData("speed", 70);
        s.body.velocity.x = -70;
    }
    // 거북이 (Koopa) — 천천히 더 넓은 범위 patrol (속도 50, range 200)
    for (const [x, y] of TRAP_LAYOUT.koopa) {
        const k = goombas.create(x, 520, 'koopa');
        k.setDisplaySize(36, 52);
        k.body.setSize(14, 22).setOffset(1, 1);
        k.setData("trapType", "koopa");         // 굼바와 다른 종류
        k.setData("trapX", x);
        k.setData("trapY", y);
        k.setData("origin", x);
        k.setData("range", 200);
        k.setData("speed", 50);
        k.setData("isKoopa", true);
        k.body.velocity.x = -50;
    }
    // 미친/화난 굼바 — 빨강 + 중간 사이즈, range는 per-instance 지원 ([x, y, range])
    for (const entry of TRAP_LAYOUT.crazy_goomba) {
        const x = entry[0], y = entry[1];
        const range = entry.length >= 3 ? entry[2] : 3500;
        const c = goombas.create(x, 530, 'spikes_img');
        c.setDisplaySize(44, 44);
        c.body.setSize(14, 14).setOffset(1, 1);
        c.setTint(0xff3344);
        c.setData("trapType", "spike");
        c.setData("trapX", x);
        c.setData("trapY", y);
        c.setData("origin", x);
        c.setData("range", range);
        c.setData("speed", 280);
        c.body.velocity.x = -280;
    }
    // 천장 굼바 (거꾸로 매달림)
    for (const [x, y] of TRAP_LAYOUT.spike_ceiling) {
        const s = this.add.image(x, y, 'spikes_img').setDisplaySize(40, 40).setFlipY(true);
        s.setData("trapType", "spike");
        s.setData("trapX", x);
        s.setData("trapY", y);
        this.physics.add.existing(s, true);
        s.body.setSize(14, 14).setOffset(1, 1);
        spikes.add(s);
    }
    // 숨은 굼바 (보이지 않음, floor 위)
    for (const [x, y] of TRAP_LAYOUT.spike_invisible) {
        const s = this.add.image(x, 542, 'spikes_img').setDisplaySize(36, 36);
        s.setVisible(false);
        s.setData("trapType", "spike");
        s.setData("trapX", x);
        s.setData("trapY", y);
        this.physics.add.existing(s, true);
        s.body.setSize(14, 14).setOffset(1, 1);
        spikes.add(s);
    }

    // 가짜 골 (마리오 녹색 파이프 — 들어가고 싶게 생김, 닿으면 죽음)
    falseGoal = this.physics.add.staticGroup();
    for (const [x, y] of TRAP_LAYOUT.false_goal) {
        this.add.image(x, 560, 'flag_fake').setOrigin(0.5, 1).setScale(3);  // PipeTop
        this.add.tileSprite(x, 528, 96, 32, 'pipe_bottom').setOrigin(0.5, 0); // PipeBottom (없으면 단색)
        const f = this.add.rectangle(x, 510, 96, 100, 0xff0000, 0);
        f.setData("trapType", "false_goal");
        f.setData("trapX", x);
        f.setData("trapY", y);
        this.physics.add.existing(f, true);
        falseGoal.add(f);
    }

    // 진짜 골 (마리오 깃대 + 깃발 + 성)
    this.add.image(GOAL_X + 200, 560, 'castle').setOrigin(0.5, 1).setScale(2.5);
    goalPole = this.add.tileSprite(GOAL_X, 320, 16, 240, 'flag_pole').setOrigin(0.5, 0);
    goalFlag = this.add.image(GOAL_X - 18, 330, 'flag_real').setOrigin(0, 0).setScale(2);
    const hitZone = this.add.rectangle(GOAL_X, 440, 60, 240, 0x33ff66, 0);
    this.physics.add.existing(hitZone, true);
    realGoal = hitZone;

    // ? 블록 — 점프해서 머리로 치면 위에서 운석 떨어짐 (함정)
    qBlocks = this.physics.add.staticGroup();
    for (const [x, y] of TRAP_LAYOUT.mystery_block) {
        const b = this.add.image(x, y, 'mystery').setDisplaySize(40, 40);
        b.setData("blockX", x);
        b.setData("blockY", y);
        b.setData("triggered", false);
        this.physics.add.existing(b, true);
        qBlocks.add(b);
    }

    // 대포 — 시각만 (물리 X) → 굼바/플레이어 통과 가능. 포탄만 죽임.
    for (const [x, y] of TRAP_LAYOUT.cannon) {
        // 본체 (검은 박스, 충돌 없음)
        this.add.rectangle(x, 540, 36, 56, 0x222222).setStrokeStyle(2, 0x000000);
        // 입구 (왼/오 양쪽)
        this.add.rectangle(x - 22, 525, 12, 12, 0x444444);
        this.add.rectangle(x + 22, 525, 12, 12, 0x444444);
    }
    cannonBalls = this.physics.add.group();

    // 대포 발사 타이머 (3초마다, 플레이어 800px 안일 때만)
    this.time.addEvent({
        delay: 3000,
        loop: true,
        callback: () => {
            if (dead || gameState.cleared) return;
            for (const [x, y] of TRAP_LAYOUT.cannon) {
                if (Math.abs(player.x - x) > 800) continue;
                const dir = player.x < x ? -1 : 1;
                // 좌/우 양쪽 입구에서 동시에 발사
                const ball = cannonBalls.create(x + (dir > 0 ? 22 : -22), 525, 'bullet');
                ball.setDisplaySize(48, 30);     // Bullet Bill 사이즈
                ball.setFlipX(dir > 0);          // 진행 방향 향함 (원본 이미지가 왼쪽 바라봄)
                ball.body.setAllowGravity(false);
                ball.body.setVelocityX(dir * 240);
                ball.setData("cannonX", x);
                scene.time.delayedCall(5000, () => { if (ball && ball.body) ball.destroy(); });
            }
        }
    });

    // 운석 그룹
    meteorGroup = this.physics.add.group();

    // 플레이어 (마리오). 원본 16x16 → displaySize 36x36.
    player = this.physics.add.sprite(50, 500, 'cat_idle');
    player.setDisplaySize(36, 36);
    // body는 원본 16x16 기준 — 그대로 두면 visual hitbox = 시각 전체 36x36
    player.body.setSize(16, 16);
    player.body.setOffset(0, 0);
    player.body.setCollideWorldBounds(true);

    // 디버그/외부 제어용 window 노출 (콘솔에서 player.x 등 접근 가능)
    window.player = player;
    window.serverPos = serverPos;

    // BGM 재생 (브라우저 자동재생 정책 우회: AudioContext 명시 unlock)
    const bgm = this.sound.add('bgm', { loop: true, volume: 0.3 });
    const clearBgm = this.sound.add('clear', { loop: false, volume: 0.3 });

    const tryPlayBgm = () => {
        try {
            // Phaser WebAudio context resume
            if (this.sound.context && this.sound.context.state === 'suspended') {
                this.sound.context.resume();
            }
            if (!bgm.isPlaying) bgm.play();
        } catch (e) { console.warn('bgm play err:', e); }
    };
    tryPlayBgm();
    // 만약 첫 시도 실패 시, 다음 클릭/키 입력에 다시 시도
    const unlockListener = () => {
        tryPlayBgm();
        if (bgm.isPlaying) {
            window.removeEventListener('click', unlockListener);
            window.removeEventListener('keydown', unlockListener);
        }
    };
    window.addEventListener('click', unlockListener);
    window.addEventListener('keydown', unlockListener);

    window.bgm = bgm;
    window.clearBgm = clearBgm;

    // 음소거 토글
    const muteBtn = document.getElementById('muteBtn');
    let muted = false;
    if (muteBtn) {
        muteBtn.onclick = () => {
            muted = !muted;
            this.sound.mute = muted;
            muteBtn.textContent = muted ? '🔇' : '🔊';
        };
    }

    // 볼륨 슬라이더 — 모든 사운드 동시 조절
    const volSlider = document.getElementById('volumeSlider');
    if (volSlider) {
        volSlider.oninput = () => {
            const v = parseInt(volSlider.value) / 100;
            bgm.setVolume(v);
            clearBgm.setVolume(v);
        };
    }

    // 충돌
    this.physics.add.collider(player, platforms);

    // 가짜 발판: 닿자마자 즉시 사라짐 (잔인)
    this.physics.add.collider(player, fakePlats, (p, plat) => {
        scene.time.delayedCall(0, () => {
            plat.body.enable = false;
            plat.setVisible(false);
        });
    });

    // 가시 (static: 천장/숨은)
    this.physics.add.overlap(player, spikes, (p, s) => {
        triggerDeath("spike", s.getData("trapX"), s.getData("trapY"));
    });
    // 굼바 (dynamic patrol) — 닿으면 죽음. 굼바도 바닥/발판에 떨어짐.
    this.physics.add.collider(goombas, platforms);
    this.physics.add.collider(goombas, fakePlats);
    this.physics.add.overlap(player, goombas, (p, g) => {
        triggerDeath(g.getData("trapType") || "spike", g.getData("trapX"), g.getData("trapY"));
    });
    // ? 블록 — collider로 변경 (위에 올라설 수 있음). 머리로 받으면 함정 발동
    this.physics.add.collider(player, qBlocks, (p, b) => {
        if (p.body.touching.up && !b.getData("triggered")) {
            triggerMysteryTrap(b);
        }
    });

    // 사라지는 바닥 — 밟으면 200ms 페이드 후 disable
    this.physics.add.collider(player, disappearingFloor, (p, t) => {
        if (t.getData("vanishing")) return;
        t.setData("vanishing", true);
        scene.tweens.add({
            targets: t, alpha: 0, duration: 200,
            onComplete: () => { t.body.enable = false; t.setVisible(false); }
        });
    });

    // 포탄 — 맞으면 죽음 (대포 본체는 시각만이라 충돌 없음)
    this.physics.add.overlap(player, cannonBalls, (p, b) => {
        triggerDeath("cannon", b.getData("cannonX"), 540);
        b.destroy();
    });

    // 가짜 골
    this.physics.add.overlap(player, falseGoal, (p, g) => {
        triggerDeath("false_goal", g.getData("trapX"), g.getData("trapY"));
    });

    // 진짜 골 — 마리오 1-1 엔딩 시퀀스
    this.physics.add.overlap(player, realGoal, () => {
        if (gameState.cleared) return;
        gameState.cleared = true;
        startGoalSequence();
    });

    // 입력
    cursors = this.input.keyboard.createCursorKeys();
    wasd = this.input.keyboard.addKeys("W,A,S,D");
    spaceKey = this.input.keyboard.addKey("SPACE");

    // 카메라
    this.cameras.main.startFollow(player, true, 0.1, 0.1);

    // 운석 스케줄러: 어떤 키든 60% 확률로 근처 메테오 발동 (빡침 강화)
    this.input.keyboard.on("keydown", (e) => {
        if (Math.random() < 0.6) {
            scheduleMeteorIfNearby();
        }
    });
}

function triggerMysteryTrap(block) {
    block.setData("triggered", true);
    block.setTexture('empty_block');
    const bx = block.getData("blockX");
    const by = block.getData("blockY");

    const itemKeys = ['mushroom', 'one_up', 'starman'];
    const key = itemKeys[Math.floor(Math.random() * itemKeys.length)];

    // 아이템을 블록 위쪽에서 솟아남 (player가 블록 아래에서 점프했어도 안 닿음)
    const item = scene.physics.add.sprite(bx, by - 30, key);
    item.setDisplaySize(32, 32);
    item.body.setAllowGravity(false);
    item.body.setImmovable(false);

    scene.tweens.add({
        targets: item,
        y: by - 60,
        duration: 350,
        ease: 'Power2',
        onComplete: () => {
            // 솟은 후 옆으로 굴러가며 떨어짐
            item.body.setAllowGravity(true);
            const dir = (player.x < bx) ? -1 : 1;
            item.body.setVelocityX(110 * dir);
            item.body.setBounceX(1);
        }
    });

    scene.physics.add.collider(item, platforms);
    scene.physics.add.collider(item, fakePlats);

    // 0.5초 후에 overlap 등록 (player가 점프 마치고 다시 다가와야 죽음)
    scene.time.delayedCall(500, () => {
        if (!item || !item.body) return;
        scene.physics.add.overlap(player, item, () => {
            triggerDeath("meteor", bx, by);
        });
    });

    scene.time.delayedCall(8000, () => { if (item && item.body) item.destroy(); });
}

function scheduleMeteorIfNearby() {
    if (dead) return;
    for (const [mx, my] of TRAP_LAYOUT.meteor) {
        if (Math.abs(player.x - mx) < 200 && !activeMeteors.has(mx)) {
            activeMeteors.add(mx);
            const meteor = scene.physics.add.image(mx, 0, 'bomb');
            meteor.setDisplaySize(40, 40);
            meteor.body.setVelocityY(700);
            meteor.setRotation(Math.random() * Math.PI);
            meteorGroup.add(meteor);
            scene.physics.add.overlap(player, meteor, () => {
                triggerDeath("meteor", mx, my);
            });
            scene.time.delayedCall(3000, () => {
                meteor.destroy();
                activeMeteors.delete(mx);
            });
            break;
        }
    }
}

function update() {
    if (!player || dead || gameState.cleared) return;

    // 화면 밖으로 떨어지면 사망 (사라지는 바닥 트리거)
    if (player.y > 700) {
        triggerDeath("disappearing_floor", Math.round(player.x), 600);
        return;
    }

    const speed = 260;     // 이동 빠르게 → 정밀 조작 어려움
    const jumpV = -410;    // 점프 약화 → 발판 닿기 빠듯
    const onGround = player.body.blocked.down || player.body.touching.down;

    let moving = false;
    if (cursors.left.isDown || wasd.A.isDown) {
        player.body.setVelocityX(-speed);
        player.setFlipX(true);
        moving = true;
    } else if (cursors.right.isDown || wasd.D.isDown) {
        player.body.setVelocityX(speed);
        player.setFlipX(false);
        moving = true;
    } else {
        player.body.setVelocityX(0);
    }

    if ((cursors.up.isDown || wasd.W.isDown || spaceKey.isDown) && onGround) {
        player.body.setVelocityY(jumpV);
    }

    // 굼바/거북이/미친굼바 좌우 patrol
    if (goombas) {
        goombas.children.iterate((g) => {
            if (!g || !g.body) return;
            const origin = g.getData("origin");
            const range = g.getData("range");
            const speed = g.getData("speed") || 70;

            // 안전장치: 정지하면 (벽/적과 충돌 등) 강제로 다시 출발
            if (Math.abs(g.body.velocity.x) < 5) {
                const dir = (g.x > origin) ? -1 : 1;
                g.body.velocity.x = speed * dir;
                g.setFlipX(dir > 0);
            }
            // 범위 끝 도달 시 반대로
            if (g.x < origin - range && g.body.velocity.x < 0) {
                g.body.velocity.x = speed; g.setFlipX(true);
            } else if (g.x > origin + range && g.body.velocity.x > 0) {
                g.body.velocity.x = -speed; g.setFlipX(false);
            }
        });
    }

    // 텍스처 스왑 (idle / walk_a/b / jump)
    if (!onGround) {
        player.setTexture('cat_jump');
    } else if (moving) {
        const frame = (Math.floor(performance.now() / 120) % 2 === 0) ? 'cat_walk_a' : 'cat_walk_b';
        player.setTexture(frame);
    } else {
        player.setTexture('cat_idle');
    }

    // 서버 동기화 (4 fps 정도)
    const now = performance.now();
    if (now - lastSyncTime > 250) {
        lastSyncTime = now;
        const px = Math.round(player.x);
        const py = Math.round(player.y);
        if (Math.abs(px - serverPos.x) >= 5 || Math.abs(py - serverPos.y) >= 5) {
            sendMove(px, py);
        }
    }

    hudX.textContent = Math.round(player.x);
}

async function sendMove(x, y) {
    if (sendMovePending) return;     // 병렬 호출 차단 (race condition fix)
    sendMovePending = true;

    // 거리 제한 (서버 120/500과 맞춤)
    const dx = Math.max(-120, Math.min(120, x - serverPos.x));
    const dy = Math.max(-500, Math.min(500, y - serverPos.y));
    const tx = serverPos.x + dx;
    const ty = serverPos.y + dy;

    try {
        const sigR = await fetch("/api/sign", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({x: tx, y: ty}),
        });
        if (!sigR.ok) return;
        const { sig } = await sigR.json();
        const moveR = await fetch("/api/move", {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-Signature": sig},
            body: JSON.stringify({x: tx, y: ty}),
        });
        if (!moveR.ok) return;
        const data = await moveR.json();
        serverPos.x = tx;
        serverPos.y = ty;
        if (data.flag || data.flag_part1) {
            gameState.cleared = true;
            if (window.bgm) window.bgm.stop();
            if (window.clearBgm) window.clearBgm.play();
            flagBox.textContent = data.flag || data.flag_part1;
            winOverlay.classList.remove("hidden");
        }
    } catch (e) { /* network blip */ }
    finally { sendMovePending = false; }
}

async function triggerDeath(trapType, tx, ty) {
    if (dead) return;
    dead = true;
    // 물리 정지: 죽은 동안 캐릭터 안 움직이게
    player.body.setVelocity(0, 0);
    player.body.setAllowGravity(false);
    player.body.moves = false;
    player.setTexture('cat_hit');
    // 가까운 숨은 굼바 reveal (사망 위치 ±150px 안에 있는 invisible spike)
    spikes.children.iterate((s) => {
        if (!s || s.visible) return;
        if (Math.abs(s.x - player.x) < 150 && Math.abs(s.y - player.y) < 150) {
            s.setVisible(true);
            // 깜빡임 효과 (드러나는 순간)
            scene.tweens.add({
                targets: s,
                alpha: { from: 0.3, to: 1 },
                duration: 200,
                repeat: 2,
                yoyo: true,
            });
        }
    });
    // 사망 좌표를 트랩 위치 근처로 보정 (서버 검증 통과용)
    serverPos.x = tx;
    serverPos.y = ty;
    try {
        await fetch("/api/death", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({trap: trapType, x: tx, y: ty}),
        });
    } catch (e) {}
    gameState.deaths += 1;
    hudDeaths.textContent = gameState.deaths;

    // death-screen 시도 (먼저 호출해서 admin 여부 판단)
    const r = await fetch("/api/death-screen");
    let screenHtml = "";
    let notAdmin = false;
    if (r.ok) {
        screenHtml = await r.text();
    } else {
        const data = await r.json().catch(() => ({error: "?"}));
        const msg = data.hint || data.error || "?";
        if (data.error === "you are not admin") notAdmin = true;
        screenHtml = `<div class="death-card"><h1>RIP</h1><p>${escapeHtml(msg)}</p></div>`;
    }

    // 서버 진행 상황 + 게이트 목표 표시
    let statsHtml = "";
    try {
        const s = await fetch("/api/state").then(r => r.json());
        const traps = (s.unique_traps && s.unique_traps.length) ? s.unique_traps.join(", ") : "(none)";
        const tCnt = (s.unique_traps || []).length;
        const displayName = notAdmin ? "??" : s.name;
        const line = (cur, req, text) => {
            const ok = cur >= req;
            const cls = ok ? "ok" : "fail";
            const mark = ok ? "✓" : "✗";
            return `<div class="stat-line ${cls}">▸ ${mark} ${text}</div>`;
        };
        statsHtml = `<div class="death-stats">
            <div class="stat-line name-line">▸ name: ${escapeHtml(displayName)}</div>
            ${line(s.play_time, 30, `play_time:  ${s.play_time}s / 30s`)}
            ${line(s.deaths, 3,    `deaths:     ${s.deaths} / 3`)}
            ${line(tCnt, 2,        `trap_types: ${tCnt} / 2  [${escapeHtml(traps)}]`)}
            ${line(s.move_count, 20, `moves:      ${s.move_count} / 20`)}
            ${line(s.y_range, 50,  `y_jump:     ${s.y_range}px / 50px`)}
        </div>`;
    } catch (e) {}

    deathContent.innerHTML = screenHtml + statsHtml;
    deathOverlay.classList.remove("hidden");
    // 자동 부활 제거 — RESPAWN 버튼 클릭해야 재시작
}

// ============== 마리오 1-1 엔딩 시퀀스 ==============
async function startGoalSequence() {
    // BGM 전환: 메인 끄고 클리어 테마 재생
    if (window.bgm) window.bgm.stop();
    if (window.clearBgm) window.clearBgm.play();

    // 플레이어 물리 정지
    player.body.setVelocity(0, 0);
    player.body.setAllowGravity(false);
    player.body.moves = false;
    player.setTexture('cat_idle');

    // 1. 깃발 + 플레이어 슬라이드 다운
    scene.tweens.add({
        targets: goalFlag,
        y: 510,
        duration: 1200,
        ease: 'Sine.easeIn'
    });
    scene.tweens.add({
        targets: player,
        x: GOAL_X - 20,
        y: 540,
        duration: 1200,
        ease: 'Sine.easeIn'
    });

    await sleep(1400);

    // 2. 마리오 캐슬로 걸어가기
    player.setFlipX(false);
    let walkTimer = scene.time.addEvent({
        delay: 130, loop: true,
        callback: () => {
            player.setTexture(player.texture.key === 'cat_walk_a' ? 'cat_walk_b' : 'cat_walk_a');
        }
    });

    scene.tweens.add({
        targets: player,
        x: GOAL_X + 200,
        duration: 1800,
        ease: 'Linear',
        onComplete: () => {
            walkTimer.remove();
            player.setVisible(false);   // 성 안으로 들어감
        }
    });

    await sleep(2000);

    // 3. 폭죽
    spawnFireworks(GOAL_X + 200, 400);
    scene.time.delayedCall(400, () => spawnFireworks(GOAL_X + 150, 380));
    scene.time.delayedCall(800, () => spawnFireworks(GOAL_X + 250, 350));

    // 4. 서버 호출 → flag (현재 위치부터 9000까지 100px씩 walk)
    let flag = null, errMsg = null;
    let cx = (await fetch('/api/state').then(r => r.json())).x;
    while (cx < GOAL_X) {
        const nx = Math.min(cx + 100, GOAL_X);
        const sr = await fetch('/api/sign', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({x: nx, y: 540})
        });
        if (!sr.ok) {
            const d = await sr.json().catch(() => ({error: 'sign refused'}));
            errMsg = (d.hint || d.error || 'sign fail') + ` @ x=${nx}`;
            break;
        }
        const { sig } = await sr.json();
        const mr = await fetch('/api/move', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Signature': sig},
            body: JSON.stringify({x: nx, y: 540})
        });
        const data = await mr.json();
        if (data.flag) { flag = data.flag; break; }
        if (data.flag_part1) { flag = data.flag_part1; break; }
        if (!data.ok) {
            errMsg = (data.hint || data.error || 'move fail') + ` @ x=${nx}`;
            break;
        }
        cx = nx;
    }

    await sleep(2000);   // 폭죽 보고

    // 5. 결과 표시
    if (flag) {
        flagBox.textContent = flag;
        winOverlay.classList.remove("hidden");
    } else {
        flagBox.textContent = '🚫 ' + errMsg + '\n\n게이트 통과 부족 — 게임 더 플레이해야 함';
        winOverlay.querySelector('h1').textContent = 'ALMOST!';
        winOverlay.classList.remove("hidden");
    }
}

function spawnFireworks(cx, cy) {
    const colors = [0xff3344, 0xffcc00, 0x33ff66, 0x33aaff, 0xff66cc, 0xffffff];
    const color = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        const speed = 120 + Math.random() * 60;
        const p = scene.add.circle(cx, cy, 5, color);
        scene.physics.add.existing(p);
        p.body.setAllowGravity(true);
        p.body.setGravityY(200);
        p.body.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
        scene.tweens.add({
            targets: p,
            alpha: 0,
            duration: 1800,
            onComplete: () => p.destroy()
        });
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function respawn() {
    dead = false;
    player.x = 50;
    player.y = 500;
    player.body.setVelocity(0, 0);
    player.body.setAllowGravity(true);
    player.body.moves = true;
    player.setTexture('cat_idle');
    serverPos.x = 50;
    serverPos.y = 500;
}
