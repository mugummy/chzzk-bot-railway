-- Supabase Schema Cache Reload
-- 이 쿼리를 실행하여 PostgREST가 변경된 스키마(votes 테이블 등)를 인식하게 합니다.
NOTIFY pgrst, 'reload schema';

-- 만약 votes 테이블이 꼬였다면 다시 생성 (필요 시 주석 해제 후 실행)
/*
DROP TABLE IF EXISTS vote_ballots;
DROP TABLE IF EXISTS vote_options;
DROP TABLE IF EXISTS votes;

CREATE TABLE votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'ready',
  mode TEXT DEFAULT 'normal', -- 이 컬럼이 문제였음
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
-- (나머지 테이블 재생성...)
*/
