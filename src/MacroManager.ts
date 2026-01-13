import { ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface Macro {
    id: string;
    message: string;
    interval: number; // minutes
    enabled: boolean;
}

/**
 * MacroManager: 주기적으로 채팅을 전송하는 매크로 기능을 관리합니다.
 */
export class MacroManager {
    private macros: Macro[] = [];
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private chatClient: ChzzkChat | null = null;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialMacros: any[]) {
        this.macros = initialMacros || [];
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    public setChatClient(client: ChzzkChat) {
        this.chatClient = client;
        this.restartAllMacros();
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getMacros() { return this.macros; }

    /**
     * 매크로 추가
     */
    public addMacro(interval: number, message: string) {
        const id = `mac_${Date.now()}`;
        const newMacro: Macro = { id, message, interval, enabled: true };
        this.macros.push(newMacro);
        this.startMacro(newMacro);
        this.notify();
    }

    /**
     * 매크로 제거
     */
    public removeMacro(id: string) {
        this.stopMacro(id);
        this.macros = this.macros.filter(m => m.id !== id);
        this.notify();
    }

    /**
     * 개별 매크로 시작
     */
    private startMacro(macro: Macro) {
        if (!macro.enabled || !this.chatClient) return;
        this.stopMacro(macro.id); // 기존 타이머가 있다면 제거

        const timer = setInterval(() => {
            if (this.chatClient?.connected) {
                this.chatClient.sendChat(macro.message);
            }
        }, macro.interval * 60 * 1000);

        this.timers.set(macro.id, timer);
    }

    /**
     * 개별 매크로 중지
     */
    private stopMacro(id: string) {
        if (this.timers.has(id)) {
            clearInterval(this.timers.get(id)!);
            this.timers.delete(id);
        }
    }

    /**
     * 모든 매크로 재시작 (설정 변경 시 등)
     */
    private restartAllMacros() {
        this.stopAllMacros();
        this.macros.forEach(m => this.startMacro(m));
    }

    public stopAllMacros() {
        this.timers.forEach(t => clearInterval(t));
        this.timers.clear();
    }
}
