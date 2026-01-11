-- Supabase 스키마 (SQL Editor에서 실행)

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chzzk_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  profile_image TEXT,
  nid_auth TEXT,
  nid_session TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 봇 설정 테이블
CREATE TABLE IF NOT EXISTS bot_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  prefix TEXT DEFAULT '!',
  points_enabled BOOLEAN DEFAULT true,
  points_per_chat INTEGER DEFAULT 10,
  points_name TEXT DEFAULT '포인트',
  song_request_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 명령어 테이블
CREATE TABLE IF NOT EXISTS commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  triggers TEXT[] NOT NULL DEFAULT '{}',
  response TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  total_count INTEGER DEFAULT 0,
  user_counts JSONB DEFAULT '{}',
  editor_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 봇 세션 테이블 (서버가 이 테이블을 폴링)
CREATE TABLE IF NOT EXISTS bot_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN DEFAULT false,
  last_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 시청자 포인트 테이블
CREATE TABLE IF NOT EXISTS viewer_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  viewer_nickname TEXT,
  points INTEGER DEFAULT 0,
  last_chat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, viewer_hash)
);

-- 노래 신청 큐 테이블
CREATE TABLE IF NOT EXISTS song_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  duration INTEGER DEFAULT 0,
  requester_nickname TEXT,
  requester_hash TEXT,
  is_played BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_commands_user_id ON commands(user_id);
CREATE INDEX IF NOT EXISTS idx_commands_enabled ON commands(enabled);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_active ON bot_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_viewer_points_user_viewer ON viewer_points(user_id, viewer_hash);
CREATE INDEX IF NOT EXISTS idx_song_queue_user_played ON song_queue(user_id, is_played);

-- Realtime 활성화 (명령어 실시간 반영용)
ALTER PUBLICATION supabase_realtime ADD TABLE commands;
ALTER PUBLICATION supabase_realtime ADD TABLE bot_sessions;

-- RLS (Row Level Security) 정책
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE viewer_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE song_queue ENABLE ROW LEVEL SECURITY;

-- Service Role은 모든 접근 허용 (봇 서버용)
-- 대시보드는 인증된 사용자만 본인 데이터 접근
CREATE POLICY "Service role full access" ON users FOR ALL USING (true);
CREATE POLICY "Service role full access" ON bot_settings FOR ALL USING (true);
CREATE POLICY "Service role full access" ON commands FOR ALL USING (true);
CREATE POLICY "Service role full access" ON bot_sessions FOR ALL USING (true);
CREATE POLICY "Service role full access" ON viewer_points FOR ALL USING (true);
CREATE POLICY "Service role full access" ON song_queue FOR ALL USING (true);
