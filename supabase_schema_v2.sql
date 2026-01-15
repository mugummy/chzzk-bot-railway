-- [v2 Update] 투표/추첨/룰렛/후원 시스템 스키마

-- 1. 후원 로그 테이블 (후원 추첨용)
CREATE TABLE IF NOT EXISTS donation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  user_id_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 투표 테이블
CREATE TABLE IF NOT EXISTS votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'ready', -- ready, active, ended
  mode TEXT DEFAULT 'normal', -- normal(1인1표), donation(후원비례)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- 3. 투표 항목 테이블
CREATE TABLE IF NOT EXISTS vote_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id UUID REFERENCES votes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  count INTEGER DEFAULT 0
);

-- 4. 투표 참여 내역 (중복 방지용)
CREATE TABLE IF NOT EXISTS vote_ballots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id UUID REFERENCES votes(id) ON DELETE CASCADE,
  user_id_hash TEXT NOT NULL,
  option_id UUID REFERENCES vote_options(id) ON DELETE CASCADE,
  amount INTEGER DEFAULT 1, -- 일반 투표는 1, 후원 투표는 금액
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vote_id, user_id_hash)
);

-- 5. 추첨(Draw) 이력 테이블 (시청자/후원 추첨 통합 관리)
CREATE TABLE IF NOT EXISTS draw_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL, -- viewer, donation
  winners JSONB NOT NULL, -- 당첨자 목록 [{nickname, id, ...}]
  settings JSONB NOT NULL, -- 당시 추첨 설정
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. 룰렛 프리셋 테이블
CREATE TABLE IF NOT EXISTS roulette_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  title TEXT DEFAULT '기본 룰렛',
  items JSONB NOT NULL, -- [{label, weight, color}]
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 오버레이 설정 테이블 (채널별)
CREATE TABLE IF NOT EXISTS overlay_settings (
  channel_id TEXT PRIMARY KEY,
  is_visible BOOLEAN DEFAULT true,
  current_view TEXT DEFAULT 'none', -- none, vote, draw, roulette
  draw_data JSONB, -- 현재 진행 중인 추첨 데이터 (애니메이션용)
  vote_id UUID, -- 현재 표시할 투표 ID
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_donation_logs_channel ON donation_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_votes_channel_status ON votes(channel_id, status);

-- RLS 정책 (서비스 롤 전용)
ALTER TABLE donation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE roulette_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE overlay_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON donation_logs FOR ALL USING (true);
CREATE POLICY "Service role full access" ON votes FOR ALL USING (true);
CREATE POLICY "Service role full access" ON vote_options FOR ALL USING (true);
CREATE POLICY "Service role full access" ON vote_ballots FOR ALL USING (true);
CREATE POLICY "Service role full access" ON draw_history FOR ALL USING (true);
CREATE POLICY "Service role full access" ON roulette_presets FOR ALL USING (true);
CREATE POLICY "Service role full access" ON overlay_settings FOR ALL USING (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE overlay_settings;
