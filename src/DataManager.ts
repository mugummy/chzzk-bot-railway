import { supabase } from "./supabase";
import { BotSettings, defaultSettings } from "./SettingsManager";
import { Song } from "./SongManager";
import { Command } from "./CommandManager";
import { Counter } from "./CounterManager";
import { Macro } from "./MacroManager";
import { UserPoints } from "./PointManager";
import { Participant } from "./ParticipationManager";
import { DrawSession } from "./DrawManager";
import { RouletteSession } from "./RouletteManager";

// ... (Interface definitions remain similar, but adapted for DB)

export interface BotData {
    points: UserPoints;
    votes: any[]; // Votes are usually transient or session-based
    participants: any;
    counters: Counter[];
    macros: any[]; // Changed type to match DB structure if needed
    settings: BotSettings;
    songQueue: Song[];
    currentSong: Song | null;
    commands: Command[];
    drawHistory?: DrawSession[];
    rouletteHistory?: RouletteSession[];
    overlaySettings?: any;
}

export class DataManager {
    static async loadData(channelId: string): Promise<BotData> {
        console.log(`[DataManager] Loading data for channel: ${channelId}`);

        // 병렬로 모든 테이블 데이터 조회
        const [
            channelRes,
            commandsRes,
            macrosRes,
            countersRes,
            pointsRes
        ] = await Promise.all([
            supabase.from('channels').select('*').eq('channel_id', channelId).single(),
            supabase.from('commands').select('*').eq('channel_id', channelId),
            supabase.from('macros').select('*').eq('channel_id', channelId),
            supabase.from('counters').select('*').eq('channel_id', channelId),
            supabase.from('points').select('*').eq('channel_id', channelId)
        ]);

        // 채널 정보가 없으면 기본값 생성
        let settings = defaultSettings;
        let overlaySettings = {};
        
        if (channelRes.data) {
            settings = { ...defaultSettings, ...channelRes.data.settings };
            overlaySettings = channelRes.data.overlay_settings || {};
        } else {
            // 신규 채널 등록
            await supabase.from('channels').insert({ 
                channel_id: channelId,
                settings: defaultSettings,
                overlay_settings: {}
            });
        }

        // 데이터 매핑
        const commands: Command[] = (commandsRes.data || []).map(c => ({
            id: c.id,
            triggers: c.triggers,
            trigger: c.triggers[0], // 호환성
            response: c.response,
            enabled: c.enabled,
            state: { totalCount: 0, userCounts: {} } // 상태값은 메모리에만 유지 (DB 저장 안 함)
        }));

        const macros = (macrosRes.data || []).map(m => ({
            id: m.id,
            message: m.message,
            interval: m.interval_minutes,
            enabled: m.enabled
        }));

        const counters: Counter[] = (countersRes.data || []).map(c => ({
            id: c.id,
            trigger: c.trigger,
            response: c.response,
            enabled: c.enabled,
            state: { totalCount: c.count, userCounts: {} }
        }));

        const points: UserPoints = {};
        (pointsRes.data || []).forEach(p => {
            points[p.user_id_hash] = {
                nickname: p.nickname,
                points: p.amount,
                lastMessageTime: p.last_chat_at ? new Date(p.last_chat_at).getTime() : 0
            };
        });

        return {
            settings,
            overlaySettings,
            commands,
            macros,
            counters,
            points,
            // 휘발성 데이터 (DB 저장 안 함)
            votes: [],
            participants: { queue: [], participants: [], maxParticipants: 10, isParticipationActive: false },
            songQueue: [],
            currentSong: null,
            drawHistory: [],
            rouletteHistory: []
        };
    }

    // 개별 저장 메서드들 (효율성을 위해 쪼개서 저장)

    static async saveSettings(channelId: string, settings: BotSettings) {
        await supabase.from('channels').upsert({
            channel_id: channelId,
            settings: settings,
            updated_at: new Date().toISOString()
        });
    }

    static async saveCommand(channelId: string, command: Command) {
        // triggers 배열 처리
        const triggers = command.triggers || (command.trigger ? [command.trigger] : []);
        
        // ID가 있으면 업데이트, 없으면 삽입 (근데 UUID라 매칭이 필요함)
        // CommandManager에서 생성한 임시 ID가 'cmd_'로 시작하면 DB에는 새 UUID로 저장됨
        // 여기선 단순화를 위해 기존 ID가 UUID 형식이 아니면(임시) 새로 생성
        
        const payload: any = {
            channel_id: channelId,
            triggers: triggers,
            response: command.response,
            enabled: command.enabled
        };

        // UUID 형식이면 ID 포함 (업데이트)
        if (command.id && command.id.length === 36) { 
            payload.id = command.id;
        }

        const { data, error } = await supabase.from('commands').upsert(payload).select().single();
        if(!error && data) {
            command.id = data.id; // DB에서 생성된 ID 반영
        }
    }

    static async deleteCommand(channelId: string, trigger: string) {
        // trigger가 배열에 포함된 row 삭제
        await supabase.from('commands')
            .delete()
            .eq('channel_id', channelId)
            .contains('triggers', [trigger]);
    }

    static async savePoint(channelId: string, userIdHash: string, nickname: string, amount: number) {
        await supabase.from('points').upsert({
            channel_id: channelId,
            user_id_hash: userIdHash,
            nickname: nickname,
            amount: amount,
            last_chat_at: new Date().toISOString()
        });
    }

    // ... (다른 저장 메서드들도 필요에 따라 추가 가능)
    // 현재 구조상 Bot.ts의 saveAllData()가 통째로 저장하려고 하므로,
    // 호환성을 위해 통재로 받아서 분산 저장하는 메서드도 제공합니다.

    static async saveData(channelId: string, data: BotData): Promise<void> {
        // 1. 설정 저장
        await this.saveSettings(channelId, data.settings);

        // 2. 명령어 저장 (Overwrite)
        await supabase.from('commands').delete().eq('channel_id', channelId);
        if (data.commands && data.commands.length > 0) {
            const commandsPayload = data.commands.map(c => ({
                channel_id: channelId,
                triggers: c.triggers || [c.trigger],
                response: c.response,
                enabled: c.enabled
            }));
            await supabase.from('commands').insert(commandsPayload);
        }

        // 3. 매크로 저장 (Overwrite)
        await supabase.from('macros').delete().eq('channel_id', channelId);
        if (data.macros && data.macros.length > 0) {
            const macrosPayload = data.macros.map(m => ({
                channel_id: channelId,
                message: m.message,
                interval_minutes: m.interval,
                enabled: m.enabled
            }));
            await supabase.from('macros').insert(macrosPayload);
        }

        // 4. 카운터 저장 (Overwrite)
        await supabase.from('counters').delete().eq('channel_id', channelId);
        if (data.counters && data.counters.length > 0) {
            const countersPayload = data.counters.map(c => ({
                channel_id: channelId,
                trigger: c.trigger,
                response: c.response,
                count: c.state?.totalCount || 0,
                enabled: c.enabled
            }));
            await supabase.from('counters').insert(countersPayload);
        }
        
        // 5. 포인트 일괄 저장 (Upsert)
        const pointUpserts = Object.entries(data.points).map(([hash, p]) => ({
            channel_id: channelId,
            user_id_hash: hash,
            nickname: p.nickname,
            amount: p.points,
            last_chat_at: new Date(p.lastMessageTime).toISOString()
        }));
        
        if (pointUpserts.length > 0) {
            await supabase.from('points').upsert(pointUpserts);
        }
    }
}
