import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

/**
 * DataManager: 데이터베이스 통신 총괄
 */
export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] Loading: ${channelId}`);
        const [chan, cmds, macs, cnts, pts] = await Promise.all([
            supabase.from('channels').select('*').eq('channel_id', channelId).single(),
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId)
        ]);

        if (!chan.data) {
            await supabase.from('channels').insert({ channel_id: channelId, settings: defaultSettings, greet_settings: { enabled: true, type: 1, message: "반갑습니다!" }, greet_history: {} });
            return this.getDefault(channelId);
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
            counters: (cnts.data || []).map(c => ({ trigger: c.trigger, response: c.response, enabled: c.enabled, once_per_day: c.once_per_day, count: c.count })),
            points: (pts.data || []).reduce((acc: any, p: any) => {
                acc[p.user_id_hash] = { nickname: p.nickname, points: p.amount, lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0 };
                return acc;
            }, {})
        };
    }

    // [중요] 누락되었던 참여 랭킹 로드 함수 추가
    static async loadParticipationHistory(channelId: string) {
        try {
            const { data } = await supabase
                .from('participation_history')
                .select('nickname, count')
                .eq('channel_id', channelId)
                .order('count', { ascending: false })
                .limit(10);
            return data || [];
        } catch (e) { return []; }
    }

    static async saveParticipationHistory(channelId: string, userIdHash: string, nickname: string) {
        const { data: existing } = await supabase.from('participation_history').select('count').eq('channel_id', channelId).eq('user_id_hash', userIdHash).single();
        if (existing) {
            await supabase.from('participation_history').update({ count: existing.count + 1, nickname }).eq('channel_id', channelId).eq('user_id_hash', userIdHash);
        } else {
            await supabase.from('participation_history').insert({ channel_id: channelId, user_id_hash: userIdHash, nickname, count: 1 });
        }
    }

    static async saveData(channelId: string, data: any): Promise<void> {
        this.saveQueue.set(channelId, data);
        if (this.saveTimeouts.has(channelId)) return;
        const timeout = setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            const latest = this.saveQueue.get(channelId);
            if (latest) { await this.executeActualSave(channelId, latest); }
        }, 1000);
        this.saveTimeouts.set(channelId, timeout);
    }

    private static async executeActualSave(channelId: string, data: any) {
        try {
            await supabase.from('channels').update({
                settings: data.settings,
                greet_settings: data.greetData.settings,
                greet_history: data.greetData.history,
                song_queue: data.songQueue,
                current_vote: data.votes?.[0] || null,
                participation_data: data.participants,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);
            console.log(`[DataManager] Persistent: ${channelId}`);
        } catch (e) {}
    }

    private static getDefault(channelId: string) { return { settings: defaultSettings, greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, songQueue: [], votes: [], participants: { queue: [], active: [], isActive: false, max: 10 }, commands: [], macros: [], counters: [], points: {} }; }
}
