import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawSession {
    keyword: string;
    participants: { userIdHash: string; nickname: string }[];
    isCollecting: boolean;
    settings: {
        winnerCount: number;
        subscriberOnly: boolean;
        excludePreviousWinners: boolean;
    };
}

/**
 * DrawManager: 키워드 기반 추첨 시스템을 관리합니다.
 */
export class DrawManager {
    private currentSession: DrawSession | null = null;
    private previousWinners: Set<string> = new Set();
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance, initialWinners: string[] = []) {
        this.previousWinners = new Set(initialWinners);
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() { this.onStateChangeCallback(); }

    public getState() { return { currentSession: this.currentSession }; }

    public startSession(keyword: string, settings: any) {
        this.currentSession = {
            keyword,
            participants: [],
            isCollecting: true,
            settings: {
                winnerCount: settings.winnerCount || 1,
                subscriberOnly: settings.subscriberOnly || false,
                excludePreviousWinners: settings.excludePreviousWinners || false
            }
        };
        this.notify();
    }

    public stopCollecting() {
        if (this.currentSession) {
            this.currentSession.isCollecting = false;
            this.notify();
        }
    }

    public handleChat(chat: ChatEvent) {
        if (!this.currentSession || !this.currentSession.isCollecting) return;
        if (chat.message.trim() !== this.currentSession.keyword) return;

        const userId = chat.profile.userIdHash;

        // 필터 1: 구독자 전용
        if (this.currentSession.settings.subscriberOnly && !chat.profile.badge?.imageUrl?.includes('subscribe')) return;

        // 필터 2: 이전 당첨자 제외
        if (this.currentSession.settings.excludePreviousWinners && this.previousWinners.has(userId)) return;

        // 중복 참여 방지
        if (this.currentSession.participants.some(p => p.userIdHash === userId)) return;

        this.currentSession.participants.push({ userIdHash: userId, nickname: chat.profile.nickname });
        this.notify();
    }

    public draw(count?: number) {
        if (!this.currentSession) return { success: false, winners: [] };
        
        const winnerCount = count || this.currentSession.settings.winnerCount;
        const available = [...this.currentSession.participants];
        const winners: any[] = [];

        for (let i = 0; i < winnerCount && available.length > 0; i++) {
            const index = Math.floor(Math.random() * available.length);
            const winner = available.splice(index, 1)[0];
            winners.push(winner);
            this.previousWinners.add(winner.userIdHash);
        }

        return { success: true, winners };
    }

    public reset() {
        this.currentSession = null;
        this.notify();
    }

    public clearPreviousWinners() {
        this.previousWinners.clear();
        this.notify();
    }
}