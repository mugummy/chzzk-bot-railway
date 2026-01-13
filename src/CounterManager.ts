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
    private onStateChangeCallback: () => void = () => {};
    private triggerCache: Set<string> = new Set();

    constructor(private bot: ChatBot, initialCounters: Counter[]) {
        this.variableProcessor = new VariableProcessor(bot);
        this.counters = initialCounters || [];
        this.rebuildTriggerCache();
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    private rebuildTriggerCache(): void {
        this.triggerCache.clear();
        for (const counter of this.counters) {
            if (counter.enabled) this.triggerCache.add(counter.trigger);
        }
    }

    public hasCounter(message: string): boolean {
        return this.triggerCache.has(message?.trim() || '');
    }

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
        this.notifyStateChange();
        return true;
    }

    public updateCounter(oldTrigger: string, newTrigger: string, newResponse: string, newEnabled: boolean): boolean {
        const counter = this.counters.find(c => c.trigger === oldTrigger);
        if (counter) {
            counter.trigger = newTrigger;
            counter.response = newResponse;
            counter.enabled = newEnabled;
            this.rebuildTriggerCache();
            this.notifyStateChange();
            return true;
        }
        return false;
    }

    public removeCounter(trigger: string): boolean {
        const initialLength = this.counters.length;
        this.counters = this.counters.filter(c => c.trigger !== trigger);
        if (this.counters.length < initialLength) {
            this.rebuildTriggerCache();
            this.notifyStateChange();
            return true;
        }
        return false;
    }

    public getCounters(): Counter[] { 
        return this.counters.map((c, i) => ({
            ...c,
            id: c.id || `counter_${i}_${c.trigger.replace('!', '')}`
        }));
    }

    public async checkAndRespond(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        if (chat.hidden || !chat.message) return;
        const msg = chat.message.trim();
        for (const counter of this.counters) {
            if (counter.enabled && msg === counter.trigger) {
                counter.state.totalCount = (counter.state.totalCount || 0) + 1;
                const responseText = await this.variableProcessor.process(counter.response, { chat, commandState: counter.state });
                chzzkChat.sendChat(responseText);
                this.notifyStateChange(); // 상태 변경 알림 (동기화)
                break;
            }
        }
    }
}