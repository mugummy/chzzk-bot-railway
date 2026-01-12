import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { ChatBot } from './Bot';

export interface Counter { 
    id?: string;
    trigger: string; 
    response: string; 
    enabled: boolean; 
    state: { 
        totalCount?: number; 
        userCounts?: { [userIdHash: string]: number; }; 
    }; 
}
export class CounterManager {
    private counters: Counter[] = [];
    private variableProcessor: VariableProcessor;
    private bot: ChatBot;
    private triggerCache: Set<string> = new Set();

    constructor(bot: ChatBot, initialCounters: Counter[]) {
        this.bot = bot;
        this.variableProcessor = new VariableProcessor(bot);
        this.counters = initialCounters || [];
        this.rebuildTriggerCache();
    }

    private rebuildTriggerCache(): void {
        this.triggerCache.clear();
        for (const counter of this.counters) {
            if (counter.enabled) {
                this.triggerCache.add(counter.trigger);
            }
        }
    }

    public hasCounter(message: string): boolean {
        return this.triggerCache.has(message?.trim() || '');
    }
    private saveData() { this.bot.saveAllData(); }

    public addCounter(trigger: string, response: string): boolean {
        if (this.counters.some(c => c.trigger === trigger)) return false;
        const newCounter: Counter = {
            id: `counter_${Date.now()}_${trigger.replace('!', '')}`,
            trigger,
            response,
            enabled: true,
            state: { totalCount: 0, userCounts: {} }
        };
        this.counters.push(newCounter);
        this.rebuildTriggerCache();
        this.saveData();
        return true;
    }

    public updateCounter(oldTrigger: string, newTrigger: string, newResponse: string, newEnabled: boolean): boolean {
        const counter = this.counters.find(c => c.trigger === oldTrigger);
        if (counter) {
            counter.trigger = newTrigger;
            counter.response = newResponse;
            counter.enabled = newEnabled;
            this.rebuildTriggerCache();
            this.saveData();
            return true;
        }
        return false;
    }

    public removeCounter(trigger: string): boolean {
        const initialLength = this.counters.length;
        this.counters = this.counters.filter(c => c.trigger !== trigger);
        const success = this.counters.length < initialLength;
        if (success) {
            this.rebuildTriggerCache();
            this.saveData();
        }
        return success;
    }
    public getCounters(): Counter[] { 
        return this.counters.map((counter, index) => ({
            ...counter,
            id: counter.id || `counter_${index}_${counter.trigger.replace('!', '')}`
        }));
    }
    public async checkAndRespond(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        if (chat.hidden || !chat.message) return;
        for (const counter of this.counters) {
            if (counter.enabled && chat.message === counter.trigger) {
                counter.state.totalCount = (counter.state.totalCount || 0) + 1; counter.state.userCounts = counter.state.userCounts || {}; counter.state.userCounts[chat.profile.userIdHash] = (counter.state.userCounts[chat.profile.userIdHash] || 0) + 1;
                const responseText = await this.variableProcessor.process(counter.response, { chat, commandState: counter.state }); chzzkChat.sendChat(responseText); this.saveData(); break;
            }
        }
    }
}
