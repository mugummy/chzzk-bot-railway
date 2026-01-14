import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface VoteOption {
    id: string;
    text: string;
}

export interface VoteSession {
    id: string;
    question: string;
    options: VoteOption[];
    results: { [optionId: string]: number };
    isActive: boolean;
    settings: any;
    startTime: number | null;
    totalVotes: number;
}

export class VoteManager {
    private currentVote: VoteSession | null = null;
    private votedUsers: Set<string> = new Set();
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('voteStateUpdate', this.getState());
        this.bot.saveAll();
    }

    // [수정] 외부에서 상태 주입 가능하도록 (DB 로드용)
    public setCurrentVote(vote: VoteSession) {
        this.currentVote = vote;
        // DB에 저장된 투표가 활성화 상태라면 복구
        if (vote.isActive) {
            // votedUsers는 메모리상에서만 관리하거나 필요시 DB에 별도 저장해야 함
            // 현재 구조상으로는 재시작 시 중복 투표 방지 목록이 초기화됨 (허용 범위)
        }
    }

    public createVote(question: string, options: VoteOption[], settings: any) {
        this.currentVote = {
            id: `vote_${Date.now()}`,
            question,
            options,
            results: options.reduce((acc, opt) => ({ ...acc, [opt.id]: 0 }), {}),
            isActive: false,
            settings,
            startTime: null,
            totalVotes: 0
        };
        this.votedUsers.clear();
        this.notify();
    }

    public startVote() {
        if (this.currentVote) {
            this.currentVote.isActive = true;
            this.currentVote.startTime = Date.now();
            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 시작: ${this.currentVote.question}`);
        }
    }

    public endVote() {
        if (this.currentVote) {
            this.currentVote.isActive = false;
            this.notify();
            // 결과 집계 및 발표 로직
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 종료! 총 ${this.currentVote.totalVotes}표`);
        }
    }

    public resetVote() {
        this.currentVote = null;
        this.votedUsers.clear();
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const msg = chat.message.trim();
        
        // 숫자 투표 (1, 2, 3...)
        const optionIndex = parseInt(msg) - 1;
        if (!isNaN(optionIndex) && this.currentVote.options[optionIndex]) {
            this.castVote(chat.profile.userIdHash, this.currentVote.options[optionIndex].id);
        }
    }

    public async handleDonation(donation: DonationEvent) {
        // 후원 투표 로직 (가중치 등) 필요 시 구현
    }

    private castVote(userId: string, optionId: string) {
        if (!this.currentVote || this.votedUsers.has(userId)) return;
        this.currentVote.results[optionId]++;
        this.currentVote.totalVotes++;
        this.votedUsers.add(userId);
        this.notify();
    }

    public getState() {
        return { currentVote: this.currentVote };
    }
}