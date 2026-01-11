# Chzzk Bot Server

치지직 채팅 봇 서버 - Railway 배포용

## Railway 배포 방법 (복붙만 하면 끝)

### 1단계: GitHub에 올리기

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/chzzk-bot-server.git
git push -u origin main
```

### 2단계: Railway 배포

1. https://railway.app 접속 → GitHub 로그인
2. **New Project** → **Deploy from GitHub repo**
3. `chzzk-bot-server` 선택
4. **Variables** 탭에서 아래 환경변수 추가:

```
SUPABASE_URL=여기에_Supabase_URL_입력
SUPABASE_SERVICE_ROLE_KEY=여기에_Service_Role_Key_입력
```

5. 자동 배포 완료!

## 환경변수

| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role 키 |
| `POLL_INTERVAL` | 봇 동기화 주기 (기본 5000ms) |

## 작동 방식

1. 서버가 5초마다 Supabase의 `bot_sessions` 테이블 확인
2. `is_active=true`인 세션의 봇을 자동 시작
3. 대시보드에서 봇 시작/중지하면 자동 반영
4. 명령어 변경 시 Realtime으로 즉시 반영
