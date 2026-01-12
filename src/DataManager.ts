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

export interface VoteOption {
    id: string;
    text: string;
}

export interface VoterChoice {
    userIdHash: string;
    optionId: string;
    nickname?: string;
}

export interface Vote {
    id: string;
    question: string;
    options: VoteOption[];
    results: { [optionId: string]: number };
    isActive: boolean;
    durationSeconds: number;
    startTime: number | null;
    endTime?: number | null;
    voters: string[];
    voterChoices: VoterChoice[];
}

export interface ParticipationData {
    queue: Participant[];
    participants: Participant[];
    maxParticipants: number;
    isParticipationActive: boolean;
    userParticipationHistory?: { [key: string]: { nickname: string; count: number } };
}

export interface OverlaySettings {
    backgroundOpacity: number;
    themeColor: string;
    position: 'top' | 'center' | 'bottom';
    size: 'small' | 'medium' | 'large';
    showAnimation: boolean;
    showConfetti: boolean;
    enableTTS: boolean;
    ttsVolume: number;
}

export const defaultOverlaySettings: OverlaySettings = {
    backgroundOpacity: 70,
    themeColor: '#00ff94',
    position: 'center',
    size: 'medium',
    showAnimation: true,
    showConfetti: true,
    enableTTS: false,
    ttsVolume: 50
};

export interface BotData {
    points: UserPoints;
    votes: Vote[];
    participants: ParticipationData;
    counters: Counter[];
    macros: Omit<Macro, 'timerId'>[];
    settings: BotSettings;
    songQueue: Song[];
    currentSong: Song | null;
    commands: Command[];
    drawHistory?: DrawSession[];
    rouletteHistory?: RouletteSession[];
    overlaySettings?: OverlaySettings;
}

// 채널별 데이터 캐싱
const cache: { [channelId: string]: BotData } = {};

export class DataManager {
    // 채널 ID를 인자로 받도록 수정
    static async loadData(channelId: string): Promise<BotData> {
        if (cache[channelId]) {
            return cache[channelId];
        }

        const defaultData: BotData = {
            points: {},
            votes: [],
            participants: {
                queue: [],
                participants: [],
                maxParticipants: 5,
                isParticipationActive: false,
                userParticipationHistory: {}
            },
            counters: [],
            macros: [],
            settings: defaultSettings,
            songQueue: [],
            currentSong: null,
            commands: [],
            drawHistory: [],
            rouletteHistory: [],
            overlaySettings: defaultOverlaySettings,
        };

        try {
            const { data, error } = await supabase
                .from('bot_data')
                .select('data')
                .eq('channel_id', channelId)
                .single();

            if (error || !data) {
                console.log(`[DataManager] No data found for ${channelId}, using defaults.`);
                cache[channelId] = defaultData;
                return defaultData;
            }

            // 병합 (새로운 필드가 추가되었을 때를 대비)
            cache[channelId] = { ...defaultData, ...data.data };
            return cache[channelId];

        } catch (error) {
            console.error(`[DataManager] Error loading data for ${channelId}:`, error);
            return defaultData;
        }
    }

    static async saveData(channelId: string, data: BotData): Promise<void> {
        cache[channelId] = data;
        
        // 비동기로 저장 (성능 위해 await 안 함, 필요 시 await 추가)
        supabase
            .from('bot_data')
            .upsert({ 
                channel_id: channelId, 
                data: data,
                updated_at: new Date().toISOString()
            })
            .then(({ error }) => {
                if (error) console.error(`[DataManager] Failed to save data for ${channelId}:`, error);
            });
    }
}