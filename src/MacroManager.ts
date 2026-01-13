import { ChzzkChat } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { ChatBot } from './Bot';

export interface Macro {
    id: string;
    message: string;
    interval: number; // minutes
    enabled: boolean;
    timer?: NodeJS.Timeout;
}

export class MacroManager {
    private macros: Macro[] = [];
    private chatClient: ChzzkChat | null = null;
    private variableProcessor: VariableProcessor;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: ChatBot, initialMacros: any[]) {
        this.variableProcessor = new VariableProcessor(bot);
        if (initialMacros) {
            this.macros = initialMacros.map(m => ({
                id: m.id,
                message: m.message,
                interval: m.interval || m.interval_minutes,
                enabled: m.enabled
            }));
        }
    }

    public setChatClient(client: ChzzkChat) {
        this.chatClient = client;
        this.startAllMacros();
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    public addMacro(interval: number, message: string): void {
        const newMacro: Macro = {
            id: `macro_${Date.now()}`,
            interval,
            message,
            enabled: true
        };
        this.macros.push(newMacro);
        if (newMacro.enabled) this.startMacro(newMacro);
        this.notifyStateChange();
    }

    public removeMacro(id: string): void {
        const index = this.macros.findIndex(m => m.id === id);
        if (index !== -1) {
            if (this.macros[index].timer) clearInterval(this.macros[index].timer);
            this.macros.splice(index, 1);
            this.notifyStateChange();
        }
    }

    public updateMacro(id: string, interval: number, message: string, enabled: boolean): void {
        const macro = this.macros.find(m => m.id === id);
        if (macro) {
            if (macro.timer) clearInterval(macro.timer);
            macro.interval = interval;
            macro.message = message;
            macro.enabled = enabled;
            if (macro.enabled) this.startMacro(macro);
            this.notifyStateChange();
        }
    }

    private startMacro(macro: Macro) {
        if (macro.timer) clearInterval(macro.timer);
        macro.timer = setInterval(async () => {
            if (this.chatClient && this.bot.settings.chatEnabled) {
                const processed = await this.variableProcessor.process(macro.message, {});
                this.chatClient.sendChat(processed);
            }
        }, macro.interval * 60 * 1000);
    }

    public startAllMacros() {
        this.macros.forEach(m => { if (m.enabled) this.startMacro(m); });
    }

    public stopAllMacros() {
        this.macros.forEach(m => { if (m.timer) clearInterval(m.timer); });
    }

    public getMacros() {
        return this.macros.map(m => ({ id: m.id, message: m.message, interval: m.interval, enabled: m.enabled }));
    }
}