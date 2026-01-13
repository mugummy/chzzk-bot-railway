
export interface BotSettings {
    chatEnabled: boolean;
    songRequestCommand: string; // 추가: !신청곡 등
    songRequestResponse: string; // 추가: 응답 문구
    songRequestMode: 'all' | 'cooldown' | 'donation' | 'off';
    songRequestCooldown: number;
    minDonationAmount: number;
    maxSongLength: number;
    maxQueueSize: number;
    pointsPerChat: number;
    pointsCooldown: number;
    pointsName: string;
}

export const defaultSettings: BotSettings = {
    chatEnabled: true,
    songRequestCommand: '!신청곡',
    songRequestResponse: '{user}님, {song} 를 신청곡 리스트에 추가했어요!',
    songRequestMode: 'all',
    songRequestCooldown: 30,
    minDonationAmount: 1000,
    maxSongLength: 10,
    maxQueueSize: 50,
    pointsPerChat: 1,
    pointsCooldown: 60,
    pointsName: '포인트'
};

export class SettingsManager {
    private settings: BotSettings = defaultSettings;

    constructor(initialSettings: BotSettings) {
        this.settings = { ...defaultSettings, ...initialSettings };
    }

    getSettings(): BotSettings {
        return this.settings;
    }

    updateSettings(newSettings: Partial<BotSettings>): void {
        this.settings = { ...this.settings, ...newSettings };
        // DataManager.saveData는 Bot.ts의 saveAllData에서 처리
    }
}