using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Scriban;

// =====================================================
// Neko Mario CTF - C# / ASP.NET Core Minimal API 버전
// 의도적으로 취약하게 작성된 CTF 챌린지 코드.
// =====================================================

const int GOAL_X = 9000;
const int GOAL_Y_MIN = 100;
const int GOAL_Y_MAX = 600;

// SECRET_KEY: SSTI로 노출되는 게 풀이 포인트 (의도된 취약점)
var SECRET_KEY = Environment.GetEnvironmentVariable("CTF_SECRET")
                 ?? "jDZuDaxbgwKoJN8pAT7q6Qi8T9RcqagzFXQ0yAgdirqwtLp1";

string FLAG;
try {
    FLAG = File.ReadAllText("flag.txt").Trim();
} catch {
    FLAG = Environment.GetEnvironmentVariable("FLAG")
           ?? "FLAG{Cu_SUP3R_MJS3C_zz}";
}

// 플래그를 2등분: 골 도달 시 PART1, SSTI로 PART2 추출 → 합쳐야 완성
int splitIdx = FLAG.Length / 2;
string FLAG_PART1 = FLAG.Substring(0, splitIdx);
string FLAG_PART2 = FLAG.Substring(splitIdx);

// 트랩 위치 (사망 검증용)
var TRAP_LOCATIONS = new Dictionary<string, (int x, int y)[]>
{
    ["fake_platform"] = new[] {
        // spike 사이 정확히 위치 — 점프 회피 시도 시 사라져 가시로 추락
        (350, 515), (650, 515), (950, 515), (1250, 515), (1550, 515), (1850, 515),
        (2150, 515), (2450, 515), (2750, 515), (3050, 515), (3350, 515), (3650, 515),
        (3950, 515), (4250, 515), (4550, 515), (4850, 515), (5150, 515), (5450, 515),
        (5750, 515), (6050, 515), (6350, 515), (6650, 515), (6950, 515), (7250, 515),
        (7550, 515), (7850, 515), (8150, 515),
    },
    ["spike"] = new[] {
        // 바닥 가시 — 300px 간격으로 빽빽 (28개)
        (200, 545), (500, 545), (800, 545), (1100, 545), (1400, 545), (1700, 545),
        (2000, 545), (2300, 545), (2600, 545), (2900, 545), (3200, 545), (3500, 545),
        (3800, 545), (4100, 545), (4400, 545), (4700, 545), (5000, 545), (5300, 545),
        (5600, 545), (5900, 545), (6200, 545), (6500, 545), (6800, 545), (7100, 545),
        (7400, 545), (7700, 545), (8000, 545), (8300, 545),
        // 천장 가시 — 발판에서 점프 시 사망 (10개)
        (650, 390), (1250, 390), (1850, 390), (2450, 390), (3050, 390),
        (3650, 390), (4250, 390), (5450, 390), (6050, 390), (6950, 390),
        // 보이지 않는 가시 — 학습 강요 (10개)
        (350, 545), (950, 545), (1550, 545), (2150, 545), (2750, 545),
        (3350, 545), (4550, 545), (5150, 545), (5750, 545), (7550, 545),
        // 거북이 patrol 영역
        (1400, 540), (3500, 540), (5500, 540), (7400, 540),
    },
    ["meteor"] = new[] {
        // 운석 트리거 — 바닥
        (600, 540), (1000, 540), (1400, 540), (1800, 540), (2200, 540), (2600, 540),
        (3000, 540), (3400, 540), (3800, 540), (4400, 540), (5000, 540), (5800, 540),
        (6400, 540), (7000, 540), (7600, 540),
        // ? 블록 함정 위치 (점프해서 머리 박으면 운석 떨어짐)
        (400, 440), (1300, 440), (2200, 440), (3100, 440), (4000, 440),
        (4900, 440), (5800, 440), (6700, 440), (7600, 440),
    },
    ["false_goal"]    = new[] { (8500, 510) },
};
var VALID_TRAPS = new HashSet<string>(TRAP_LOCATIONS.Keys) { "cannon", "disappearing_floor", "koopa" };

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.IdleTimeout = TimeSpan.FromHours(1);
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseSession();

// =========================
// 헬퍼들
// =========================

static string HmacSha256(string key, string data)
{
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
    var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(data));
    return Convert.ToHexString(hash).ToLowerInvariant();
}

static long NowUnix() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
static double NowUnixD() => (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

static void EnsureGame(HttpContext ctx)
{
    if (ctx.Session.GetString("session_start") == null)
    {
        ctx.Session.SetString("name", "user");
        ctx.Session.SetInt32("x", 50);
        ctx.Session.SetInt32("y", 500);
        ctx.Session.SetInt32("deaths", 0);
        ctx.Session.SetInt32("move_count", 0);
        ctx.Session.SetString("trap_hits", "");
        ctx.Session.SetString("move_timestamps", "");
        ctx.Session.SetString("session_start", NowUnixD().ToString(CultureInfo.InvariantCulture));
        ctx.Session.SetString("last_move", NowUnixD().ToString(CultureInfo.InvariantCulture));
    }
}

static void ResetGame(HttpContext ctx, string name)
{
    ctx.Session.SetString("name", name);
    ctx.Session.SetInt32("x", 50);
    ctx.Session.SetInt32("y", 500);
    ctx.Session.SetInt32("deaths", 0);
    ctx.Session.SetInt32("move_count", 0);
    ctx.Session.SetInt32("last_death_move", -10);   // ★ 안 리셋하면 die slower로 영원히 거부
    ctx.Session.SetString("trap_hits", "");
    ctx.Session.SetString("move_timestamps", "");
    ctx.Session.SetString("y_history", "");         // ★ 옛 점프 흔적 클리어
    ctx.Session.SetString("x_history", "");         // ★ 옛 위치 이력 클리어 (트랩 근접 검증)
    ctx.Session.SetString("session_start", NowUnixD().ToString(CultureInfo.InvariantCulture));
    ctx.Session.SetString("last_move", NowUnixD().ToString(CultureInfo.InvariantCulture));
}

bool IsAtTrap(int x, int y, string trapType)
{
    if (!TRAP_LOCATIONS.TryGetValue(trapType, out var positions)) return false;
    foreach (var (tx, ty) in positions)
    {
        if (Math.Abs(x - tx) <= 80 && Math.Abs(y - ty) <= 120) return true;
    }
    return false;
}

static (bool ok, string reason) ValidateRealPlay(HttpContext ctx)
{
    var startRaw = ctx.Session.GetString("session_start");
    if (startRaw == null) return (false, "no_session_start");

    var start = double.Parse(startRaw, CultureInfo.InvariantCulture);
    if (NowUnixD() - start < 30) return (false, "play_time_insufficient");

    var deaths = ctx.Session.GetInt32("deaths") ?? 0;
    if (deaths < 3) return (false, "deaths_required");

    var trapHits = ctx.Session.GetString("trap_hits") ?? "";
    var uniqueTraps = trapHits
        .Split(',', StringSplitOptions.RemoveEmptyEntries)
        .Distinct().Count();
    if (uniqueTraps < 2) return (false, "trap_variety_required");

    var moveCount = ctx.Session.GetInt32("move_count") ?? 0;
    if (moveCount < 20) return (false, "movement_required");

    // Y 변화량 체크 — 점프한 흔적 없으면 fail (봇 차단)
    var yhRaw = ctx.Session.GetString("y_history") ?? "";
    var yhList = yhRaw.Split(',', StringSplitOptions.RemoveEmptyEntries)
                      .Select(int.Parse).ToList();
    if (yhList.Count >= 5)
    {
        var yRange = yhList.Max() - yhList.Min();
        if (yRange < 50) return (false, "no_jump_detected");
    }

    // 이동 간격 분석 (봇 탐지)
    var tsRaw = ctx.Session.GetString("move_timestamps") ?? "";
    var ts = tsRaw.Split(',', StringSplitOptions.RemoveEmptyEntries)
                  .Select(s => double.Parse(s, CultureInfo.InvariantCulture))
                  .ToList();
    if (ts.Count >= 10)
    {
        var intervals = new List<double>();
        for (int i = 1; i < ts.Count; i++) intervals.Add(ts[i] - ts[i - 1]);
        var avg = intervals.Average();
        var stdev = intervals.Count > 1
            ? Math.Sqrt(intervals.Sum(v => Math.Pow(v - avg, 2)) / (intervals.Count - 1))
            : 0;
        if (avg < 0.05) return (false, "too_fast_bot_detected");
        if (stdev < 0.01) return (false, "too_uniform_bot_detected");
    }

    return (true, "ok");
}

static void RecordMoveTimestamp(HttpContext ctx)
{
    var raw = ctx.Session.GetString("move_timestamps") ?? "";
    var list = raw.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
    list.Add(NowUnixD().ToString(CultureInfo.InvariantCulture));
    if (list.Count > 100) list = list.Skip(list.Count - 100).ToList();
    ctx.Session.SetString("move_timestamps", string.Join(",", list));
    ctx.Session.SetString("last_move", NowUnixD().ToString(CultureInfo.InvariantCulture));
}

// =========================
// 라우트
// =========================

app.MapGet("/", () => Results.Redirect("/index.html"));

app.MapPost("/api/start", async (HttpContext ctx) =>
{
    var body = await ctx.Request.ReadFromJsonAsync<StartRequest>();
    var name = body?.Name ?? "user";
    if (name.Length > 500) name = name.Substring(0, 500);

    var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "?";
    Console.Error.WriteLine($"[START] ip={ip}  name={name}");
    Console.Error.Flush();

    // 닉네임 필터링 없이 저장 ← SSTI 진입점 (의도된 취약점)
    ResetGame(ctx, name);

    // prefs 쿠키 발급 — 이미 있으면 안 덮어씀 (변조한 admin 권한 유지)
    if (ctx.Request.Cookies.ContainsKey("prefs"))
    {
        return Results.Json(new { ok = true, goal_x = GOAL_X });
    }

    // 첫 방문 시에만 user 쿠키 발급 (의도된 변조 취약점)
    var defaultPrefs = "{\"role\":\"user\",\"theme\":\"mario\"}";
    var prefsB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(defaultPrefs));
    ctx.Response.Cookies.Append("prefs", prefsB64,
        new CookieOptions { HttpOnly = false, SameSite = SameSiteMode.Lax });

    return Results.Json(new { ok = true, goal_x = GOAL_X });
});

// 게임 상태 유지하면서 닉네임만 변경 — SSTI 진입점 (게이트 통과 후 페이로드 박기 위함)
app.MapPost("/api/rename", async (HttpContext ctx) =>
{
    EnsureGame(ctx);
    var body = await ctx.Request.ReadFromJsonAsync<StartRequest>();
    var name = body?.Name ?? "user";
    if (name.Length > 500) name = name.Substring(0, 500);

    var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "?";
    Console.Error.WriteLine($"[RENAME] ip={ip}  name={name}");
    Console.Error.Flush();

    ctx.Session.SetString("name", name);
    return Results.Json(new { ok = true });
});

app.MapGet("/api/state", (HttpContext ctx) =>
{
    EnsureGame(ctx);
    var startRaw = ctx.Session.GetString("session_start");
    double playTime = 0;
    if (startRaw != null)
    {
        var start = double.Parse(startRaw, CultureInfo.InvariantCulture);
        playTime = Math.Round(NowUnixD() - start, 1);
    }
    var trapHits = ctx.Session.GetString("trap_hits") ?? "";
    var uniqueTraps = trapHits
        .Split(',', StringSplitOptions.RemoveEmptyEntries)
        .Distinct().ToList();

    var yhRaw = ctx.Session.GetString("y_history") ?? "";
    var yhList = yhRaw.Split(',', StringSplitOptions.RemoveEmptyEntries)
                      .Select(int.Parse).ToList();
    var yRange = yhList.Count > 0 ? yhList.Max() - yhList.Min() : 0;

    return Results.Json(new
    {
        x = ctx.Session.GetInt32("x") ?? 50,
        y = ctx.Session.GetInt32("y") ?? 500,
        deaths = ctx.Session.GetInt32("deaths") ?? 0,
        goal_x = GOAL_X,
        name = ctx.Session.GetString("name") ?? "user",
        play_time = playTime,
        move_count = ctx.Session.GetInt32("move_count") ?? 0,
        unique_traps = uniqueTraps,
        y_range = yRange,
    });
});

app.MapPost("/api/sign", async (HttpContext ctx) =>
{
    EnsureGame(ctx);
    var body = await ctx.Request.ReadFromJsonAsync<MoveRequest>();
    if (body == null) return Results.BadRequest(new { error = "bad coords" });

    var oldX = ctx.Session.GetInt32("x") ?? 50;
    var oldY = ctx.Session.GetInt32("y") ?? 500;

    if (Math.Abs(body.X - oldX) > 120 || Math.Abs(body.Y - oldY) > 500)
        return Results.Json(new { error = "too far" }, statusCode: 403);

    // 골 영역은 게이트 통과해야 서명 가능 (AI 직접 텔레포트 차단)
    if (body.X >= GOAL_X - 500)
    {
        var (gateOk, reason) = ValidateRealPlay(ctx);
        if (!gateOk)
            return Results.Json(new { error = "complete the game first", hint = reason }, statusCode: 403);
    }

    var sig = HmacSha256(SECRET_KEY, body.X.ToString());
    return Results.Json(new { sig });
});

app.MapPost("/api/move", async (HttpContext ctx) =>
{
    EnsureGame(ctx);
    var body = await ctx.Request.ReadFromJsonAsync<MoveRequest>();
    if (body == null) return Results.BadRequest(new { error = "bad coords" });

    var sig = ctx.Request.Headers["X-Signature"].ToString();
    var expected = HmacSha256(SECRET_KEY, body.X.ToString());
    if (!CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(sig),
            Encoding.UTF8.GetBytes(expected)))
        return Results.Json(new { error = "invalid signature" }, statusCode: 403);

    var oldX = ctx.Session.GetInt32("x") ?? 50;
    var oldY = ctx.Session.GetInt32("y") ?? 500;
    if (Math.Abs(body.X - oldX) > 120 || Math.Abs(body.Y - oldY) > 500)
        return Results.Json(new { error = "too fast" }, statusCode: 403);

    ctx.Session.SetInt32("x", body.X);
    ctx.Session.SetInt32("y", body.Y);
    var moveCount = (ctx.Session.GetInt32("move_count") ?? 0) + 1;
    ctx.Session.SetInt32("move_count", moveCount);
    RecordMoveTimestamp(ctx);

    // Y 변화 기록 (점프 감지용)
    var yhRaw = ctx.Session.GetString("y_history") ?? "";
    var yhList = yhRaw.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
    yhList.Add(body.Y.ToString());
    if (yhList.Count > 30) yhList = yhList.Skip(yhList.Count - 30).ToList();
    ctx.Session.SetString("y_history", string.Join(",", yhList));

    // X 위치 기록 (트랩 근접 이력 검증용 - timestamp 포함)
    var xhRaw = ctx.Session.GetString("x_history") ?? "";
    var xhList = xhRaw.Split(';', StringSplitOptions.RemoveEmptyEntries).ToList();
    xhList.Add($"{body.X}:{NowUnixD():F2}");
    if (xhList.Count > 50) xhList = xhList.Skip(xhList.Count - 50).ToList();
    ctx.Session.SetString("x_history", string.Join(";", xhList));

    if (body.X >= GOAL_X && body.Y >= GOAL_Y_MIN && body.Y <= GOAL_Y_MAX)
    {
        // 골 도달 시도 — 게이트 검증 통과해야 flag 발급 (AI 직접 텔레포트 차단)
        var (gateOk, reason) = ValidateRealPlay(ctx);
        if (!gateOk)
            return Results.Json(new { error = "complete the game first", hint = reason }, statusCode: 403);

        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "?";
        var name = ctx.Session.GetString("name") ?? "?";
        Console.Error.WriteLine($"[FLAG PART1] ip={ip}  name={name}  x={body.X}");
        Console.Error.Flush();
        return Results.Json(new {
            ok = true,
            flag_part1 = FLAG_PART1
        });
    }
    return Results.Json(new { ok = true });
});

app.MapPost("/api/death", async (HttpContext ctx) =>
{
    EnsureGame(ctx);
    var body = await ctx.Request.ReadFromJsonAsync<DeathRequest>();
    if (body == null || string.IsNullOrEmpty(body.Trap))
        return Results.BadRequest(new { error = "invalid body" });

    if (!VALID_TRAPS.Contains(body.Trap))
        return Results.Json(new { error = "invalid trap" }, statusCode: 400);

    // 'no recent activity' 체크 제거 — 멍 때리다 죽어도 사망 인정
    // (anti-bot은 사망 간 이동 횟수 + 트랩 근접 + 트랩 타입 화이트리스트로 충분)

    // die_slower 규칙 제거 — 빡침 게임 특성상 즉사 빈번 (trap_proximity로 anti-bot 충분)
    var moveCountNow = ctx.Session.GetInt32("move_count") ?? 0;

    // 트랩 근접 이력 검증 — 최근 1.5초 안에 해당 트랩 종류의 x좌표 80px 안을 지나갔어야
    if (TRAP_LOCATIONS.TryGetValue(body.Trap, out var trapList))
    {
        var xhRaw = ctx.Session.GetString("x_history") ?? "";
        var nowT = NowUnixD();
        bool nearTrap = false;
        foreach (var entry in xhRaw.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = entry.Split(':');
            if (parts.Length != 2) continue;
            var hx = int.Parse(parts[0]);
            var ht = double.Parse(parts[1], CultureInfo.InvariantCulture);
            if (nowT - ht > 1.5) continue;
            if (trapList.Any(t => Math.Abs(hx - t.x) <= 80)) { nearTrap = true; break; }
        }
        if (!nearTrap)
            return Results.Json(new { error = "no trap nearby in recent history" }, statusCode: 403);
    }

    var deaths = (ctx.Session.GetInt32("deaths") ?? 0) + 1;
    ctx.Session.SetInt32("last_death_move", moveCountNow);
    ctx.Session.SetInt32("deaths", deaths);

    var trapHits = ctx.Session.GetString("trap_hits") ?? "";
    trapHits += body.Trap + ",";
    ctx.Session.SetString("trap_hits", trapHits);

    ctx.Session.SetInt32("x", 50);
    ctx.Session.SetInt32("y", 500);

    return Results.Json(new { ok = true, deaths });
});

app.MapGet("/api/death-screen", (HttpContext ctx) =>
{
    EnsureGame(ctx);

    // prefs 쿠키에서 role 검사 (admin만 SSTI 발현)
    var prefsRaw = ctx.Request.Cookies["prefs"] ?? "";
    string role = "user";
    try
    {
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(prefsRaw));
        var doc = System.Text.Json.JsonDocument.Parse(json);
        role = doc.RootElement.GetProperty("role").GetString() ?? "user";
    }
    catch { /* 변조된 쿠키면 그냥 user 취급 */ }

    if (role != "admin")
    {
        return Results.Json(new
        {
            error = "you are not admin"
        }, statusCode: 403);
    }

    var (ok, reason) = ValidateRealPlay(ctx);
    if (!ok)
    {
        return Results.Json(new
        {
            error = "no genuine gameplay detected",
            hint = reason
        }, statusCode: 403);
    }

    var name = ctx.Session.GetString("name") ?? "user";
    var deaths = ctx.Session.GetInt32("deaths") ?? 0;

    // ★ 의도된 취약점: 사용자 입력(name)을 템플릿 문자열에 직접 삽입 후 파싱/렌더
    var templateText = $"<div class='death-card'><h1>{name} died {deaths} times. Loser.</h1><p>meow~</p></div>";
    var template = Template.Parse(templateText);
    var result = template.Render(new
    {
        server = new ServerInfo(SECRET_KEY, FLAG_PART2)
    });

    return Results.Content(result, "text/html");
});

app.MapGet("/robots.txt", () =>
    Results.Text("User-agent: *\nDisallow: /api/\n", "text/plain"));

app.Run();


// =========================
// 모델 / DTO
// =========================

record StartRequest([property: JsonPropertyName("name")] string? Name);
record MoveRequest(
    [property: JsonPropertyName("x")] int X,
    [property: JsonPropertyName("y")] int Y);
record DeathRequest([property: JsonPropertyName("trap")] string? Trap);

// SSTI로 노출되는 객체.
// Scriban은 .NET 프로퍼티를 snake_case로 노출함
//   server.secret_key  → HMAC 시크릿
//   server.flag_part2  → 플래그 후반부 (전반부는 골 도달 시)
public class ServerInfo
{
    private readonly string _secret;
    private readonly string _flagPart2;
    public ServerInfo(string secret, string flagPart2) {
        _secret = secret;
        _flagPart2 = flagPart2;
    }

    public string Version => "1.0.0";
    public string SecretKey => _secret;
    public string FlagPart2 => _flagPart2;
}
