/**
 * SettingsManager: 봇의 모든 전역 설정을 관리합니다.
 * 상태 변경 시 자동으로 BotInstance에 알림을 보냅니다.
 */
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

    /**
     * 설정 업데이트 및 동기화 발생
     */
    public updateSettings(newSettings: Partial<BotSettings>) {
        this.settings = { ...this.settings, ...newSettings };
        this.notify();
    }

    public toggleChat(enabled: boolean) {
        this.settings.chatEnabled = enabled;
        this.notify();
    }
}