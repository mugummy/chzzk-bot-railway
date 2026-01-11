import { supabase, User, BotSettings, BotSession } from './supabase';
import { BotInstance } from './BotInstance';

export class BotManager {
  private bots: Map<string, BotInstance> = new Map();
  private pollInterval: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor() {
    this.pollInterval = parseInt(process.env.POLL_INTERVAL || '5000');
  }

  async start(): Promise<void> {
    console.log('[BotManager] Starting...');
    this.isRunning = true;

    // 초기 로드
    await this.syncBots();

    // 주기적으로 동기화
    this.pollTimer = setInterval(() => {
      this.syncBots().catch(err => {
        console.error('[BotManager] Sync error:', err.message);
      });
    }, this.pollInterval);

    console.log(`[BotManager] Polling every ${this.pollInterval}ms`);
  }

  async stop(): Promise<void> {
    console.log('[BotManager] Stopping...');
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 모든 봇 종료
    for (const [userId, bot] of this.bots) {
      console.log(`[BotManager] Stopping bot for user ${userId}`);
      await bot.disconnect();
    }
    this.bots.clear();
  }

  private async syncBots(): Promise<void> {
    try {
      // 활성 세션 가져오기
      const { data: sessions, error } = await supabase
        .from('bot_sessions')
        .select(`
          *,
          users!inner (
            id,
            chzzk_id,
            channel_id,
            channel_name,
            nid_auth,
            nid_session
          ),
          bot_settings!inner (*)
        `)
        .eq('is_active', true);

      if (error) {
        console.error('[BotManager] Failed to fetch sessions:', error.message);
        return;
      }

      const activeSessions = sessions || [];
      const activeUserIds = new Set(activeSessions.map((s: any) => s.user_id));

      // 비활성화된 봇 종료
      for (const [userId, bot] of this.bots) {
        if (!activeUserIds.has(userId)) {
          console.log(`[BotManager] Stopping inactive bot for user ${userId}`);
          await bot.disconnect();
          this.bots.delete(userId);
        }
      }

      // 새 봇 시작
      for (const session of activeSessions) {
        const userId = session.user_id;
        const user = session.users as User;
        const settings = session.bot_settings as BotSettings;

        if (!this.bots.has(userId)) {
          console.log(`[BotManager] Starting bot for user ${userId} (${user.channel_name})`);

          try {
            const bot = new BotInstance({
              userId,
              channelId: user.channel_id,
              nidAuth: user.nid_auth || undefined,
              nidSession: user.nid_session || undefined,
              settings,
            });

            await bot.connect();
            this.bots.set(userId, bot);
            console.log(`[BotManager] Bot started for ${user.channel_name}`);
          } catch (err: any) {
            console.error(`[BotManager] Failed to start bot for ${user.channel_name}:`, err.message);

            // 세션 비활성화
            await supabase
              .from('bot_sessions')
              .update({
                is_active: false,
                error_message: err.message
              })
              .eq('id', session.id);
          }
        }

        // 하트비트 업데이트
        await supabase
          .from('bot_sessions')
          .update({ last_heartbeat: new Date().toISOString() })
          .eq('id', session.id);
      }
    } catch (err: any) {
      console.error('[BotManager] Sync error:', err.message);
    }
  }

  getActiveBotsCount(): number {
    return this.bots.size;
  }
}
