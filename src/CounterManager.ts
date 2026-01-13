import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { BotInstance } from './BotInstance';
import { DataManager } from './DataManager';

export interface Counter { 
    id?: string;
    trigger: string; 
    response: string; 
    enabled: boolean; 
    oncePerDay: boolean; 
    count: number; // 전체 실행 횟수 (countall)
    userCounts: { [userIdHash: string]: number }; // 유저별 실행 횟수 (count)
    lastUsedDate: { [userIdHash: string]: string }; // 유저별 마지막 실행 날짜
}

/**
 * CounterManager: 카운터의 실행 및 통계 저장을 담당합니다.
 */
export class CounterManager {
    private counters: Counter[] = [];
    private variableProcessor: VariableProcessor;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialCounters: any[]) {
        this.variableProcessor = new VariableProcessor(bot as any);
        this.counters = (initialCounters || []).map(c => ({
            ...c,
            count: c.count || 0,
            userCounts: c.userCounts || {},
            lastUsedDate: c.lastUsedDate || {}
        }));
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        // 상태 변경 시 즉시 저장 (비동기)
        this.bot.saveAll();
    }

    public getCounters() { return this.counters; }

    public hasCounter(message: string): boolean {
        const msg = message?.trim();
        return this.counters.some(c => c.enabled && c.trigger === msg);
    }

    public addCounter(trigger: string, response: string, oncePerDay: boolean = false): boolean {
        if (this.counters.some(c => c.trigger === trigger)) return false;
        
        this.counters.push({
            id: `cnt_${Date.now()}`,
            trigger,
            response,
            enabled: true,
            oncePerDay,
            count: 0,
            userCounts: {},
            lastUsedDate: {}
        });
        this.notify();
        return true;
    }

    public removeCounter(trigger: string) {
        this.counters = this.counters.filter(c => c.trigger !== trigger);
        this.notify();
    }

    /**
     * 카운터 로직 실행
     */
    public async checkAndRespond(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        const msg = chat.message.trim();
        const today = new Date().toISOString().split('T')[0];
        const userId = chat.profile.userIdHash;

        const counter = this.counters.find(c => c.enabled && c.trigger === msg);
        if (!counter) return;

        // 하루 1회 제한 체크
        if (counter.oncePerDay) {
            if (counter.lastUsedDate[userId] === today) return;
        }

        // 카운트 증가
        counter.count++; // 전체 카운트 증가
        counter.userCounts[userId] = (counter.userCounts[userId] || 0) + 1; // 개인 카운트 증가
        counter.lastUsedDate[userId] = today;

        // 변수 처리 및 전송 (현재 카운터의 상태를 전달)
        try {
            const responseText = await this.variableProcessor.process(counter.response, { 
                chat, 
                counterState: counter // [핵심] 현재 카운터 정보 전달
            });
            await chzzkChat.sendChat(responseText);
            this.notify(); // 변경된 카운트 저장
        } catch (err) {
            console.error(`[CounterManager] Error:`, err);
        }
    }
}
