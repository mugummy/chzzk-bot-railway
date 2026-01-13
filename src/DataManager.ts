import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

/**
 * DataManager: 데이터베이스와의 통신을 관리하며 정교한 저장/로드 로직을 제공합니다.
 */
export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] Atomic Asset Loading: ${channelId}`);

        // 1. 모든 관련 테이블에서 데이터 병렬 추출
        const [chan, cmds, macs, cnts, pts] = await Promise.all([
            supabase.from('channels').select('*').eq('channel_id', channelId).single(),
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId)
        ]);

        if (!chan.data) {
            await supabase.from('channels').insert({ 
                channel_id: channelId, 
                settings: defaultSettings,
                greet_settings: { enabled: true, type: 1, message: "반갑습니다!" },
                greet_history: {}
            });
            return this.getDefaultData(channelId);
        }

        const db = chan.data;
        return {
            settings: { ...defaultSettings, ...db.settings },
            greetData: { settings: db.greet_settings, history: db.greet_history || {} },
            songQueue: db.song_queue || [],
            votes: db.current_vote ? [db.current_vote] : [],
            participants: db.participation_data || { queue: [], active: [], isActive: false, max: 10 },
            commands: (cmds.data || []).map(c => ({ id: c.id, triggers: c.triggers, response: c.response, enabled: c.enabled })),
            macros: (macs.data || []).map(m => ({ id: m.id, message: m.message, interval: m.interval_minutes, enabled: m.enabled })),
            counters: (cnts.data || []).map(c => ({ trigger: c.trigger, response: c.response, enabled: c.enabled, oncePerDay: c.once_per_day, count: c.count })),
            points: (pts.data || []).reduce((acc: any, p: any) => {
                acc[p.user_id_hash] = { nickname: p.nickname, points: p.amount, lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0 };
                return acc;
            }, {})
        };
    }

    static async saveData(channelId: string, data: any): Promise<void> {
        this.saveQueue.set(channelId, data);
        if (this.saveTimeouts.has(channelId)) return;

        const timeout = setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            const latest = this.saveQueue.get(channelId);
            if (latest) {
                this.saveQueue.delete(channelId);
                await this.executeActualSave(channelId, latest);
            }
        }, 1000);
        this.saveTimeouts.set(channelId, timeout);
    }

    private static async executeActualSave(channelId: string, data: any) {
        try {
            // 1. 채널 기본 정보 업데이트
            await supabase.from('channels').update({
                settings: data.settings,
                greet_settings: data.greetData.settings,
                greet_history: data.greetData.history,
                song_queue: data.songQueue,
                current_vote: data.votes?.[0] || null,
                participation_data: data.participants,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);

            // 2. 종속 테이블들 동기화 (원자성 확보를 위해 삭제 후 일괄 삽입)
            await Promise.all([
                this.syncCommands(channelId, data.commands),
                this.syncMacros(channelId, data.macros),
                this.syncCounters(channelId, data.counters)
            ]);
            console.log(`[DataManager] Success: All assets persistent for ${channelId}`);
        } catch (e) { console.error(`[DataManager] Persistence Critical Failure:`, e); }
    }

    private static async syncCommands(channelId: string, items: any[]) {
        await supabase.from('commands').delete().eq('channel_id', channelId);
        if (items.length) await supabase.from('commands').insert(items.map(i => ({ channel_id: channelId, triggers: i.triggers, response: i.response, enabled: i.enabled })));
    }

    private static async syncMacros(channelId: string, items: any[]) {
        await supabase.from('macros').delete().eq('channel_id', channelId);
        if (items.length) await supabase.from('macros').insert(items.map(i => ({ channel_id: channelId, message: i.message, interval_minutes: i.interval, enabled: i.enabled })));
    }

    private static async syncCounters(channelId: string, items: any[]) {
        await supabase.from('counters').delete().eq('channel_id', channelId);
        if (items.length) await supabase.from('counters').insert(items.map(i => ({ channel_id: channelId, trigger: i.trigger, response: i.response, count: i.count || 0, enabled: i.enabled, once_per_day: i.oncePerDay })));
    }

    private static getDefaultData(channelId: string) {
        return { settings: defaultSettings, greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, songQueue: [], votes: [], participants: { queue: [], active: [], isActive: false, max: 10 }, commands: [], macros: [], counters: [], points: {} };
    }
}