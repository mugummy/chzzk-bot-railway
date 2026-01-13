import { ChatEvent, ChzzkChat } from 'chzzk';
import { ChatBot } from './Bot';

export interface GreetSettings {
    enabled: boolean;
    type: number; // 1: 최초 1회, 2: 매일마다
    message: string;
}

export class GreetManager {
    private settings: GreetSettings = { enabled: true, type: 1, message: "방송에 오신 것을 환영합니다!" };
    private history: { [userIdHash: string]: string } = {}; // userIdHash -> lastGreetDate (YYYY-MM-DD)
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: ChatBot, initialData?: any) {
        if (initialData) {
            this.settings = initialData.settings || this.settings;
            this.history = initialData.history || {};
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    public getState() {
        return {
            settings: this.settings,
            historyCount: Object.keys(this.history).length
        };
    }

    public updateSettings(newSettings: Partial<GreetSettings>) {
        this.settings = { ...this.settings, ...newSettings };
        this.notifyStateChange();
    }

    public clearHistory() {
        this.history = {};
        this.notifyStateChange();
    }

    public async handleChat(chat: ChatEvent, chzzkChat: ChzzkChat) {
        if (!this.settings.enabled || !this.bot.settings.chatEnabled) return;

        const userId = chat.profile.userIdHash;
        const today = new Date().toISOString().split('T')[0];
        const lastDate = this.history[userId];

        let shouldGreet = false;

        if (this.settings.type === 1) {
            // 최초 1회 모드: 기록이 아예 없어야 함
            if (!lastDate) shouldGreet = true;
        } else {
            // 매일마다 모드: 오늘 날짜의 기록이 없어야 함
            if (lastDate !== today) shouldGreet = true;
        }

        if (shouldGreet) {
            this.history[userId] = today;
            const msg = this.settings.message.replace(/{user}/g, chat.profile.nickname);
            chzzkChat.sendChat(msg);
            this.notifyStateChange();
        }
    }

    public getData() {
        return { settings: this.settings, history: this.history };
    }
}
