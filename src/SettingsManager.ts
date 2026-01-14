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
    // [중요] 채팅 알림 트리거를 위한 콜백 추가
    private onChatEnabledChangeCallback: (enabled: boolean) => void = () => {};

    constructor(initialSettings?: Partial<BotSettings>) {
        this.settings = { ...defaultSettings, ...initialSettings };
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
        
        // 설정 업데이트
        this.settings = { ...this.settings, ...newSettings };
        
        // [핵심] chatEnabled 값이 실제로 바뀌었을 때만 알림 콜백 호출
        if (newSettings.chatEnabled !== undefined && newSettings.chatEnabled !== prevChatEnabled) {
            this.onChatEnabledChangeCallback(newSettings.chatEnabled);
        }

        this.notify();
    }
}