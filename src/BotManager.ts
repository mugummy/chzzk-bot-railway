import { BotInstance } from './BotInstance';
import { config } from './config';

/**
 * BotManager: 서버에서 가동 중인 모든 봇 인스턴스를 관리합니다. (Singleton)
 * 채널별로 하나의 봇만 존재하도록 보장하며, 리소스를 효율적으로 분배합니다.
 */
export class BotManager {
    private static instance: BotManager;
    private bots: Map<string, BotInstance> = new Map();

    private constructor() {}

    public static getInstance(): BotManager {
        if (!BotManager.instance) {
            BotManager.instance = new BotManager();
        }
        return BotManager.instance;
    }

    /**
     * 특정 채널의 봇을 가동하거나 가져옵니다.
     */
    public async getOrCreateBot(channelId: string): Promise<BotInstance> {
        let bot = this.bots.get(channelId);

        if (!bot) {
            console.log(`[BotManager] Starting new bot instance for: ${channelId}`);
            bot = new BotInstance(channelId, config.chzzk.nidAuth, config.chzzk.nidSes);
            await bot.setup();
            this.bots.set(channelId, bot);
        }

        return bot;
    }

    /**
     * 특정 채널의 봇 인스턴스를 즉시 반환 (없으면 null)
     */
    public getBot(channelId: string): BotInstance | undefined {
        return this.bots.get(channelId);
    }

    /**
     * 특정 채널의 봇을 안전하게 중지하고 제거합니다.
     */
    public async removeBot(channelId: string): Promise<void> {
        const bot = this.bots.get(channelId);
        if (bot) {
            await bot.disconnect();
            this.bots.delete(channelId);
            console.log(`[BotManager] Bot instance removed for: ${channelId}`);
        }
    }

    /**
     * 모든 활성화된 봇의 상태 목록을 가져옵니다. (모니터링용)
     */
    public getAllStatus() {
        const status: any[] = [];
        this.bots.forEach((bot, channelId) => {
            status.push(bot.getStatus());
        });
        return status;
    }

    /**
     * 서버 종료 시 모든 봇을 안전하게 저장하고 연결을 끊습니다.
     */
    public async shutdownAll() {
        console.log(`[BotManager] Shutting down all bots...`);
        const tasks = Array.from(this.bots.keys()).map(channelId => this.removeBot(channelId));
        await Promise.all(tasks);
    }
}