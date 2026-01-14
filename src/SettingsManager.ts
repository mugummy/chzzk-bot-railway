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
    private onChatEnabledChangeCallback: (enabled: boolean) => void = () => {};

    constructor(initialSettings?: Partial<BotSettings>) {
        // [핵심] DB 값이 있으면 그것을 우선 사용 (깊은 병합)
        this.settings = { ...defaultSettings, ...initialSettings };
        
        // participationCommand가 비어있다면 기본값 보장
        if (!this.settings.participationCommand) {
            this.settings.participationCommand = '!시참';
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    public setOnChatEnabledChange(callback: (enabled: boolean) => void) {
        this.onChatEnabledChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getSettings(): BotSettings {
        return this.settings;
    }

    public updateSettings(newSettings: Partial<BotSettings>) {
        const prevChatEnabled = this.settings.chatEnabled;
        this.settings = { ...this.settings, ...newSettings };
        
        if (newSettings.chatEnabled !== undefined && newSettings.chatEnabled !== prevChatEnabled) {
            this.onChatEnabledChangeCallback(newSettings.chatEnabled);
        }

        this.notify();
    }
}
