// src/DrawManager.ts - 시청자 추첨 시스템

import { ChatEvent, ChzzkChat } from 'chzzk';
import { ChatBot } from './Bot';
import { v4 as uuidv4 } from 'uuid';

export interface Participant {
    userIdHash: string;
    nickname: string;
    isSubscriber: boolean;
    joinedAt: number;
    badge?: string;
}

export interface DrawSession {
    id: string;
    isActive: boolean;
    isCollecting: boolean; // 참여자 모집 중
    startTime: number | null;
    endTime: number | null;
    participants: Participant[];
    winners: Participant[];
    settings: DrawSettings;
    keyword: string;
}

export interface DrawSettings {
    subscriberOnly: boolean;
    excludePreviousWinners: boolean;
    maxParticipants: number;
    winnerCount: number;
}

export class DrawManager {
    private currentSession: DrawSession | null = null;
    private previousWinners: Set<string> = new Set();
    private bot: ChatBot;
    private onStateChangeCallback: () => void = () => {};
    private drawHistory: DrawSession[] = [];

    constructor(bot: ChatBot, initialHistory?: DrawSession[]) {
        this.bot = bot;
        if (initialHistory) {
            this.drawHistory = initialHistory;
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    public getState() {
        return {
            currentSession: this.currentSession,
            previousWinnersCount: this.previousWinners.size,
            drawHistory: this.drawHistory.slice(-20)
        };
    }

    public startSession(keyword: string = '!참여', settings?: Partial<DrawSettings>): { success: boolean; message?: string } {
        if (this.currentSession?.isCollecting) {
            return { success: false, message: '이미 참여자를 모집 중입니다.' };
        }

        const defaultSettings: DrawSettings = {
            subscriberOnly: false,
            excludePreviousWinners: true,
            maxParticipants: 0,
            winnerCount: 1
        };

        this.currentSession = {
            id: uuidv4(),
            isActive: true,
            isCollecting: true,
            startTime: Date.now(),
            endTime: null,
            participants: [],
            winners: [],
            settings: { ...defaultSettings, ...settings },
            keyword: keyword
        };

        this.notifyStateChange();
        return { success: true, message: `참여자 모집이 시작되었습니다! "${keyword}" 를 입력해 참여하세요.` };
    }

    public stopCollecting(): { success: boolean; message?: string; participantCount?: number } {
        if (!this.currentSession?.isCollecting) {
            return { success: false, message: '진행 중인 모집이 없습니다.' };
        }

        this.currentSession.isCollecting = false;
        this.currentSession.endTime = Date.now();
        this.notifyStateChange();
        
        return { 
            success: true, 
            message: `참여가 마감되었습니다! 총 ${this.currentSession.participants.length}명 참여`,
            participantCount: this.currentSession.participants.length
        };
    }

    public addParticipant(userIdHash: string, nickname: string, isSubscriber: boolean, badge?: string): { success: boolean; message?: string; silent?: boolean } {
        if (!this.currentSession?.isCollecting) {
            return { success: false, message: '현재 참여자를 모집하고 있지 않습니다.', silent: true };
        }

        if (this.currentSession.participants.some(p => p.userIdHash === userIdHash)) {
            return { success: false, message: '이미 참여하셨습니다.', silent: true };
        }

        if (this.currentSession.settings.subscriberOnly && !isSubscriber) {
            return { success: false, message: '구독자만 참여할 수 있습니다.', silent: true };
        }

        if (this.currentSession.settings.excludePreviousWinners && this.previousWinners.has(userIdHash)) {
            return { success: false, message: '이전 당첨자는 참여할 수 없습니다.', silent: true };
        }

        if (this.currentSession.settings.maxParticipants > 0 && 
            this.currentSession.participants.length >= this.currentSession.settings.maxParticipants) {
            return { success: false, message: '참여 인원이 마감되었습니다.', silent: true };
        }

        const participant: Participant = {
            userIdHash,
            nickname,
            isSubscriber,
            joinedAt: Date.now(),
            badge
        };

        this.currentSession.participants.push(participant);
        this.notifyStateChange();
        
        return { success: true, message: `${nickname}님이 참여하셨습니다! (${this.currentSession.participants.length}명)` };
    }

    public draw(count?: number): { success: boolean; message?: string; winners?: Participant[] } {
        if (!this.currentSession) {
            return { success: false, message: '추첨 세션이 없습니다.' };
        }

        if (this.currentSession.isCollecting) {
            return { success: false, message: '먼저 참여 모집을 마감해주세요.' };
        }

        if (this.currentSession.participants.length === 0) {
            return { success: false, message: '참여자가 없습니다.' };
        }

        const winnerCount = count || this.currentSession.settings.winnerCount;
        const actualCount = Math.min(winnerCount, this.currentSession.participants.length);

        const shuffled = [...this.currentSession.participants].sort(() => Math.random() - 0.5);
        const winners = shuffled.slice(0, actualCount);

        this.currentSession.winners = winners;
        this.currentSession.isActive = false;

        winners.forEach(w => this.previousWinners.add(w.userIdHash));

        this.drawHistory.push({ ...this.currentSession });
        if (this.drawHistory.length > 50) {
            this.drawHistory = this.drawHistory.slice(-50);
        }

        this.notifyStateChange();

        return {
            success: true,
            winners,
            message: `🎉 당첨자: ${winners.map(w => w.nickname).join(', ')}`
        };
    }

    public reset(): { success: boolean; message?: string } {
        if (this.currentSession) {
            this.currentSession = null;
        }
        this.notifyStateChange();
        return { success: true, message: '추첨이 초기화되었습니다.' };
    }

    public clearPreviousWinners(): { success: boolean; message?: string } {
        this.previousWinners.clear();
        this.notifyStateChange();
        return { success: true, message: '이전 당첨자 목록이 초기화되었습니다.' };
    }

    public removeParticipant(userIdHash: string): { success: boolean; message?: string } {
        if (!this.currentSession) {
            return { success: false, message: '추첨 세션이 없습니다.' };
        }

        const index = this.currentSession.participants.findIndex(p => p.userIdHash === userIdHash);
        if (index === -1) {
            return { success: false, message: '참여자를 찾을 수 없습니다.' };
        }

        const removed = this.currentSession.participants.splice(index, 1)[0];
        this.notifyStateChange();
        return { success: true, message: `${removed.nickname}님이 제거되었습니다.` };
    }

    public updateSettings(settings: Partial<DrawSettings>): { success: boolean; message?: string } {
        if (!this.currentSession) {
            return { success: false, message: '추첨 세션이 없습니다.' };
        }

        this.currentSession.settings = { ...this.currentSession.settings, ...settings };
        this.notifyStateChange();
        return { success: true, message: '설정이 업데이트되었습니다.' };
    }

    public handleChat(chat: ChatEvent): boolean {
        const message = chat.message.trim();
        
        if (this.currentSession?.isCollecting && message === this.currentSession.keyword) {
            const isSubscriber = chat.profile.badge?.imageUrl?.includes('subscribe') || false;
            const result = this.addParticipant(
                chat.profile.userIdHash,
                chat.profile.nickname,
                isSubscriber,
                chat.profile.badge?.imageUrl
            );
            return result.success;
        }

        return false;
    }

    public getDrawHistory(): DrawSession[] {
        return this.drawHistory;
    }
}
