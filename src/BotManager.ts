import { BotInstance } from './BotInstance';
import { config } from './config';
import { supabase } from './supabase';

export class BotManager {
    private static instance: BotManager;
    private bots: Map<string, BotInstance> = new Map();

    private constructor() { }

    public static getInstance(): BotManager {
        if (!BotManager.instance) BotManager.instance = new BotManager();
        return BotManager.instance;
    }

    /**
     * [신규] 서버 시작 시 DB에 등록된 모든 채널의 봇을 미리 가동합니다.
     */
    public async initializeAllBots() {
        console.log('[BotManager] Warming up all registered bots...');
        const { data: channels, error } = await supabase.from('channels').select('channel_id');

        if (error || !channels) {
            console.error('[BotManager] Failed to load channels:', error);
            return;
        }

        for (const channel of channels) {
            await this.getOrCreateBot(channel.channel_id);
        }
        console.log(`[BotManager] ${this.bots.size} bots are ready.`);
    }

    public async getOrCreateBot(channelId: string): Promise<BotInstance> {
        let bot = this.bots.get(channelId);
        if (!bot) {
            console.log(`[BotManager] Spawning bot for: ${channelId}`);
            bot = new BotInstance(channelId, config.chzzk.nidAuth, config.chzzk.nidSes);
            await bot.setup();
            this.bots.set(channelId, bot);
        }
        return bot;
    }

    public getBot(channelId: string): BotInstance | undefined {
        return this.bots.get(channelId);
    }

    public async removeBot(channelId: string): Promise<void> {
        const bot = this.bots.get(channelId);
        if (bot) {
            await bot.disconnect();
            this.bots.delete(channelId);
        }
    }

    public async shutdownAll() {
        const tasks = Array.from(this.bots.keys()).map(id => this.removeBot(id));
        await Promise.all(tasks);
    }

    public async start() { await this.initializeAllBots(); }
    public async stop() { await this.shutdownAll(); }
    public getActiveBotsCount() { return this.bots.size; }

    public setBroadcastFunction(fn: (userId: string, data: any) => void) {
        this.broadcastFn = fn;
        this.bots.forEach(bot => bot.setBroadcastCallback((type, payload) => fn(bot.getChannelId(), { type, payload })));
    }
    private broadcastFn: ((userId: string, data: any) => void) | null = null;
}
