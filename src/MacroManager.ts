import { ChzzkChat } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface Macro {
    id: string;
    title: string; // [추가] 매크로 이름
    message: string;
    interval: number; // minutes
    enabled: boolean;
}

export class MacroManager {
    private macros: Macro[] = [];
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private chatClient: ChzzkChat | null = null;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialMacros: any[]) {
        this.macros = (initialMacros || []).map(m => ({
            ...m,
            title: m.title || '매크로' // 기존 데이터 호환
        }));
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
        this.bot.saveAll();
    }

    public getMacros() { return this.macros; }

    public addMacro(interval: number, message: string, title: string = '새 매크로') {
        const id = `mac_${Date.now()}`;
        const newMacro: Macro = { id, title, message, interval, enabled: true };
        this.macros.push(newMacro);
        this.startMacro(newMacro);
        this.notify();
    }

    public updateMacro(id: string, interval: number, message: string, title: string) {
        this.stopMacro(id);
        const index = this.macros.findIndex(m => m.id === id);
        if (index > -1) {
            this.macros[index] = { ...this.macros[index], interval, message, title };
            this.startMacro(this.macros[index]);
            this.notify();
        }
    }

    public removeMacro(id: string) {
        this.stopMacro(id);
        this.macros = this.macros.filter(m => m.id !== id);
        this.notify();
    }

    private startMacro(macro: Macro) {
        if (!macro.enabled || !this.chatClient) return;
        this.stopMacro(macro.id);

        const timer = setInterval(() => {
            if (this.chatClient?.connected) {
                this.chatClient.sendChat(macro.message);
            }
        }, macro.interval * 60 * 1000);

        this.timers.set(macro.id, timer);
    }

    private stopMacro(id: string) {
        if (this.timers.has(id)) {
            clearInterval(this.timers.get(id)!);
            this.timers.delete(id);
        }
    }

    private restartAllMacros() {
        this.stopAllMacros();
        this.macros.forEach(m => this.startMacro(m));
    }

    public stopAllMacros() {
        this.timers.forEach(t => clearInterval(t));
        this.timers.clear();
    }
}