export interface OverlayConfig {
    backgroundColor: string;
    textColor: string;
    accentColor: string;
    opacity: number;
    scale: number;
}

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
    overlay: OverlayConfig; // [추가]
}

export const defaultSettings: BotSettings = {
    chatEnabled: true,
    songRequestMode: 'all',
    songRequestCooldown: 30,
    minDonationAmount: 1000,
    pointsPerChat: 10,
    pointsCooldown: 60,
    pointsName: '포인트',
    participationCommand: '!시참',
    maxParticipants: 10,
    overlay: {
        backgroundColor: '#000000', // 박스 배경색 (투명도 조절 대상)
        textColor: '#ffffff',
        accentColor: '#10b981', // 메인 강조 색상
        opacity: 0.9,
        scale: 1.0,
        theme: 'basic' // [New] basic, neon, glass, pixel
    }
};

export class SettingsManager {
    private settings: BotSettings;
    private onStateChangeCallback: () => void = () => {};
    private onChatEnabledCallback: (enabled: boolean) => void = () => {};

    constructor(initialSettings?: any) {
        // 깊은 병합으로 누락된 설정 보완
        this.settings = { 
            ...defaultSettings, 
            ...initialSettings,
            overlay: { ...defaultSettings.overlay, ...(initialSettings?.overlay || {}) }
        };
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    public setOnChatEnabledChange(callback: (enabled: boolean) => void) {
        this.onChatEnabledCallback = callback;
    }

    public updateSettings(newSettings: Partial<BotSettings>) {
        const oldChatEnabled = this.settings.chatEnabled;
        
        // 오버레이 설정 등 깊은 병합 처리
        this.settings = {
            ...this.settings,
            ...newSettings,
            overlay: { ...this.settings.overlay, ...(newSettings.overlay || {}) }
        };

        this.onStateChangeCallback();

        if (newSettings.chatEnabled !== undefined && newSettings.chatEnabled !== oldChatEnabled) {
            this.onChatEnabledCallback(newSettings.chatEnabled);
        }
    }

    public getSettings() {
        return this.settings;
    }
}