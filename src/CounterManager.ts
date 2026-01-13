import { ChzzkChat, ChatEvent } from 'chzzk';
import { VariableProcessor } from './VariableProcessor';
import { BotInstance } from './BotInstance';

export interface Counter { 
    id?: string;
    trigger: string; 
    response: string; 
    enabled: boolean; 
    oncePerDay: boolean; // 하루 1회 제한 기능
    state: { 
        totalCount: number; 
        lastUsedDate: { [userIdHash: string]: string }; // 사용자별 마지막 사용 날짜 (YYYY-MM-DD)
    }; 
}

/**
 * CounterManager: 명령어 실행 횟수를 기록하고 통계를 관리합니다.
 */
export class CounterManager {
    private counters: Counter[] = [];
    private variableProcessor: VariableProcessor;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialCounters: any[]) {
        this.variableProcessor = new VariableProcessor(bot as any);
        this.counters = (initialCounters || []).map(c => ({
            ...c,
            state: c.state || { totalCount: 0, lastUsedDate: {} }
        }));
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public getCounters() { return this.counters; }

    /**
     * 특정 메시지가 카운터 트리거인지 확인
     */
    public hasCounter(message: string): boolean {
        const msg = message?.trim();
        return this.counters.some(c => c.enabled && c.trigger === msg);
    }

    /**
     * 카운터 추가
     */
    public addCounter(trigger: string, response: string, oncePerDay: boolean = false): boolean {
        if (this.counters.some(c => c.trigger === trigger)) return false;
        
        this.counters.push({
            id: `cnt_${Date.now()}`,
            trigger,
            response,
            enabled: true,
            oncePerDay,
            state: { totalCount: 0, lastUsedDate: {} }
        });
        this.notify();
        return true;
    }

    /**
     * 카운터 제거
     */
    public removeCounter(trigger: string) {
        this.counters = this.counters.filter(c => c.trigger !== trigger);
        this.notify();
    }

    /**
     * 카운터 로직 실행 및 응답
     */
    public async checkAndRespond(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        const msg = chat.message.trim();
        const today = new Date().toISOString().split('T')[0];
        const userId = chat.profile.userIdHash;

        const counter = this.counters.find(c => c.enabled && c.trigger === msg);
        if (!counter) return;

        // 하루 1회 제한 체크
        if (counter.oncePerDay) {
            if (counter.state.lastUsedDate[userId] === today) {
                // 이미 오늘 사용함 (무시 혹은 안내 메시지 선택 가능)
                return;
            }
        }

        // 1. 상태 업데이트
        counter.state.totalCount++;
        counter.state.lastUsedDate[userId] = today;

        // 2. 변수 처리 및 전송
        try {
            const responseText = await this.variableProcessor.process(counter.response, { 
                chat, 
                commandState: counter.state 
            });
            await chzzkChat.sendChat(responseText);
            this.notify();
        } catch (err) {
            console.error(`[CounterManager] Execution error for ${counter.trigger}:`, err);
        }
    }
}