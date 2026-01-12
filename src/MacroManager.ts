import { ChzzkChat } from 'chzzk';
import { ChatBot } from './Bot';

export interface Macro { id: number; message: string; interval: number; enabled: boolean; timerId?: NodeJS.Timeout; }
export class MacroManager {
    private macros: Macro[] = []; private nextId = 1; private chzzkChat: ChzzkChat | null = null; private bot: ChatBot;
    constructor(bot: ChatBot, initialMacros: Omit<Macro, 'timerId'>[]) {
        this.bot = bot;
        if (initialMacros && initialMacros.length > 0) {
            this.macros = initialMacros.map(m => ({ ...m }));
            this.nextId = Math.max(...this.macros.map(m => m.id), 0) + 1;
        }
    }
    private saveData() { this.bot.saveAllData(); }
    public setChatClient(chzzkChat: ChzzkChat) { this.chzzkChat = chzzkChat; this.restartAllMacros(); }
    public addMacro(message: string, interval: number): Omit<Macro, 'timerId'> { const newMacro: Macro = { id: this.nextId++, message, interval, enabled: true }; this.macros.push(newMacro); this.startMacro(newMacro); this.saveData(); const { timerId, ...rest } = newMacro; return rest; }
    public updateMacro(id: number, newMessage: string, newInterval: number, newEnabled: boolean): boolean {
        const macro = this.macros.find(m => m.id === id);
        if (macro) {
            const oldInterval = macro.interval;
            const oldEnabled = macro.enabled;

            macro.message = newMessage;
            macro.interval = newInterval;
            macro.enabled = newEnabled;

            if (oldEnabled !== newEnabled || oldInterval !== newInterval) {
                this.stopMacro(macro);
                if (newEnabled) {
                    this.startMacro(macro);
                }
            }
            this.saveData();
            return true;
        }
        return false;
    }
    public removeMacro(id: number): boolean {
        const macro = this.macros.find(m => m.id === id);
        if (macro) {
            this.stopMacro(macro);
            this.macros = this.macros.filter(m => m.id !== id);
            this.saveData();
            return true;
        }
        return false;
    }
    public getMacros(): Omit<Macro, 'timerId'>[] {
        return this.macros.map(m => {
            const { timerId, ...rest } = m;
            return rest;
        });
    }

    public stopAllMacros(): void {
        this.macros.forEach(m => this.stopMacro(m));
    }

    private restartAllMacros(): void {
        this.macros.forEach(m => {
            if (m.enabled) {
                this.startMacro(m);
            }
        });
    }

    private startMacro(macro: Macro): void {
        if (!this.chzzkChat || !macro.enabled) return;
        
        this.stopMacro(macro);
        macro.timerId = setInterval(() => {
            try {
                if (this.chzzkChat) {
                    this.chzzkChat.sendChat(macro.message);
                }
            } catch (error) {
                console.error(`매크로 전송 오류 (ID: ${macro.id}):`, error);
            }
        }, macro.interval * 60 * 1000);
    }

    private stopMacro(macro: Macro): void {
        if (macro.timerId) {
            clearInterval(macro.timerId);
            macro.timerId = undefined;
        }
    }
}
