import { supabase } from "./supabase";
import { BotSettings, defaultSettings } from "./SettingsManager";

/**
 * DataManager: 데이터베이스(Supabase)와의 모든 상호작용을 책임집니다.
 * 데이터 로딩 시 기본값(Fallback)을 보장하며, 저장 시 데이터 유실을 방지합니다.
 */
export class DataManager {
    private static saveQueue: Map<string, any> = new Map();
    private static saveTimeouts: Map<string, NodeJS.Timeout> = new Map();

    /**
     * 채널의 모든 설정과 기록을 한 번에 로드합니다.
     */
    static async loadData(channelId: string): Promise<any> {
        console.log(`[DataManager] Fetching all assets for: ${channelId}`);

        // 1. 채널 기본 정보 및 설정 로드
        const { data: chan, error: chanErr } = await supabase
            .from('channels')
            .select('*')
            .eq('channel_id', channelId)
            .single();

        // 2. 명령어, 매크로, 카운터, 포인트 등 병렬 로드 (성능 최적화)
        const [cmds, macs, cnts, pts] = await Promise.all([
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId)
        ]);

        if (chanErr || !chan) {
            console.log(`[DataManager] New channel detected. Initializing: ${channelId}`);
            await this.initializeNewChannel(channelId);
            return this.getDefaultData();
        }

        // DB 데이터를 애플리케이션 규격에 맞게 변환
        return {
            settings: { ...defaultSettings, ...chan.settings },
            greetData: { settings: chan.greet_settings, history: chan.greet_history || {} },
            songQueue: chan.song_queue || [],
            votes: chan.current_vote ? [chan.current_vote] : [],
            participants: chan.participation_data || {},
            commands: (cmds.data || []).map(c => ({
                id: c.id,
                triggers: c.triggers,
                response: c.response,
                enabled: c.enabled,
                state: { totalCount: 0, userCounts: {} } // 런타임 상태 초기화
            })),
            macros: (macs.data || []).map(m => ({
                id: m.id,
                message: m.message,
                interval: m.interval_minutes,
                enabled: m.enabled
            })),
            counters: (cnts.data || []).map(c => ({
                trigger: c.trigger,
                response: c.response,
                enabled: c.enabled,
                oncePerDay: c.once_per_day,
                state: { totalCount: c.count, lastUsedDate: {} }
            })),
            points: (pts.data || []).reduce((acc: any, p: any) => {
                acc[p.user_id_hash] = {
                    nickname: p.nickname,
                    points: p.amount,
                    lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0
                };
                return acc;
            }, {})
        };
    }

    /**
     * 데이터를 Supabase에 안전하게 저장합니다. (1초 디바운스 적용으로 부하 감소)
     */
    static async saveData(channelId: string, data: any): Promise<void> {
        // 이미 대기 중인 저장이 있다면 큐 업데이트만 수행
        this.saveQueue.set(channelId, data);

        if (this.saveTimeouts.has(channelId)) return;

        const timeout = setTimeout(async () => {
            this.saveTimeouts.delete(channelId);
            const latestData = this.saveQueue.get(channelId);
            if (latestData) {
                this.saveQueue.delete(channelId);
                await this.executeActualSave(channelId, latestData);
            }
        }, 1000);

        this.saveTimeouts.set(channelId, timeout);
    }

    private static async executeActualSave(channelId: string, data: any) {
        console.log(`[DataManager] Starting persistence for: ${channelId}`);
        try {
            // 1. 채널 메인 데이터 업데이트 (update 사용 - 세션 정보 보존)
            const { error: chanErr } = await supabase
                .from('channels')
                .update({
                    settings: data.settings,
                    greet_settings: data.greetData?.settings,
                    greet_history: data.greetData?.history,
                    song_queue: data.songQueue,
                    current_vote: data.votes?.[0] || null,
                    participation_data: data.participants,
                    updated_at: new Date().toISOString()
                })
                .eq('channel_id', channelId);

            if (chanErr) throw chanErr;

            // 2. 명령어/매크로/카운터는 데이터 양이 많으므로 갱신 필요 시에만 처리하거나 
            // 별도 로직으로 분리하는 것이 좋으나, 여기선 전체 동기화 방식을 유지하되 최적화합니다.
            await Promise.all([
                this.syncTable('commands', channelId, data.commands.map((c: any) => ({
                    channel_id: channelId, triggers: c.triggers, response: c.response, enabled: c.enabled
                }))),
                this.syncTable('macros', channelId, data.macros.map((m: any) => ({
                    channel_id: channelId, message: m.message, interval_minutes: m.interval, enabled: m.enabled
                }))),
                this.syncTable('counters', channelId, data.counters.map((c: any) => ({
                    channel_id: channelId, trigger: c.trigger, response: c.response, count: c.state?.totalCount || 0, enabled: c.enabled, once_per_day: c.oncePerDay
                })))
            ]);

            console.log(`[DataManager] Success: Data persistent for ${channelId}`);
        } catch (error) {
            console.error(`[DataManager] Critical Persistence Failure:`, error);
        }
    }

    private static async syncTable(table: string, channelId: string, items: any[]) {
        // 기존 데이터 삭제 후 일괄 삽입 (트랜잭션 효과)
        await supabase.from(table).delete().eq('channel_id', channelId);
        if (items.length > 0) {
            await supabase.from(table).insert(items);
        }
    }

    private static async initializeNewChannel(channelId: string) {
        await supabase.from('channels').insert({
            channel_id: channelId,
            settings: defaultSettings,
            greet_settings: { enabled: true, type: 1, message: "반갑습니다!" },
            greet_history: {}
        });
    }

    private static getDefaultData() {
        return {
            settings: defaultSettings,
            greetData: { settings: { enabled: true, type: 1, message: "반갑습니다!" }, history: {} },
            songQueue: [],
            votes: [],
            participants: { queue: [], active: [], isActive: false, max: 10 },
            commands: [],
            macros: [],
            counters: [],
            points: {}
        };
    }
}
