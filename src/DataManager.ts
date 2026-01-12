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
        let songQueue: Song[] = [];
        let currentVote: any = null;
        let participationData: any = {};
        
        if (channelRes.data) {
            settings = { ...defaultSettings, ...channelRes.data.settings };
            overlaySettings = channelRes.data.overlay_settings || {};
            songQueue = channelRes.data.song_queue || [];
            currentVote = channelRes.data.current_vote;
            participationData = channelRes.data.participation_data || {};
        } else {
            // 신규 채널 등록
            await supabase.from('channels').insert({ 
                channel_id: channelId,
                settings: defaultSettings,
                overlay_settings: {},
                song_queue: [],
                current_vote: null,
                participation_data: {}
            });
        }

        // ... (중략: commands, macros, counters, points 매핑) ...
        const commands: Command[] = (commandsRes.data || []).map(c => ({
            id: c.id,
            triggers: c.triggers,
            trigger: c.triggers[0],
            response: c.response,
            enabled: c.enabled,
            state: { totalCount: 0, userCounts: {} }
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
            votes: currentVote ? [currentVote] : [],
            participants: {
                queue: participationData.queue || [],
                participants: participationData.participants || [],
                maxParticipants: participationData.maxParticipants || 10,
                isParticipationActive: participationData.isParticipationActive || false,
                userParticipationHistory: participationData.userParticipationHistory || {}
            },
            songQueue: songQueue,
            currentSong: null,
            drawHistory: [],
            rouletteHistory: []
        };
    }

    // ... (중략) ...

    static async saveData(channelId: string, data: BotData): Promise<void> {
        // 1. 설정 및 휘발성 데이터 저장
        const activeVote = data.votes && data.votes.length > 0 ? data.votes[data.votes.length - 1] : null;

        await supabase.from('channels').upsert({
            channel_id: channelId,
            settings: data.settings,
            overlay_settings: data.overlaySettings || {},
            song_queue: data.songQueue || [],
            current_vote: activeVote,
            participation_data: data.participants, // 참여 데이터 저장
            updated_at: new Date().toISOString()
        });

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
