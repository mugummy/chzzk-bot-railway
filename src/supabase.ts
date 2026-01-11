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
  nid_auth: string | null;
  nid_session: string | null;
}

export interface BotSettings {
  id: string;
  user_id: string;
  prefix: string;
  points_enabled: boolean;
  points_per_chat: number;
  points_name: string;
  song_request_enabled: boolean;
}

export interface Command {
  id: string;
  user_id: string;
  triggers: string[];
  response: string;
  enabled: boolean;
  total_count: number;
  user_counts: Record<string, number>;
  editor_value: string | null;
}

export interface BotSession {
  id: string;
  user_id: string;
  is_active: boolean;
  last_heartbeat: string;
}
