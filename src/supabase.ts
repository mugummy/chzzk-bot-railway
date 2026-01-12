import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// 타입 정의
export interface User {
  id: string;
  chzzk_id: string;
  channel_id: string;
  channel_name: string;
  profile_image: string | null;
}

export interface BotSettings {
  id: string;
  user_id: string;
  prefix: string;
  points_enabled: boolean;
  points_per_chat: number;
  points_name: string;
  points_cooldown: number;
  song_request_enabled: boolean;
  song_request_mode: 'cooldown' | 'donation' | 'off';
  song_request_cooldown: number;
  song_request_min_donation: number;
}

export interface Command {
  id: string;
  user_id: string;
  triggers: string[];
  response: string;
  enabled: boolean;
  total_count: number;
  editor_value: string | null;
}

export interface Counter {
  id: string;
  user_id: string;
  trigger: string;
  response: string;
  count: number;
  enabled: boolean;
}

export interface ViewerPoint {
  id: string;
  user_id: string;
  viewer_hash: string;
  viewer_nickname: string;
  points: number;
  last_chat_at: string;
}

export interface Vote {
  id: string;
  user_id: string;
  question: string;
  options: { id: string; text: string }[];
  results: { [optionId: string]: number };
  is_active: boolean;
  duration_seconds: number;
  start_time: string | null;
  end_time: string | null;
  voters: string[];
  voter_choices: { userIdHash: string; optionId: string; nickname?: string }[];
}

export interface DrawSession {
  id: string;
  user_id: string;
  is_active: boolean;
  is_collecting: boolean;
  keyword: string;
  participants: { userIdHash: string; nickname: string; joinedAt: number }[];
  winners: { userIdHash: string; nickname: string }[];
  settings: {
    subscriberOnly: boolean;
    excludePreviousWinners: boolean;
    maxParticipants: number;
    winnerCount: number;
  };
}

export interface RouletteSession {
  id: string;
  user_id: string;
  items: { id: string; text: string; weight: number; color: string }[];
  result: { id: string; text: string } | null;
}

export interface SongQueue {
  id: string;
  user_id: string;
  video_id: string;
  title: string;
  duration: number;
  requester_nickname: string;
  requester_hash: string;
  is_played: boolean;
  is_current: boolean;
  created_at: string;
}

export interface BotSession {
  id: string;
  user_id: string;
  is_active: boolean;
  last_heartbeat: string;
  error_message: string | null;
}
