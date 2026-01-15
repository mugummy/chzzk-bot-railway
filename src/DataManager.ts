import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<any> {
        const [chan, cmds, macs, cnts, pts] = await Promise.all([
            supabase.from('channels').select('*').eq('channel_id', channelId).single(),
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId)
        ]);

        if (!chan.data) {
            await supabase.from('channels').insert({ channel_id: channelId, settings: defaultSettings });
            return this.getDefault(channelId);
        }

        const db = chan.data;
        return {
            settings: { ...defaultSettings, ...db.settings },
            greetData: { settings: db.greet_settings || { enabled: true, type: 1, message: "반갑습니다!" }, history: db.greet_history || {} },
            songQueue: db.song_queue || [],
            currentSong: db.current_song || null,
            participants: db.participation_data || { queue: [], active: [], isActive: false, max: 10 },
            commands: (cmds.data || []).map(c => ({ id: c.id, triggers: c.triggers || [c.trigger], response: c.response, enabled: c.enabled })),
            macros: (macs.data || []).map(m => ({ id: m.id, title: m.title, message: m.message, interval: m.interval_minutes, enabled: m.enabled })),
            counters: (cnts.data || []).map(c => ({ trigger: c.trigger, response: c.response, enabled: c.enabled, oncePerDay: c.once_per_day, count: c.count })),
            points: (pts.data || []).reduce((acc: any, p: any) => { acc[p.user_id_hash] = { nickname: p.nickname, points: p.amount, lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0 }; return acc; }, {})
        };
    }

    static async saveData(channelId: string, data: any): Promise<void> {
        this.saveQueue.set(channelId, data);
        if (this.saveTimeouts.has(channelId)) return;
        const timeout = setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            const latest = this.saveQueue.get(channelId);
            if (latest) await this.executeActualSave(channelId, latest);
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
                current_song: data.currentSong,
                participation_data: data.participants,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);

            await Promise.all([
                this.syncTable(channelId, 'commands', data.commands.map((i: any) => ({ channel_id: channelId, triggers: i.triggers || [i.trigger], response: i.response, enabled: i.enabled }))),
                this.syncTable(channelId, 'macros', data.macros.map((i: any) => ({ channel_id: channelId, title: i.title, message: i.message, interval_minutes: i.interval, enabled: i.enabled }))),
                this.syncTable(channelId, 'counters', data.counters.map((i: any) => ({ channel_id: channelId, trigger: i.trigger, response: i.response, count: i.count || 0, enabled: i.enabled, once_per_day: i.oncePerDay }))),
                this.syncPoints(channelId, data.points)
            ]);
        } catch (e) {}
    }

    private static async syncTable(channelId: string, table: string, rows: any[]) {
        await supabase.from(table).delete().eq('channel_id', channelId);
        if (rows.length > 0) await supabase.from(table).insert(rows);
    }

    private static async syncPoints(channelId: string, pointsMap: any) {
        const entries = Object.entries(pointsMap);
        if (!entries.length) return;
        const payload = entries.map(([id, p]: [string, any]) => ({ channel_id: channelId, user_id_hash: id, amount: p.points, nickname: p.nickname, last_chat_at: new Date(p.lastMessageTime).toISOString() }));
        await supabase.from('points').upsert(payload, { onConflict: 'channel_id,user_id_hash' });
    }

    static async loadParticipationHistory(channelId: string) {
        const { data } = await supabase.from('participation_history').select('nickname, count').eq('channel_id', channelId).order('count', { ascending: false }).limit(10);
        return data || [];
    }

    private static getDefault(channelId: string) { return { settings: defaultSettings, greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, songQueue: [], currentSong: null, participants: { queue: [], active: [], isActive: false, max: 10 }, commands: [], macros: [], counters: [], points: {} }; }
}