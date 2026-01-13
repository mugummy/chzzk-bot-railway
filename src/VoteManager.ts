import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { v4 as uuidv4 } from 'uuid';

export interface VoteOption {
    id: string;
    text: string;
}

export interface VoteSettings {
    mode: 'any' | 'command';
    allowDonation: boolean;
    donationWeight: number;
    subscriberOnly: boolean;
    duration: number;
}

export interface VoteSession {
    id: string;
    question: string;
    options: VoteOption[];
    results: { [optionId: string]: number };
    voters: string[]; // 중복 투표 방지용
    isActive: boolean;
    settings: VoteSettings;
    startTime: number | null;
    totalVotes: number;
}

/**
 * VoteManager: 실시간 투표 및 추첨 로직을 총괄합니다.
 */
export class VoteManager {
    private currentVote: VoteSession | null = null;
    private onStateChangeCallback: () => void = () => {};
    private timer: NodeJS.Timeout | null = null;

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
    }

    public setCurrentVote(vote: any) {
        this.currentVote = vote;
    }

    /**
     * 투표 생성 및 대기 상태 돌입
     */
    public createVote(question: string, options: string[], settings: VoteSettings) {
        this.currentVote = {
            id: uuidv4(),
            question,
            options: options.map((text, i) => ({ id: String(i + 1), text })),
            results: options.reduce((acc, _, i) => ({ ...acc, [String(i + 1)]: 0 }), {}),
            voters: [],
            isActive: false,
            settings: {
                ...settings,
                donationWeight: Math.max(1, settings.donationWeight || 100)
            },
            startTime: null,
            totalVotes: 0
        };
        this.notify();
    }

    /**
     * 투표 시작 (실제 집계 개시)
     */
    public startVote() {
        if (!this.currentVote || this.currentVote.isActive) return;
        
        this.currentVote.isActive = true;
        this.currentVote.startTime = Date.now();
        
        if (this.currentVote.settings.duration > 0) {
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => this.endVote(), this.currentVote.settings.duration * 1000);
        }
        
        this.notify();
    }

    /**
     * 투표 마감
     */
    public endVote() {
        if (!this.currentVote?.isActive) return;
        this.currentVote.isActive = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.notify();
    }

    /**
     * 투표 데이터 초기화
     */
    public resetVote() {
        this.currentVote = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.notify();
    }

    /**
     * 채팅 투표 처리
     */
    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        
        const userId = chat.profile.userIdHash;
        if (this.currentVote.voters.includes(userId)) return; // 중복 투표 방지

        // 설정 체크: 구독자 전용
        if (this.currentVote.settings.subscriberOnly && !chat.profile.badge?.imageUrl?.includes('subscribe')) return;

        const msg = chat.message.trim();
        let choice = "";

        if (this.currentVote.settings.mode === 'any') {
            // 아무 글자 중 숫자가 포함되면 인식
            const match = msg.match(/\d+/);
            if (match) choice = match[0];
        } else {
            // !1, !2 형태만 인식
            const match = msg.match(/^\!(\d+)$/);
            if (match) choice = match[1];
        }

        if (choice && this.currentVote.results[choice] !== undefined) {
            this.currentVote.results[choice]++;
            this.currentVote.totalVotes++;
            this.currentVote.voters.push(userId);
            this.notify();
        }
    }

    /**
     * 도네이션 가중 투표 처리
     */
    public async handleDonation(donation: DonationEvent) {
        if (!this.currentVote?.isActive || !this.currentVote.settings.allowDonation) return;

        const msg = donation.message?.trim() || "";
        const match = msg.match(/\d+/);
        if (match) {
            const choice = match[0];
            if (this.currentVote.results[choice] !== undefined) {
                const weight = Math.floor(donation.payAmount / this.currentVote.settings.donationWeight);
                if (weight > 0) {
                    this.currentVote.results[choice] += weight;
                    this.currentVote.totalVotes += weight;
                    this.notify();
                }
            }
        }
    }

    public getState() {
        return {
            currentVote: this.currentVote
        };
    }
}