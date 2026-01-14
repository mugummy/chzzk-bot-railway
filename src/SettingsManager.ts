export interface BotSettings {
    chatEnabled: boolean;
    songRequestMode: 'all' | 'cooldown' | 'donation' | 'off';
    songRequestCooldown: number;
    minDonationAmount: number;
    pointsPerChat: number;
    pointsCooldown: number;
    pointsName: string;
    participationCommand: string;
    maxParticipants: number;
}

export const defaultSettings: BotSettings = {
    chatEnabled: true,
    songRequestMode: 'all',
    songRequestCooldown: 30,
    minDonationAmount: 0,
    pointsPerChat: 1,
    pointsCooldown: 60,
    pointsName: '포인트',
    participationCommand: '!시참',
    maxParticipants: 10
};

export class SettingsManager {
    private settings: BotSettings;
    private onStateChangeCallback: () => void = () => {};

    constructor(initialSettings?: Partial<BotSettings>) {
        this.settings = { ...defaultSettings, ...initialSettings };
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getSettings(): BotSettings {
        return this.settings;
    }

    public updateSettings(newSettings: Partial<BotSettings>) {
        // [수정] 실제 값이 변경되었는지 확인 (불필요한 알림 방지)
        const hasChanged = Object.keys(newSettings).some(key => {
            return (this.settings as any)[key] !== (newSettings as any)[key];
        });

        if (hasChanged) {
            this.settings = { ...this.settings, ...newSettings };
            this.notify();
        }
    }
}
