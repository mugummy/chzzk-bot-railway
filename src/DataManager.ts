import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

/**
 * DataManager: 포인트 데이터를 포함한 모든 영속성 데이터를 안전하게 관리합니다.
 */
export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] Atomic Loading: ${channelId}`);
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
            if (latest) { this.saveQueue.delete(channelId); await this.executeActualSave(channelId, latest); }
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

            // 포인트 데이터 일괄 동기화 보강
            const pointOps = Object.entries(data.points).map(([id, p]: [string, any]) => 
                supabase.from('points').upsert({ channel_id: channelId, user_id_hash: id, amount: p.points, nickname: p.nickname, last_chat_at: new Date(p.lastMessageTime).toISOString() })
            );

            await Promise.all([
                this.sync(channelId, 'commands', data.commands),
                this.sync(channelId, 'macros', data.macros),
                this.sync(channelId, 'counters', data.counters),
                ...pointOps
            ]);
            console.log(`[DataManager] Full Persistence Successful for ${channelId}`);
        } catch (e) { console.error(`[DataManager] Save Error:`, e); }
    }

    private static async sync(channelId: string, table: string, items: any[]) {
        await supabase.from(table).delete().eq('channel_id', channelId);
        if (items.length) {
            const payload = items.map(i => {
                if (table === 'commands') return { channel_id: channelId, triggers: i.triggers, response: i.response, enabled: i.enabled };
                if (table === 'macros') return { channel_id: channelId, message: i.message, interval_minutes: i.interval, enabled: i.enabled };
                if (table === 'counters') return { channel_id: channelId, trigger: i.trigger, response: i.response, count: i.count || 0, enabled: i.enabled, once_per_day: i.oncePerDay };
            });
            await supabase.from(table).insert(payload);
        }
    }

    private static getDefault(channelId: string) { return { settings: defaultSettings, greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, songQueue: [], votes: [], participants: { queue: [], active: [], isActive: false, max: 10 }, commands: [], macros: [], counters: [], points: {} }; }
}
