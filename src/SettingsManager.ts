
export interface BotSettings {
    songRequestMode: 'cooldown' | 'donation' | 'off';
    songRequestMinDonation: number;
    songRequestCooldown: number;
    pointSystemEnabled: boolean;
    pointsPerChat: number;
    pointCooldown: number;
    playbackMode: 'off' | 'repeat_one' | 'repeat_all' | 'shuffle';
    pointsUnit: string;
}

export const defaultSettings: BotSettings = {
    songRequestMode: 'cooldown',
    songRequestMinDonation: 1000,
    songRequestCooldown: 300,
    pointSystemEnabled: true,
    pointsPerChat: 10,
    pointCooldown: 60,
    playbackMode: 'off',
    pointsUnit: '포인트',
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