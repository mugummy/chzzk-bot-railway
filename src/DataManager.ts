import fs from "fs/promises";
import path from "path";
import { BotSettings, defaultSettings } from "./SettingsManager";
import { Song } from "./SongManager";
import { Command } from "./CommandManager";
import { Counter } from "./CounterManager";
import { Macro } from "./MacroManager";
import { UserPoints } from "./PointManager";
import { Participant } from "./ParticipationManager";
import { DrawSession } from "./DrawManager";
import { RouletteSession } from "./RouletteManager";

const DATA_FILE = path.join(__dirname, "..", "bot_data.json");

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

// 오버레이 설정
export interface OverlaySettings {
    backgroundOpacity: number;      // 0-100 슬라이드바
    themeColor: string;             // 테마 색상
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
    // 새로 추가된 데이터
    drawHistory?: DrawSession[];
    rouletteHistory?: RouletteSession[];
    overlaySettings?: OverlaySettings;
}

let cachedData: BotData | null = null;

export class DataManager {
    static async loadData(): Promise<BotData> {
        if (cachedData) {
            return cachedData;
        }
        try {
            const fileContent = await fs.readFile(DATA_FILE, "utf-8");
            cachedData = JSON.parse(fileContent);
            cachedData = {
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
                ...cachedData,
            };
            return cachedData;
        } catch (error) {
            console.warn("bot_data.json 파일을 읽거나 파싱하는 중 오류 발생. 새 데이터를 생성합니다.", error);
            cachedData = {
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
            await DataManager.saveData(cachedData);
            return cachedData;
        }
    }

    static async saveData(data: BotData): Promise<void> {
        cachedData = data;
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    }
}
