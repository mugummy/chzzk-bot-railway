import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

/**
 * DataManager: 데이터의 영속성을 보장하는 핵심 클래스 (즉시 저장 방식 적용)
 */
export class DataManager {
    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] Loading Assets: ${channelId}`);
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

    // [수정] 즉시 저장 및 에러 로깅 강화
    static async saveData(channelId: string, data: any): Promise<void> {
        try {
            // 1. 채널 메타데이터 업데이트
            const { error } = await supabase.from('channels').update({
                settings: data.settings,
                greet_settings: data.greetData.settings,
                greet_history: data.greetData.history,
                song_queue: data.songQueue,
                current_vote: data.votes?.[0] || null,
                participation_data: data.participants,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);

            if (error) throw error;

            // 2. 종속 데이터 동기화
            await this.syncCommands(channelId, data.commands);
            await this.syncMacros(channelId, data.macros);
            await this.syncCounters(channelId, data.counters);
            await this.syncPoints(channelId, data.points);

            console.log(`[DataManager] Save Success: ${channelId}`);
        } catch (e) {
            console.error(`[DataManager] Save Failed:`, e);
        }
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

    private static async syncPoints(channelId: string, pointsMap: any) {
        const entries = Object.entries(pointsMap);
        if (entries.length === 0) return;
        const payload = entries.map(([id, p]: [string, any]) => ({
            channel_id: channelId,
            user_id_hash: id,
            amount: p.points,
            nickname: p.nickname,
            last_chat_at: new Date(p.lastMessageTime).toISOString()
        }));
        await supabase.from('points').upsert(payload, { onConflict: 'channel_id,user_id_hash' });
    }

    private static getDefault(channelId: string) { return { settings: defaultSettings, greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, songQueue: [], votes: [], participants: { queue: [], active: [], isActive: false, max: 10 }, commands: [], macros: [], counters: [], points: {} }; }
}