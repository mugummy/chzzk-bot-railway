import { supabase } from "./supabase";
import { defaultSettings } from "./SettingsManager";

/**
 * DataManager: 서버 메모리와 Supabase DB 간의 데이터 동기화를 책임지는 핵심 모듈
 * 모든 필드는 snake_case(DB) <-> camelCase(App) 변환을 거칩니다.
 */
export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] 📥 Loading ALL data for: ${channelId}`);
        
        const [chan, cmds, macs, cnts, pts, rank] = await Promise.all([
            supabase.from('channels').select('*').eq('channel_id', channelId).single(),
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId),
            this.loadParticipationHistory(channelId)
        ]);

        if (!chan.data) {
            console.log(`[DataManager] ✨ Creating new channel entry...`);
            await supabase.from('channels').insert({ 
                channel_id: channelId, 
                settings: defaultSettings,
                greet_settings: { enabled: true, type: 1, message: "반갑습니다!" },
                participation_data: { queue: [], active: [], isActive: false, max: 10 }
            });
            return this.getDefault(channelId);
        }

        const db = chan.data;

        return {
            // [Settings]
            settings: { ...defaultSettings, ...db.settings },
            
            // [Greet]
            greetData: { 
                settings: db.greet_settings || { enabled: true, type: 1, message: "반갑습니다!" }, 
                history: db.greet_history || {} 
            },
            
            // [Songs]
            songQueue: db.song_queue || [],
            currentSong: db.current_song || null,
            
            // [Votes & Participation]
            votes: db.current_vote ? [db.current_vote] : [],
            participants: db.participation_data || { queue: [], active: [], isActive: false, max: 10 },
            
            // [Commands]
            commands: (cmds.data || []).map(c => ({ 
                id: c.id, 
                triggers: c.triggers || [c.trigger], // 구버전 호환
                response: c.response, 
                enabled: c.enabled 
            })),
            
            // [Macros]
            macros: (macs.data || []).map(m => ({ 
                id: m.id, 
                title: m.title || '매크로',
                message: m.message, 
                interval: m.interval_minutes, 
                enabled: m.enabled 
            })),
            
            // [Counters]
            counters: (cnts.data || []).map(c => ({ 
                trigger: c.trigger, 
                response: c.response, 
                enabled: c.enabled, 
                oncePerDay: c.once_per_day, 
                count: c.count 
            })),
            
            // [Points]
            points: (pts.data || []).reduce((acc: any, p: any) => {
                acc[p.user_id_hash] = { 
                    nickname: p.nickname, 
                    points: p.amount, 
                    lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0 
                };
                return acc;
            }, {}),
            
            // [Ranking]
            ranking: rank
        };
    }

    static async saveData(channelId: string, data: any): Promise<void> {
        this.saveQueue.set(channelId, data);
        if (this.saveTimeouts.has(channelId)) return;

        const timeout = setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            const latest = this.saveQueue.get(channelId);
            if (latest) { await this.executeActualSave(channelId, latest); }
        }, 1000); // 1초 디바운싱
        
        this.saveTimeouts.set(channelId, timeout);
    }

    private static async executeActualSave(channelId: string, data: any) {
        try {
            // 1. Channels 테이블 (단일 행 업데이트)
            await supabase.from('channels').update({
                settings: data.settings,
                greet_settings: data.greetData.settings,
                greet_history: data.greetData.history,
                song_queue: data.songQueue,
                current_song: data.currentSong,
                current_vote: data.votes?.[0] || null,
                participation_data: data.participants,
                updated_at: new Date().toISOString()
            }).eq('channel_id', channelId);

            // 2. 하위 테이블 (대량 업데이트)
            await Promise.all([
                this.syncTable(channelId, 'commands', data.commands.map((i: any) => ({
                    channel_id: channelId, 
                    triggers: i.triggers || [i.trigger], 
                    response: i.response, 
                    enabled: i.enabled 
                }))),
                this.syncTable(channelId, 'macros', data.macros.map((i: any) => ({
                    channel_id: channelId, 
                    title: i.title,
                    message: i.message, 
                    interval_minutes: i.interval, 
                    enabled: i.enabled 
                }))),
                this.syncTable(channelId, 'counters', data.counters.map((i: any) => ({
                    channel_id: channelId, 
                    trigger: i.trigger, 
                    response: i.response, 
                    count: i.count || 0, 
                    enabled: i.enabled, 
                    once_per_day: i.oncePerDay 
                }))),
                this.syncPoints(channelId, data.points)
            ]);

            console.log(`[DataManager] 💾 Persisted data for ${channelId}`);
        } catch (e) { 
            console.error(`[DataManager] ❌ Save Failed:`, e); 
        }
    }

    private static async syncTable(channelId: string, table: string, rows: any[]) {
        // 기존 데이터 삭제 후 재삽입 (가장 확실한 동기화 방법)
        await supabase.from(table).delete().eq('channel_id', channelId);
        if (rows.length > 0) {
            await supabase.from(table).insert(rows);
        }
    }

    private static async syncPoints(channelId: string, pointsMap: any) {
        const entries = Object.entries(pointsMap);
        if (!entries.length) return;
        
        const payload = entries.map(([id, p]: [string, any]) => ({
            channel_id: channelId, 
            user_id_hash: id, 
            amount: p.points, 
            nickname: p.nickname, 
            last_chat_at: new Date(p.lastMessageTime).toISOString()
        }));
        
        await supabase.from('points').upsert(payload, { onConflict: 'channel_id,user_id_hash' });
    }

    // --- Ranking ---
    static async loadParticipationHistory(channelId: string) {
        const { data } = await supabase
            .from('participation_history')
            .select('nickname, count')
            .eq('channel_id', channelId)
            .order('count', { ascending: false })
            .limit(10);
        return data || [];
    }

    static async saveParticipationHistory(channelId: string, userIdHash: string, nickname: string) {
        // 랭킹은 별도로 즉시 저장
        const { data: existing } = await supabase.from('participation_history').select('count').eq('channel_id', channelId).eq('user_id_hash', userIdHash).single();
        if (existing) {
            await supabase.from('participation_history').update({ count: existing.count + 1, nickname, last_participation_at: new Date().toISOString() }).eq('channel_id', channelId).eq('user_id_hash', userIdHash);
        } else {
            await supabase.from('participation_history').insert({ channel_id: channelId, user_id_hash: userIdHash, nickname, count: 1 });
        }
    }

    private static getDefault(channelId: string) { 
        return { 
            settings: defaultSettings, 
            greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} }, 
            songQueue: [], 
            currentSong: null, 
            votes: [], 
            participants: { queue: [], active: [], isActive: false, max: 10 }, 
            commands: [], 
            macros: [], 
            counters: [], 
            points: {},
            ranking: []
        }; 
    }
}
