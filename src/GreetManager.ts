import { ChatEvent, ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface GreetSettings {
    enabled: boolean;
    type: 1 | 2; // 1: 최초 1회, 2: 매일마다
    message: string;
}

/**
 * GreetManager: 시청자의 방문을 감지하여 자동 인사를 건넵니다.
 * 방문 기록은 채널별로 독립적으로 관리됩니다.
 */
export class GreetManager {
    private settings: GreetSettings = { enabled: true, type: 1, message: "반갑습니다! 방송에 오신 것을 환영합니다." };
    private history: { [userIdHash: string]: string } = {}; // userId -> lastGreetDate (YYYY-MM-DD)
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialData?: any) {
        if (initialData) {
            this.settings = initialData.settings || this.settings;
            this.history = initialData.history || {};
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    /**
     * 설정 업데이트 (대시보드 요청)
     */
    public updateSettings(newSettings: Partial<GreetSettings>) {
        this.settings = { ...this.settings, ...newSettings };
        this.notify();
    }

    /**
     * 방문 기록 초기화
     */
    public clearHistory() {
        this.history = {};
        this.notify();
    }

    /**
     * 채팅 수신 시 인사 대상인지 판별 후 인사 실행
     */
    public async handleChat(chat: ChatEvent, chzzkChat: ChzzkChat) {
        if (!this.settings.enabled) return;

        const userId = chat.profile.userIdHash;
        const today = new Date().toISOString().split('T')[0];
        const lastGreeted = this.history[userId];

        let shouldGreet = false;

        if (this.settings.type === 1) {
            // 최초 1회 모드: 기록이 아예 없는 경우에만
            if (!lastGreeted) shouldGreet = true;
        } else {
            // 매일마다 모드: 오늘 날짜의 기록이 없는 경우에만
            if (lastGreeted !== today) shouldGreet = true;
        }

        if (shouldGreet) {
            this.history[userId] = today;
            
            // 변수 치환 ({user} -> 닉네임)
            const msg = this.settings.message.replace(/{user}/g, chat.profile.nickname);
            try {
                await chzzkChat.sendChat(msg);
                this.notify();
            } catch (err) {
                console.error('[GreetManager] Failed to send greet:', err);
            }
        }
    }

    public getState() {
        return {
            settings: this.settings,
            historyCount: Object.keys(this.history).length
        };
    }

    public getData() {
        return {
            settings: this.settings,
            history: this.history
        };
    }
}