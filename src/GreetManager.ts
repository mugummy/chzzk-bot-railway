import { ChatEvent, ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';
import { VariableProcessor } from './VariableProcessor';

export interface GreetSettings {
    enabled: boolean;
    type: 1 | 2; // 1: 최초 1회, 2: 매일마다
    message: string;
}

export class GreetManager {
    private settings: GreetSettings = { enabled: true, type: 1, message: "반갑습니다! 방송에 오신 것을 환영합니다." };
    private history: { [userIdHash: string]: string } = {}; 
    private onStateChangeCallback: () => void = () => {};
    private variableProcessor: VariableProcessor; // [추가] 변수 처리기

    constructor(private bot: BotInstance, initialData?: any) {
        this.variableProcessor = new VariableProcessor(bot); // [추가] 초기화
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
        this.bot.saveAll();
    }

    public updateSettings(newSettings: Partial<GreetSettings>) {
        this.settings = { ...this.settings, ...newSettings };
        this.notify();
    }

    public clearHistory() {
        this.history = {};
        this.notify();
    }

    public async handleChat(chat: ChatEvent, chzzkChat: ChzzkChat) {
        if (!this.settings.enabled) return;

        const userId = chat.profile.userIdHash;
        const today = new Date().toISOString().split('T')[0];
        const lastGreeted = this.history[userId];

        let shouldGreet = false;

        if (this.settings.type === 1) {
            if (!lastGreeted) shouldGreet = true;
        } else {
            if (lastGreeted !== today) shouldGreet = true;
        }

        if (shouldGreet) {
            this.history[userId] = today;
            
            // [수정] 단순 replace가 아닌 VariableProcessor를 통해 함수 처리
            try {
                const processedMsg = await this.variableProcessor.process(this.settings.message, { chat });
                await chzzkChat.sendChat(processedMsg);
                this.notify();
            } catch (err) {
                console.error('[GreetManager] Error:', err);
            }
        }
    }

    public getState() { return { settings: this.settings, historyCount: Object.keys(this.history).length }; }
    public getData() { return { settings: this.settings, history: this.history }; }
}
