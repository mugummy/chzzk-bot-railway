import { supabase } from "./supabase";
import { BotSettings, defaultSettings } from "./SettingsManager";
import { Song } from "./SongManager";
import { Command } from "./CommandManager";
import { Counter } from "./CounterManager";
import { Macro } from "./MacroManager";
import { UserPoints } from "./PointManager";

export interface BotData {
    points: UserPoints;
    votes: any[];
    participants: any;
    counters: Counter[];
    macros: any[];
    settings: BotSettings;
    songQueue: Song[];
    currentSong: Song | null;
    commands: Command[];
    drawHistory?: any[];
    rouletteHistory?: any[];
    overlaySettings?: any;
    participationRanking?: any[];
    greetData?: { settings: any; history: any };
}

export class DataManager {
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<BotData> {
        console.log(`[DataManager] Loading all assets for: ${channelId}`);

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
                greet_settings: { enabled: true, type: 1, message: "방송에 오신 것을 환영합니다!" },
                greet_history: {}
            });
        }

        const db = chan.data || {};
        return {
            settings: { ...defaultSettings, ...db.settings },
            overlaySettings: db.overlay_settings || {},
            songQueue: db.song_queue || [],
            participants: db.participation_data || {},
            greetData: { settings: db.greet_settings, history: db.greet_history },
            points: (pts.data || []).reduce((acc: any, p: any) => {
                acc[p.user_id_hash] = { nickname: p.nickname, points: p.amount, lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0 };
                return acc;
            }, {}),
            commands: (cmds.data || []).map(c => ({ trigger: c.triggers[0], triggers: c.triggers, response: c.response, enabled: c.enabled })),
            macros: (macs.data || []).map(m => ({ id: m.id, message: m.message, interval: m.interval_minutes, enabled: m.enabled })),
            counters: (cnts.data || []).map(c => ({ trigger: c.trigger, response: c.response, enabled: c.enabled, oncePerDay: c.once_per_day, state: { totalCount: c.count, lastUsedDate: {} } })),
            votes: db.current_vote ? [db.current_vote] : [],
            currentSong: null,
            participationRanking: await DataManager.loadParticipationHistory(channelId)
        };
    }

    static async saveParticipationHistory(channelId: string, userIdHash: string, nickname: string) {
        await supabase.from('participation_history').insert({ channel_id: channelId, user_id_hash: userIdHash, nickname: nickname });
    }

    static async loadParticipationHistory(channelId: string) {
        const { data } = await supabase.rpc('get_participation_ranking', { chan_id: channelId });
        return data || [];
    }

    static async saveData(channelId: string, data: BotData): Promise<void> {
        if (this.saveTimeouts.has(channelId)) clearTimeout(this.saveTimeouts.get(channelId)!);
        this.saveTimeouts.set(channelId, setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            await this.executeSave(channelId, data);
        }, 500));
    }

    private static async executeSave(channelId: string, data: BotData): Promise<void> {
        try {
            await supabase.from('channels').update({
                settings: data.settings,
                overlay_settings: data.overlaySettings || {},
                song_queue: data.songQueue || [],
                current_vote: data.votes && data.votes.length > 0 ? data.votes[data.votes.length - 1] : null,
                participation_data: data.participants,
                greet_settings: data.greetData?.settings,
                greet_history: data.greetData?.history,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);

            await Promise.all([
                (async () => {
                    await supabase.from('commands').delete().eq('channel_id', channelId);
                    if (data.commands?.length) {
                        await supabase.from('commands').insert(data.commands.map(c => ({
                            channel_id: channelId, triggers: c.triggers || [c.trigger], response: c.response, enabled: c.enabled
                        })));
                    }
                })(),
                (async () => {
                    await supabase.from('macros').delete().eq('channel_id', channelId);
                    if (data.macros?.length) {
                        await supabase.from('macros').insert(data.macros.map(m => ({
                            channel_id: channelId, message: m.message, interval_minutes: m.interval, enabled: m.enabled
                        })));
                    }
                })(),
                (async () => {
                    await supabase.from('counters').delete().eq('channel_id', channelId);
                    if (data.counters?.length) {
                        await supabase.from('counters').insert(data.counters.map(c => ({
                            channel_id: channelId, trigger: c.trigger, response: c.response, count: c.state?.totalCount || 0, enabled: c.enabled, once_per_day: c.oncePerDay
                        })));
                    }
                })()
            ]);
        } catch (error) { console.error(`[DataManager] Error:`, error); }
    }
}
